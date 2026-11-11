import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { CLAUDE_BIN } from "../config.js";
import { logEvent } from "../bus.js";
import { q } from "../db.js";

export interface RunAgentOptions {
  featureId: number;
  taskId: number | null;
  /** Метка агента в логе: architect, coder, scene, ui, reviewer… */
  agent: string;
  model: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  allowedTools: string[];
  disallowedTools?: string[];
  /** Если задано — CLI вернёт ответ строго по этой JSON-схеме. */
  jsonSchema?: object;
  /** Продолжить существующую сессию агента. */
  resume?: string | null;
  /** Разрешить правку файлов без подтверждений. */
  canEdit?: boolean;
}

export interface AgentResult {
  sessionId: string | null;
  text: string;
  structured: unknown;
  isError: boolean;
  stopped: boolean;
  rateLimited: boolean;
  errorText?: string;
}

/** Активные процессы по фиче — чтобы кнопка «Стоп» могла их убить. */
const running = new Map<number, Set<ChildProcess>>();
const stoppedFeatures = new Set<number>();

export function stopFeatureAgents(featureId: number) {
  stoppedFeatures.add(featureId);
  for (const child of running.get(featureId) ?? []) killTree(child);
}
export function clearStop(featureId: number) {
  stoppedFeatures.delete(featureId);
}
export function isStopped(featureId: number) {
  return stoppedFeatures.has(featureId);
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
  else child.kill("SIGTERM");
}

const short = (s: string, n = 4000) => (s.length > n ? s.slice(0, n) + `\n… (+${s.length - n} симв.)` : s);

/** Запускает `claude -p` как отдельного агента и транслирует его поток событий в лог. */
export function runAgent(o: RunAgentOptions): Promise<AgentResult> {
  const args = [
    "-p",
    "--model", o.model,
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", o.canEdit ? "acceptEdits" : "default",
    "--allowedTools", ...o.allowedTools,
  ];
  if (o.disallowedTools?.length) args.push("--disallowedTools", ...o.disallowedTools);
  if (o.systemPrompt) args.push("--append-system-prompt", o.systemPrompt);
  if (o.jsonSchema) args.push("--json-schema", JSON.stringify(o.jsonSchema));
  if (o.resume) args.push("--resume", o.resume);

  logEvent(o.featureId, o.taskId, o.agent, "start", {
    model: o.model,
    resume: !!o.resume,
    prompt: short(o.prompt, 6000),
  });

  return new Promise((resolve) => {
    const child = spawn(CLAUDE_BIN, args, {
      cwd: o.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const set = running.get(o.featureId) ?? new Set();
    set.add(child);
    running.set(o.featureId, set);

    const result: AgentResult = {
      sessionId: o.resume ?? null,
      text: "",
      structured: undefined,
      isError: false,
      stopped: false,
      rateLimited: false,
    };
    let stderr = "";
    let gotResult = false;

    child.stdin.end(o.prompt);
    child.stderr.on("data", (d) => (stderr += d.toString()));

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.session_id) result.sessionId = ev.session_id;

      switch (ev.type) {
        case "assistant": {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "text" && block.text?.trim()) {
              logEvent(o.featureId, o.taskId, o.agent, "text", { text: block.text });
            } else if (block.type === "thinking" && block.thinking?.trim()) {
              logEvent(o.featureId, o.taskId, o.agent, "thinking", { text: short(block.thinking) });
            } else if (block.type === "tool_use" && block.name !== "StructuredOutput") {
              logEvent(o.featureId, o.taskId, o.agent, "tool", { name: block.name, input: summarizeInput(block.input) });
            }
          }
          break;
        }
        case "user": {
          for (const block of ev.message?.content ?? []) {
            if (block.type === "tool_result" && typeof block.content !== "undefined") {
              const content =
                typeof block.content === "string"
                  ? block.content
                  : (block.content as any[]).map((c) => c.text ?? "").join("\n");
              if (content === "Structured output provided successfully") continue;
              logEvent(o.featureId, o.taskId, o.agent, "tool_result", {
                text: short(content, 1500),
                isError: !!block.is_error,
              });
            }
          }
          break;
        }
        case "rate_limit_event": {
          const status = ev.rate_limit_info?.status;
          if (status && status !== "allowed" && status !== "allowed_warning") {
            result.rateLimited = true;
            logEvent(o.featureId, o.taskId, o.agent, "rate_limit", ev.rate_limit_info);
          }
          break;
        }
        case "result": {
          gotResult = true;
          result.text = typeof ev.result === "string" ? ev.result : JSON.stringify(ev.result ?? "");
          result.structured = ev.structured_output;
          result.isError = !!ev.is_error;
          const u = ev.usage ?? {};
          const tin = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          q.addTokens(o.featureId, tin, u.output_tokens ?? 0);
          logEvent(o.featureId, o.taskId, o.agent, "result", {
            isError: result.isError,
            subtype: ev.subtype,
            turns: ev.num_turns,
            durationMs: ev.duration_ms,
            tokensIn: tin,
            tokensOut: u.output_tokens ?? 0,
          });
          break;
        }
      }
    });

    child.on("error", (err) => {
      result.isError = true;
      result.errorText = `Не удалось запустить ${CLAUDE_BIN}: ${err.message}`;
    });

    child.on("close", (code) => {
      set.delete(child);
      if (isStopped(o.featureId)) {
        result.stopped = true;
        logEvent(o.featureId, o.taskId, o.agent, "stopped", {});
      } else if (!gotResult) {
        result.isError = true;
        result.errorText ??= `claude завершился с кодом ${code}. ${short(stderr.trim(), 2000)}`;
        if (/rate.?limit|usage limit|limit reached/i.test(stderr)) result.rateLimited = true;
        logEvent(o.featureId, o.taskId, o.agent, "error", { text: result.errorText });
      }
      resolve(result);
    });
  });
}

function summarizeInput(input: any): string {
  if (!input || typeof input !== "object") return String(input ?? "");
  if (input.command) return String(input.command);
  if (input.file_path) {
    const extra = input.old_string !== undefined ? " (правка)" : input.content !== undefined ? " (запись)" : "";
    return String(input.file_path) + extra;
  }
  if (input.pattern) return `${input.pattern}${input.path ? "  в " + input.path : ""}`;
  return short(JSON.stringify(input), 300);
}
