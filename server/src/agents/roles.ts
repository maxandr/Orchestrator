import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ARCHITECT_MODEL, EXECUTOR_MODEL, PROMPTS_DIR } from "../config.js";
import type { Feature, Project, Task } from "../db.js";
import { runAgent, type AgentResult } from "./runAgent.js";

const prompt = (name: string) => readFileSync(join(PROMPTS_DIR, `${name}.md`), "utf8");
const READ_TOOLS = ["Read", "Glob", "Grep"];
const NO_WRITE = ["Edit", "Write", "NotebookEdit", "Bash"];
/** Никто не коммитит и не пушит: исполнителю запрещены git-команды, меняющие историю, индекс или удалённый репозиторий. */
const NO_GIT_WRITE = [
  "commit", "push", "pull", "fetch", "merge", "rebase", "reset", "revert", "cherry-pick",
  "checkout", "switch", "restore", "stash", "tag", "branch", "add", "rm", "mv", "clean",
  "update-ref", "commit-tree", "am", "apply", "-C", "-c",
].map((c) => `Bash(git ${c}:*)`);

export const ROLES = ["coder", "scene", "ui"] as const;
export type Role = (typeof ROLES)[number];

/* ───────────── Архитектор: план фичи ───────────── */

export const PlanSchema = z.object({
  goal: z.string(),
  acceptance: z.array(z.string()),
  affected: z.array(z.string()),
  notes: z.string().default(""),
  tasks: z
    .array(
      z.object({
        title: z.string(),
        role: z.enum(ROLES),
        brief: z.string(),
        verify: z.string(),
      }),
    )
    .min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

const planJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["goal", "acceptance", "affected", "notes", "tasks"],
  properties: {
    goal: { type: "string", description: "Что должно получиться, 1–3 предложения" },
    acceptance: { type: "array", items: { type: "string" }, description: "Критерии готовности фичи" },
    affected: { type: "array", items: { type: "string" }, description: "Затрагиваемые файлы/классы/сцены" },
    notes: { type: "string", description: "Архитектурные решения и риски" },
    tasks: {
      type: "array",
      minItems: 1,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "role", "brief", "verify"],
        properties: {
          title: { type: "string" },
          role: { type: "string", enum: [...ROLES] },
          brief: { type: "string", description: "Подробный бриф для исполнителя, markdown" },
          verify: { type: "string", description: "Как проверить, что задача сделана" },
        },
      },
    },
  },
};

export async function runArchitect(project: Project, feature: Feature, feedback?: string) {
  const isReplan = !!feedback && !!feature.architect_session;
  const text = isReplan
    ? `Пользователь просит изменить план фичи:\n\n${feedback}\n\nВерни полностью обновлённый план.`
    : [
        `# Новая фича: ${feature.title}`,
        feature.description,
        "",
        "## Карта проекта (из прошлых фич)",
        project.map || "_Карты ещё нет — это первая фича. Изучи проект сам._",
        feedback ? `\n## Пожелания пользователя к плану\n${feedback}` : "",
        "",
        "Изучи проект и составь план этой фичи.",
      ].join("\n");

  const res = await runAgent({
    featureId: feature.id,
    taskId: null,
    agent: "architect",
    model: ARCHITECT_MODEL,
    cwd: project.path,
    prompt: text,
    systemPrompt: prompt("architect"),
    allowedTools: READ_TOOLS,
    disallowedTools: NO_WRITE,
    jsonSchema: planJsonSchema,
    resume: isReplan ? feature.architect_session : null,
  });
  return { res, plan: parseStructured(res, PlanSchema) };
}

/* ───────────── Исполнитель ───────────── */

