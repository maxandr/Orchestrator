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

/** Удалить ссылки refs/orchestrator/<sha> на снимки (при удалении фичи). Рабочую копию не трогает. */
export async function dropSnapshots(cwd: string, shas: string[]) {
  for (const sha of new Set(shas)) {
    await exec("git", ["update-ref", "-d", `refs/orchestrator/${sha}`], { cwd });
  }
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

/*
 * Коммит и пуш — только по явным кнопкам пользователя на странице проекта (это его коммиты, с его git-идентичностью).
 * Сами по себе оркестратор и агенты не коммитят и не пушат. Снимки refs/orchestrator/* никуда не уходят.
 */

export interface PushStatus {
  /** Текущая ветка; null — detached HEAD или нет коммитов. */
  branch: string | null;
  /** Основная ветка проекта (main, иначе master); null — нет ни той, ни другой. */
  main: string | null;
  /** Remote для пуша (origin, если есть). */
  remote: string | null;
  /** Есть незакоммиченные изменения (с учётом .gitignore). */
  dirty: boolean;
  /** Коммитов основной ветки, которых нет в remote (по последним известным данным, без fetch). */
  ahead: number;
  behind: number;
}

const ok = async (cwd: string, args: string[]) => (await exec("git", args, { cwd })).code === 0;

async function remoteName(cwd: string) {
  const remotes = (await exec("git", ["remote"], { cwd })).stdout.split(/\r?\n/).filter(Boolean);
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
}

async function mainBranch(cwd: string) {
  for (const b of ["main", "master"]) if (await ok(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`])) return b;
  return null;
}

async function isDirty(cwd: string) {
  return (await worktreeTree(cwd)) !== (await git(cwd, ["rev-parse", "HEAD^{tree}"])).trim();
}

export async function pushStatus(cwd: string): Promise<PushStatus> {
  const commits = await hasCommits(cwd);
  const branchR = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  const branch = commits && branchR.code === 0 ? branchR.stdout.trim() : null;
  const main = await mainBranch(cwd);
  const remote = await remoteName(cwd);
  const status: PushStatus = { branch, main, remote, dirty: commits ? await isDirty(cwd) : false, ahead: 0, behind: 0 };
  if (main && remote && (await ok(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${main}`]))) {
    const counts = await exec("git", ["rev-list", "--left-right", "--count", `${remote}/${main}...${main}`], { cwd });
    const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
    if (counts.code === 0) Object.assign(status, { ahead, behind });
  } else if (main) {
    status.ahead = Number((await exec("git", ["rev-list", "--count", main], { cwd })).stdout.trim()) || 0;
  }
  return status;
}

async function pushRef(cwd: string, remote: string, branch: string) {
  // GIT_TERMINAL_PROMPT=0 — не зависать на запросе логина в консоли (сервер её не видит)
  const args = ["push", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`];
  const r = await exec("git", args, { cwd, timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: "0" } });
  if (r.timedOut) throw new Error("git push не завершился за 5 минут");
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stderr.trim() || r.stdout.trim(); // итог пуша git пишет в stderr
}

/** Закоммитить все изменения рабочей копии в main (нужно быть на ней) и запушить main. */
export async function commitPushMain(cwd: string, message: string) {
  const s = await pushStatus(cwd);
  if (!s.main) throw new Error("В репозитории нет ветки main (или master)");
  if (s.branch !== s.main) throw new Error(`Сейчас выбрана ветка «${s.branch ?? "detached HEAD"}» — переключитесь на ${s.main}`);
  if (!s.remote) throw new Error("У репозитория нет remote — добавьте его: git remote add origin <url>");
  let commit: string | null = null;
  if (s.dirty) {
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-m", message]);
    commit = (await git(cwd, ["rev-parse", "--short", "HEAD"])).trim();
  }
  return { commit, branch: s.main, output: await pushRef(cwd, s.remote, s.main) };
}

/**
 * Закоммитить текущую рабочую копию в новую ветку от HEAD и запушить её.
 * HEAD, текущая ветка, индекс и файлы не меняются — изменения остаются незакоммиченными в текущей ветке.
 */
export async function commitPushBranch(cwd: string, message: string, branch: string) {
  const s = await pushStatus(cwd);
  if (!(await hasCommits(cwd))) throw new Error("В репозитории ещё нет коммитов");
  if (!s.remote) throw new Error("У репозитория нет remote — добавьте его: git remote add origin <url>");
  if (await ok(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) throw new Error(`Ветка ${branch} уже есть`);
  let sha = (await git(cwd, ["rev-parse", "HEAD"])).trim();
  let commit: string | null = null;
  if (s.dirty) {
    sha = (await git(cwd, ["commit-tree", await worktreeTree(cwd), "-p", "HEAD", "-m", message])).trim();
    commit = sha.slice(0, 7);
  }
  await git(cwd, ["update-ref", `refs/heads/${branch}`, sha, ""]);
  return { commit, branch, output: await pushRef(cwd, s.remote, branch) };
}
