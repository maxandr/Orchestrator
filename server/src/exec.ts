import { spawn } from "node:child_process";
import { killTree, trackProcess } from "./procs.js";

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  /** Дополнительные переменные окружения. */
  env?: Record<string, string>;
  /** Что передать в stdin. */
  input?: string;
  /** Фича, к которой относится процесс: «Стоп» по ней убивает и его. */
  featureId?: number;
}

export function exec(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", ...opts.env } });
    if (opts.featureId != null) trackProcess(opts.featureId, child);
    if (opts.input != null) child.stdin.end(opts.input);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      stderr += err.message;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
