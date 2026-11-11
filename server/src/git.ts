import { exec } from "./exec.js";

async function git(cwd: string, ...args: string[]) {
  const r = await exec("git", args, { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

export async function isRepo(cwd: string) {
  const r = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd });
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function hasCommits(cwd: string) {
  return (await exec("git", ["rev-parse", "HEAD"], { cwd })).code === 0;
}

export async function head(cwd: string) {
  return (await git(cwd, "rev-parse", "HEAD")).trim();
}

/** Список изменённых/новых файлов в рабочей копии. */
export async function dirtyFiles(cwd: string) {
  const out = await git(cwd, "status", "--porcelain", "--untracked-files=all");
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function commitAll(cwd: string, message: string) {
  await git(cwd, "add", "-A");
  const staged = (await git(cwd, "diff", "--cached", "--name-only")).trim();
  if (!staged) return null;
  await git(cwd, "commit", "-m", message, "--no-verify");
  return head(cwd);
}

/** Diff всех изменений относительно base (включая новые файлы). */
export async function diffSince(cwd: string, base: string, maxChars = 60_000) {
  await git(cwd, "add", "-A");
  const stat = await git(cwd, "diff", "--cached", "--stat", base);
  // Сцены/префабы/meta огромные — в полный diff берём только код и текстовые конфиги
  const full = await git(
    cwd,
    "diff",
    "--cached",
    base,
    "--",
    ".",
    ":(exclude)*.unity",
    ":(exclude)*.prefab",
    ":(exclude)*.meta",
    ":(exclude)*.asset",
    ":(exclude)*.mat",
    ":(exclude)*.anim",
    ":(exclude)*.controller",
  );
  await git(cwd, "reset", "-q");
  const body = full.length > maxChars ? full.slice(0, maxChars) + `\n… diff обрезан (${full.length} симв.)` : full;
  return { stat: stat.trim(), diff: body };
}

/** Откатить незакоммиченные изменения задачи: вернуть файлы к base и удалить файлы, созданные после base. */
export async function discardSince(cwd: string, base: string) {
  await git(cwd, "add", "-A");
  const added = (await git(cwd, "diff", "--cached", "--name-only", "--diff-filter=A", base))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  await git(cwd, "reset", "-q");
  await git(cwd, "checkout", base, "--", ".");
  for (const f of added) await exec("git", ["rm", "-q", "--cached", "--ignore-unmatch", f], { cwd });
  const { rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  for (const f of added) await rm(join(cwd, f), { force: true });
  await git(cwd, "reset", "-q");
}

/** Откатить уже закоммиченную задачу новым revert-коммитом. */
export async function revertCommit(cwd: string, sha: string) {
  await git(cwd, "revert", "--no-edit", sha);
}