export async function runExecutor(project: Project, feature: Feature, plan: Plan, task: Task, total: number, feedback?: string) {
  const fullBrief = [
    `# Задача ${task.idx + 1}/${total}: ${task.title}`,
    `Фича: **${feature.title}** — ${plan.goal}`,
    "",
    "## Бриф",
    task.brief,
    "",
    "## Как будет проверяться",
    task.verify,
    "",
    "## Карта проекта (справка)",
    project.map || "_нет_",
  ].join("\n");

  const canResume = !!feedback && !!task.executor_session;
  const text = canResume
    ? `Задачу вернули на доработку.\n\n${feedback}\n\nИсправь и коротко опиши, что изменил.`
    : feedback
      ? `${fullBrief}\n\n## Задачу вернули на доработку\n${feedback}`
      : fullBrief;

  return runAgent({
    featureId: feature.id,
    taskId: task.id,
    agent: task.role,
    model: EXECUTOR_MODEL,
    cwd: project.path,
    prompt: text,
    systemPrompt: prompt("executor-common") + "\n\n" + prompt(task.role),
    allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "Skill"],
    disallowedTools: NO_GIT_WRITE,
    canEdit: true,
    resume: canResume ? task.executor_session : null,
  });
}

/* ───────────── Ревьюер ───────────── */

export const ReviewSchema = z.object({
  verdict: z.enum(["accept", "rework"]),
  feedback: z.string(),
});

const reviewJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "feedback"],
  properties: {
    verdict: { type: "string", enum: ["accept", "rework"] },
    feedback: { type: "string", description: "Для rework — конкретные замечания по пунктам; для accept — короткий комментарий" },
  },
};

export async function runReviewer(
  project: Project,
  feature: Feature,
  task: Task,
  executorReport: string,
  qa: string,
  diff: { stat: string; diff: string },
) {
  const text = [
    `# Ревью задачи: ${task.title}`,
    `Фича: ${feature.title}`,
    "",
    "## Бриф",
    task.brief,
    "",
    "## Критерии проверки",
    task.verify,
    "",
    "## Отчёт исполнителя",
    executorReport || "_нет_",
    "",
    "## QA",
    qa,
    "",
    "## Изменённые файлы",
    "```",
    diff.stat || "(нет изменений)",
    "```",
    "",
    "## Diff (без сцен/префабов/meta)",
    "```diff",
    diff.diff || "(пусто)",
    "```",
  ].join("\n");

  const res = await runAgent({
    featureId: feature.id,
    taskId: task.id,
    agent: "reviewer",
    model: ARCHITECT_MODEL,
    cwd: project.path,
    prompt: text,
    systemPrompt: prompt("reviewer"),
    allowedTools: READ_TOOLS,
    disallowedTools: NO_WRITE,
    jsonSchema: reviewJsonSchema,
  });
  return { res, review: parseStructured(res, ReviewSchema) };
}

/* ───────────── Итог фичи + карта проекта ───────────── */

export const SummarySchema = z.object({ summary: z.string(), projectMap: z.string() });

export async function runSummarizer(project: Project, feature: Feature, plan: Plan, tasks: Task[]) {
  const text = [
    `# Фича завершена: ${feature.title}`,
    feature.description,
    "",
    "## План",
    "```json",
    JSON.stringify(plan, null, 2),
    "```",
    "",
    "## Задачи",
    ...tasks.map((t) => `- [${t.status}] ${t.title}${t.notes ? ` — ${t.notes}` : ""}`),
    "",
    "## Текущая карта проекта",
    project.map || "_нет_",
  ].join("\n");

  const res = await runAgent({
    featureId: feature.id,
    taskId: null,
    agent: "architect",
    model: ARCHITECT_MODEL,
    cwd: project.path,
    prompt: text,
    systemPrompt: prompt("summarizer"),
    allowedTools: READ_TOOLS,
    disallowedTools: NO_WRITE,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "projectMap"],
      properties: { summary: { type: "string" }, projectMap: { type: "string" } },
    },
  });
  return { res, out: parseStructured(res, SummarySchema) };
}

function parseStructured<T>(res: AgentResult, schema: z.ZodType<T>): T | null {
  let value = res.structured;
  if (value === undefined && res.text) {
    try {
      value = JSON.parse(res.text);
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
