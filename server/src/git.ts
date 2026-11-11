import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "./exec.js";

/*
 * Оркестратор НИКОГДА не коммитит и не пушит в репозиторий проекта.
 * Состояние рабочей копии фиксируется «снимками»: дерево собирается во временном индексе,
 * оборачивается в commit-объект (commit-tree) и держится ссылкой refs/orchestrator/<sha>,
 * чтобы git gc его не удалил. Ветки, HEAD и настоящий индекс (staging) пользователя не меняются,
 * git push такие ссылки не отправляет.
 */

const IDENT = {
  GIT_AUTHOR_NAME: "orchestrator",
  GIT_AUTHOR_EMAIL: "orchestrator@localhost",
  GIT_COMMITTER_NAME: "orchestrator",
  GIT_COMMITTER_EMAIL: "orchestrator@localhost",
};

async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}) {
  const r = await exec("git", args, { cwd, timeoutMs: 120_000, ...opts });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

const splitZ = (s: string) => s.split("\0").filter(Boolean);

export async function isRepo(cwd: string) {
  const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function hasCommits(cwd: string) {
  return (await exec("git", ["rev-parse", "HEAD"], { cwd })).code === 0;
}

/** Выполнить fn с временной копией индекса (настоящий индекс пользователя не трогаем). */
async function withTempIndex<T>(cwd: string, copyReal: boolean, fn: (env: Record<string, string>) => Promise<T>) {
  const dir = await mkdtemp(join(tmpdir(), "orch-git-"));
  const idx = join(dir, "index");
  try {
    if (copyReal) {
      // копия настоящего индекса — ради кэша stat, чтобы add -A не перечитывал весь проект
      const real = resolve(cwd, (await git(cwd, ["rev-parse", "--git-path", "index"])).trim());
      if (existsSync(real)) await copyFile(real, idx);
    }
    return await fn({ GIT_INDEX_FILE: idx });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Дерево текущей рабочей копии (с учётом .gitignore). */
async function worktreeTree(cwd: string) {
  return withTempIndex(cwd, true, async (env) => {
    await git(cwd, ["add", "-A"], { env });
    return (await git(cwd, ["write-tree"], { env })).trim();
  });
}

/** Снимок рабочей копии. Возвращает sha commit-объекта вне истории веток. */
export async function snapshot(cwd: string) {
  const tree = await worktreeTree(cwd);
  const sha = (await git(cwd, ["commit-tree", tree, "-m", "orchestrator snapshot"], { env: IDENT })).trim();
  await git(cwd, ["update-ref", `refs/orchestrator/${sha}`, sha]);
  return sha;
}

/** Изменённые пути между двумя tree-ish: { path → A|M|D|T }. */
async function changes(cwd: string, from: string, to: string) {
  const parts = splitZ(await git(cwd, ["diff", "--name-status", "--no-renames", "-z", from, to]));
  const map = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) map.set(parts[i + 1], parts[i][0]);
  return map;
}

/** Вернуть пути к состоянию снимка base: изменённые/удалённые — из base, добавленные после base — удалить. */
async function restore(cwd: string, base: string, paths: Map<string, string>) {
  const fromBase = [...paths].filter(([, s]) => s !== "A").map(([p]) => p);
  const added = [...paths].filter(([, s]) => s === "A").map(([p]) => p);
  if (fromBase.length) {
    await withTempIndex(cwd, false, async (env) => {
      await git(cwd, ["read-tree", base], { env });
      await git(cwd, ["checkout-index", "-f", "-z", "--stdin"], { env, input: fromBase.join("\0") });
    });
  }
  for (const f of added) await rm(join(cwd, f), { force: true });
}

/** Diff всех изменений относительно снимка base (включая новые файлы). */
export async function diffSince(cwd: string, base: string, maxChars = 60_000) {
  const cur = await worktreeTree(cwd);
  const stat = await git(cwd, ["diff", "--stat", base, cur]);
  // Сцены/префабы/meta огромные — в полный diff берём только код и текстовые конфиги
  const full = await git(cwd, [
    "diff",
    base,
    cur,
    "--",
    ".",
    ":(exclude)*.unity",
    ":(exclude)*.prefab",
    ":(exclude)*.meta",
    ":(exclude)*.asset",
    ":(exclude)*.mat",
    ":(exclude)*.anim",
    ":(exclude)*.controller",
  ]);
  const body = full.length > maxChars ? full.slice(0, maxChars) + `\n… diff обрезан (${full.length} симв.)` : full;
  return { stat: stat.trim(), diff: body };
}

/** Отменить изменения задачи: вернуть рабочую копию к снимку base. */
export async function discardSince(cwd: string, base: string) {
  await restore(cwd, base, await changes(cwd, base, await worktreeTree(cwd)));
}

/**
 * Откатить принятую задачу (base → after) в рабочей копии, без коммитов.
 * Если её файлы с тех пор менялись — ничего не трогаем и возвращаем список конфликтов.
 */
export async function revertTask(cwd: string, base: string, after: string) {
  const own = await changes(cwd, base, after);
  const since = await changes(cwd, after, await worktreeTree(cwd));
  const conflicts = [...own.keys()].filter((p) => since.has(p));
  if (conflicts.length) return { conflicts };
  await restore(cwd, base, own);
  return { conflicts: [] as string[] };
}
