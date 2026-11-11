import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..", "..");
export const DATA_DIR = process.env.ORCH_DATA_DIR ?? join(ROOT, "data");
export const PROMPTS_DIR = join(ROOT, "server", "prompts");
export const WEB_DIST = join(ROOT, "web", "dist");

export const PORT = Number(process.env.PORT ?? 4321);

/** Команды CLI. Можно переопределить переменными окружения. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
export const UNITY_BIN = process.env.UNITY_BIN ?? "unity";

/** Модели: архитектор/ревьюер и исполнители. */
export const ARCHITECT_MODEL = process.env.ARCHITECT_MODEL ?? "opus";
export const EXECUTOR_MODEL = process.env.EXECUTOR_MODEL ?? "sonnet";

/** Сколько кругов «исполнитель → QA → ревью» до эскалации пользователю. */
export const MAX_ATTEMPTS = 3;
