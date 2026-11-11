import { open, readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "./exec.js";
import { UNITY_BIN } from "./config.js";

export interface CheckResult {
  /** passed — всё ок; failed — ошибки; skipped — проверить нельзя (с причиной). */
  status: "passed" | "failed" | "skipped";
  method: string;
  errors: string[];
  details: string;
}

const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
const tail = (s: string, n = 3000) => (s.length > n ? "…" + s.slice(-n) : s);

export function isUnityProject(path: string) {
  return existsSync(join(path, "Assets")) && existsSync(join(path, "ProjectSettings"));
}

export async function unityVersion(path: string) {
  try {
    const txt = await readFile(join(path, "ProjectSettings", "ProjectVersion.txt"), "utf8");
    return /m_EditorVersion:\s*(\S+)/.exec(txt)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Открыт ли проект в каком-нибудь редакторе (по lock-файлу). */
async function isLocked(path: string) {
  const lock = join(path, "Temp", "UnityLockfile");
  if (!existsSync(lock)) return false;
  try {
    const fh = await open(lock, "r+");
    await fh.close();
    return false;
  } catch {
    return true;
  }
}

/** Редактор с пакетом Pipeline, у которого открыт этот проект. */
async function connectedEditor(path: string) {
  const r = await exec(UNITY_BIN, ["status", "--json", "--no-banner", "--non-interactive"], { timeoutMs: 30_000 });
  try {
    const j = JSON.parse(r.stdout);
    const target = norm(path);
    return (j.data?.instances ?? []).find((inst: any) =>
      JSON.stringify(inst).replace(/\\\\/g, "/").toLowerCase().includes(target),
    );
  } catch {
    return undefined;
  }
}

function extractCompileErrors(text: string) {
  const lines = text.split(/\r?\n/).filter((l) => /error CS\d+|Compilation failed|Scripts have compiler errors/i.test(l));
  return [...new Set(lines.map((l) => l.trim()))].slice(0, 50);
}

/** Проверка компиляции: в открытом редакторе через Pipeline, иначе запуском Unity в batch-режиме. */
export async function checkCompile(path: string): Promise<CheckResult> {
  const editor = await connectedEditor(path);
  if (editor) {
    const r = await exec(
      UNITY_BIN,
      ["recompile", "--project-path", path, "--timeout", "300", "--json", "--no-banner", "--non-interactive"],
      { timeoutMs: 330_000 },
    );
    const out = r.stdout + "\n" + r.stderr;
    let errors = extractCompileErrors(out);
    try {
      const j = JSON.parse(r.stdout);
      const list = j.data?.errors ?? j.data?.messages ?? j.errors ?? [];
      if (Array.isArray(list) && list.length && r.code !== 0)
        errors = list.map((e: any) => (typeof e === "string" ? e : e.message ?? JSON.stringify(e))).slice(0, 50);
    } catch {}
    const ok = r.code === 0;
    return {
      status: ok ? "passed" : "failed",
      method: "unity recompile (открытый редактор)",
      errors: ok ? [] : errors.length ? errors : [tail(out, 1500)],
      details: tail(out),
    };
  }

  if (await isLocked(path)) {
    return {
      status: "skipped",
      method: "—",
      errors: [],
      details:
        "Проект открыт в Unity Editor без пакета Pipeline, поэтому компиляцию проверить нельзя. " +
        "Закройте редактор или установите пакет: unity pipeline install (в папке проекта).",
    };
  }

  const dir = await mkdtemp(join(tmpdir(), "orch-unity-"));
  const logFile = join(dir, "editor.log");
  try {
    const r = await exec(
      UNITY_BIN,
      ["run", path, "--no-tail", "--log-file", logFile, "--timeout", "1500", "--non-interactive", "--no-banner", "--", "-quit", "-nographics"],
      { timeoutMs: 1_600_000 },
    );
    const log = existsSync(logFile) ? await readFile(logFile, "utf8") : r.stdout + r.stderr;
    const errors = extractCompileErrors(log);
    const failed = errors.some((e) => /error CS/i.test(e)) || (r.code !== 0 && errors.length > 0);
    if (r.code !== 0 && !failed) {
      return { status: "failed", method: "unity run (batch)", errors: [tail(r.stderr || r.stdout, 1500)], details: tail(log) };
    }
    return { status: failed ? "failed" : "passed", method: "unity run (batch)", errors: failed ? errors : [], details: tail(log) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Есть ли в проекте сборки тестов (asmdef со ссылкой на TestRunner). */
async function hasTests(path: string): Promise<boolean> {
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 8) return false;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (await walk(p, depth + 1)) return true;
      } else if (e.name.endsWith(".asmdef")) {
        const txt = await readFile(p, "utf8").catch(() => "");
        if (/TestRunner|nunit/i.test(txt)) return true;
      }
    }
    return false;
  }
  return walk(join(path, "Assets"), 0);
}

/** EditMode-тесты. Только при закрытом редакторе (иначе — skipped). */
export async function runEditModeTests(path: string): Promise<CheckResult> {
  if (!(await hasTests(path))) return { status: "skipped", method: "—", errors: [], details: "В проекте нет тестовых сборок." };
  if (await isLocked(path))
    return { status: "skipped", method: "—", errors: [], details: "Редактор открыт — тесты пропущены (запускаются при закрытом редакторе)." };

  const dir = await mkdtemp(join(tmpdir(), "orch-tests-"));
  const out = join(dir, "results.xml");
  try {
    const r = await exec(
      UNITY_BIN,
      ["test", path, "--mode", "EditMode", "--output", out, "--timeout", "1500", "--non-interactive", "--no-banner"],
      { timeoutMs: 1_600_000 },
    );
    const xml = existsSync(out) ? await readFile(out, "utf8") : "";
    const failures = [...xml.matchAll(/<test-case[^>]*name="([^"]+)"[^>]*result="Failed"[\s\S]*?<message><!\[CDATA\[([\s\S]*?)\]\]><\/message>/g)]
      .map((m) => `${m[1]}: ${m[2].trim()}`)
      .slice(0, 30);
    const ok = r.code === 0 && failures.length === 0;
    return {
      status: ok ? "passed" : "failed",
      method: "unity test --mode EditMode",
      errors: ok ? [] : failures.length ? failures : [tail(r.stdout + r.stderr, 1500)],
      details: tail(r.stdout + r.stderr),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
