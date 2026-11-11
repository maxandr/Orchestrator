import { q, type Feature, type Task } from "./db.js";
import { featureChanged, logEvent } from "./bus.js";
import { MAX_ATTEMPTS } from "./config.js";
import * as git from "./git.js";
import { checkCompile, runEditModeTests, type CheckResult } from "./unity.js";
import { API_BLOCKED_MSG, clearStop, isStopped, stopFeatureAgents } from "./agents/runAgent.js";
import { PlanSchema, runArchitect, runExecutor, runReviewer, runSummarizer, type Plan } from "./agents/roles.js";

export class UserError extends Error {
  constructor(message: string, public code = "bad_request") {
    super(message);
  }
}

/** Активные фичи (чтобы не запустить один цикл дважды). */
const active = new Set<number>();

function setFeature(id: number, fields: Parameters<typeof q.updateFeature>[1]) {
  q.updateFeature(id, fields);
  featureChanged(id);
}
function setTask(task: Task, fields: Parameters<typeof q.updateTask>[1]) {
  q.updateTask(task.id, fields);
  Object.assign(task, fields);
  featureChanged(task.feature_id);
}

function getCtx(featureId: number) {
  const feature = q.feature(featureId);
  if (!feature) throw new UserError("Фича не найдена", "not_found");
  const project = q.project(feature.project_id)!;
  return { feature, project };
}

function getPlan(feature: Feature): Plan {
  if (!feature.plan) throw new UserError("У фичи нет плана");
  return PlanSchema.parse(JSON.parse(feature.plan));
}

/** В одном проекте одновременно работает только одна фича: git и Unity общие. */
function assertProjectFree(projectId: number, featureId: number) {
  for (const id of active) {
    if (id === featureId) throw new UserError("Эта фича уже выполняется", "busy");
    if (q.feature(id)?.project_id === projectId)
      throw new UserError("В этом проекте уже работает другая фича. Дождитесь её или остановите.", "busy");
  }
}

function launch(featureId: number, job: () => Promise<void>) {
  active.add(featureId);
  clearStop(featureId);
  job()
    .catch((err) => {
      console.error(err);
      logEvent(featureId, null, "system", "error", { text: String(err?.message ?? err) });
      setFeature(featureId, { status: "failed", error: String(err?.message ?? err) });
    })
    .finally(() => {
      active.delete(featureId);
      featureChanged(featureId);
    });
}

/* ───────────── Публичные действия ───────────── */

export function createFeature(projectId: number, title: string, description: string) {
  const project = q.project(projectId);
  if (!project) throw new UserError("Проект не найден", "not_found");
  const id = q.addFeature(projectId, title, description);
  plan(id);
  return id;
}

/** Выполненные и пропущенные задачи: при доработке они остаются, новые задачи идут после них. */
const finishedTasks = (featureId: number) => q.tasks(featureId).filter((t) => t.status === "done" || t.status === "skipped");

/** Запустить (или перезапустить с пожеланиями) планирование. */
export function plan(featureId: number, feedback?: string) {
  startPlanning(featureId, { feedback });
}

/** Доработать завершённую фичу: архитектор добавляет новые задачи к выполненным, план снова ждёт утверждения. */
export function refine(featureId: number, request: string) {
  const { feature } = getCtx(featureId);
  if (feature.status !== "done") throw new UserError("Доработать можно только завершённую фичу");
  startPlanning(featureId, { refine: request });
}

function startPlanning(featureId: number, opts: { feedback?: string; refine?: string }) {
  const { feature, project } = getCtx(featureId);
  assertProjectFree(project.id, featureId);
  const finished = finishedTasks(featureId);
  // Доработка (или правка её плана): если её прервать, фича возвращается в «готово» — выполненное не теряется
  const refining = finished.length > 0;
  const interrupted = (error: string) =>
    setFeature(featureId, refining ? { status: "done", error: `Доработка не состоялась: ${error}` } : { status: "failed", error });

  if (opts.feedback) q.replacePendingTasks(featureId, []);
  setFeature(featureId, { status: "planning", error: null, plan_feedback: opts.feedback ?? null });
  logEvent(featureId, null, "system", "info", {
    text: opts.refine
      ? `Архитектор дорабатывает фичу: ${opts.refine}`
      : opts.feedback
        ? "Архитектор переделывает план"
        : "Архитектор изучает проект",
  });

  launch(featureId, async () => {
    const { res, plan } = await runArchitect(project, feature, { ...opts, finished });
    if (res.stopped) return refining ? interrupted("остановлено пользователем.") : setFeature(featureId, { status: "stopped" });
    if (res.sessionId) q.updateFeature(featureId, { architect_session: res.sessionId });
    if (!plan) {
      const why = res.apiBlocked ? (res.errorText ?? API_BLOCKED_MSG) : res.rateLimited ? "Лимит подписки исчерпан — попробуйте позже." : res.errorText ?? "Архитектор не вернул корректный план.";
      return interrupted(why);
    }
    q.replacePendingTasks(featureId, plan.tasks);
    if (opts.refine) {
      const history = feature.description ? feature.description + "\n\n" : "";
      q.updateFeature(featureId, { description: `${history}Доработка: ${opts.refine}` });
    }
    setFeature(featureId, { status: "awaiting_approval", plan: JSON.stringify(plan) });
  });
}

/** Удалить фичу из оркестратора. Изменения в рабочей копии проекта остаются, удаляются только снимки. */
export async function deleteFeature(featureId: number) {
  const { project } = getCtx(featureId);
  if (active.has(featureId)) throw new UserError("Сначала остановите фичу", "busy");
  const shas = q.tasks(featureId).flatMap((t) => [t.base_sha, t.commit_sha]).filter((s): s is string => !!s);
  q.deleteFeature(featureId);
  featureChanged(featureId);
  if (shas.length && (await git.isRepo(project.path))) await git.dropSnapshots(project.path, shas).catch(() => {});
}

/** Проект нельзя убрать, пока в нём работает фича. */
export function assertProjectIdle(projectId: number) {
  for (const id of active)
    if (q.feature(id)?.project_id === projectId) throw new UserError("В проекте работает фича — сначала остановите её", "busy");
}

/** Пользователь отредактировал задачи плана вручную. */
export function editPlan(featureId: number, planInput: unknown) {
  const { feature } = getCtx(featureId);
  if (feature.status !== "awaiting_approval") throw new UserError("План можно править только до утверждения");
  const plan = PlanSchema.parse(planInput);
  q.replacePendingTasks(featureId, plan.tasks);
  setFeature(featureId, { plan: JSON.stringify(plan) });
}

/** Утвердить план и начать выполнение. */
export async function approve(featureId: number) {
  const { feature, project } = getCtx(featureId);
  if (feature.status !== "awaiting_approval") throw new UserError("План не ждёт утверждения");
  assertProjectFree(project.id, featureId);
  await ensureRepo(project.path);
  logEvent(featureId, null, "system", "info", { text: "План утверждён — начинаем задачи" });
  setFeature(featureId, { status: "running", error: null });
  launch(featureId, () => runTasks(featureId));
}

/** Продолжить остановленную/прерванную фичу. */
export async function resume(featureId: number) {
  const { feature, project } = getCtx(featureId);
  if (!["stopped", "failed", "awaiting_user"].includes(feature.status)) throw new UserError("Фичу нельзя продолжить в этом состоянии");
  if (!feature.plan) return plan(featureId, feature.plan_feedback ?? undefined);
  if (!q.tasks(featureId).some((t) => t.status !== "pending")) {
    // план есть, но выполнение ещё не начиналось → вернуть на утверждение
    return setFeature(featureId, { status: "awaiting_approval", error: null });
  }
  if (q.tasks(featureId).some((t) => t.status === "needs_user"))
    throw new UserError("Сначала решите, что делать с задачей, ожидающей вас");
  assertProjectFree(project.id, featureId);
  await ensureRepo(project.path);
  setFeature(featureId, { status: "running", error: null });
  launch(featureId, () => runTasks(featureId));
}

export function stop(featureId: number) {
  getCtx(featureId);
  stopFeatureAgents(featureId);
  logEvent(featureId, null, "system", "info", { text: "Остановлено пользователем" });
  if (!active.has(featureId)) setFeature(featureId, { status: "stopped" });
}

/** Решение пользователя по застрявшей задаче. */
export async function taskAction(taskId: number, action: "retry" | "accept" | "skip" | "revert", comment?: string) {
  const task = q.task(taskId);
  if (!task) throw new UserError("Задача не найдена", "not_found");
  const { feature, project } = getCtx(task.feature_id);
  if (active.has(feature.id)) throw new UserError("Сначала остановите фичу");

  if (action === "revert") {
    if (task.status !== "done" || !task.commit_sha || !task.base_sha)
      throw new UserError("Откатить можно только выполненную задачу со снимком");
    const { conflicts } = await git.revertTask(project.path, task.base_sha, task.commit_sha);
    if (conflicts.length)
      throw new UserError(
        `Файлы задачи менялись после её принятия — автоматический откат невозможен: ${conflicts.slice(0, 10).join(", ")}${conflicts.length > 10 ? "…" : ""}`,
      );
    setTask(task, { status: "pending", commit_sha: null, base_sha: null, attempts: 0, executor_session: null, notes: "откатена пользователем" });
    logEvent(feature.id, task.id, "system", "info", { text: `Задача «${task.title}» откатена в рабочей копии (без коммитов)` });
    if (feature.status === "done") setFeature(feature.id, { status: "stopped" });
    return;
  }

  if (task.status !== "needs_user") throw new UserError("Задача не ждёт решения");
  if (action === "accept") {
    setTask(task, { status: "done", commit_sha: await git.snapshot(project.path), notes: "принята пользователем" });
  } else if (action === "skip") {
    if (task.base_sha) await git.discardSince(project.path, task.base_sha);
    setTask(task, { status: "skipped", notes: "пропущена пользователем, изменения отменены" });
  } else {
    const prev = task.notes ? `\n\nПоследние замечания проверки:\n${task.notes}` : "";
    setTask(task, { status: "pending", attempts: 0, notes: `USER:${comment || "попробуй ещё раз"}${prev}` });
  }
  logEvent(feature.id, task.id, "system", "info", { text: `Решение по задаче: ${action}${comment ? ` — ${comment}` : ""}` });
  setFeature(feature.id, { status: "running", error: null });
  launch(feature.id, () => runTasks(feature.id));
}

/** После рестарта сервера процессы агентов потеряны — помечаем такие фичи остановленными. */
export function recoverAfterRestart(features: Feature[]) {
  for (const f of features) {
    const pending = q.tasks(f.id).some((t) => t.status !== "done" && t.status !== "skipped");
    if (f.status === "planning" && finishedTasks(f.id).length > 0 && !pending) {
      // прерванное планирование доработки: выполненная фича остаётся выполненной
      q.updateFeature(f.id, { status: "done", error: "Сервер был перезапущен во время доработки — нажмите «Доработать» ещё раз" });
    } else if (["planning", "running", "summarizing"].includes(f.status)) {
      q.updateFeature(f.id, { status: "stopped", error: "Сервер был перезапущен — нажмите «Продолжить»" });
    }
  }
}

/* ───────────── Внутренний цикл ───────────── */

/**
 * git нужен только для снимков (diff/откат задач). Оркестратор ничего не коммитит и не пушит,
 * поэтому незакоммиченные изменения пользователя не мешают: они просто входят в базовый снимок задачи.
 */
async function ensureRepo(path: string) {
  if (!(await git.isRepo(path))) throw new UserError("Папка проекта не является git-репозиторием. Выполните git init.", "no_git");
}

async function runTasks(featureId: number) {
  const { feature, project } = getCtx(featureId);
  const plan = getPlan(feature);
  const tasks = q.tasks(featureId);

  for (const task of tasks) {
    if (task.status === "done" || task.status === "skipped") continue;
    if (isStopped(featureId)) return setFeature(featureId, { status: "stopped" });

    const outcome = await runTask(featureId, plan, task, tasks.length);
    if (outcome === "stopped") return setFeature(featureId, { status: "stopped" });
    if (outcome === "api_blocked") return setFeature(featureId, { status: "stopped", error: API_BLOCKED_MSG });
    if (outcome === "rate_limited")
      return setFeature(featureId, { status: "stopped", error: "Лимит подписки исчерпан. Нажмите «Продолжить», когда лимит обновится." });
    if (outcome === "needs_user")
      return setFeature(featureId, { status: "awaiting_user", error: `Задача «${task.title}» не прошла проверку за ${MAX_ATTEMPTS} попытки — нужно ваше решение.` });
  }

  // Итог фичи
  setFeature(featureId, { status: "summarizing" });
  const fresh = q.feature(featureId)!;
  const { res, out } = await runSummarizer(q.project(project.id)!, fresh, plan, q.tasks(featureId));
  if (res.stopped) return setFeature(featureId, { status: "stopped" });
  if (res.apiBlocked) return setFeature(featureId, { status: "stopped", error: API_BLOCKED_MSG });
  if (out) {
    q.setProjectMap(project.id, out.projectMap);
    setFeature(featureId, { status: "done", summary: out.summary, error: null });
  } else {
    setFeature(featureId, { status: "done", summary: "Задачи выполнены, но итог не сформирован.", error: res.errorText ?? null });
  }
}

type Outcome = "done" | "needs_user" | "stopped" | "rate_limited" | "api_blocked";

async function runTask(featureId: number, plan: Plan, task: Task, total: number): Promise<Outcome> {
  const { project } = getCtx(featureId);
  const cwd = project.path;
  if (!task.base_sha) setTask(task, { base_sha: await git.snapshot(cwd) });

  // Комментарий пользователя при «Повторить» — как первая обратная связь
  let feedback: string | undefined = task.notes?.startsWith("USER:") ? `Комментарий пользователя: ${task.notes.slice(5)}` : undefined;

  while (task.attempts < MAX_ATTEMPTS) {
    setTask(task, { status: "running", attempts: task.attempts + 1 });
    logEvent(featureId, task.id, "system", "info", { text: `Задача «${task.title}», попытка ${task.attempts}/${MAX_ATTEMPTS}` });

    // 1. Исполнитель (Sonnet)
    const feature = q.feature(featureId)!;
    const exec = await runExecutor(q.project(project.id)!, feature, plan, task, total, feedback);
    if (exec.stopped) return "stopped";
    if (exec.sessionId) setTask(task, { executor_session: exec.sessionId });
    if (exec.apiBlocked) {
      setTask(task, { status: "pending", attempts: task.attempts - 1 });
      return "api_blocked";
    }
    if (exec.rateLimited) {
      setTask(task, { status: "pending", attempts: task.attempts - 1 });
      return "rate_limited";
    }
    if (exec.isError) {
      feedback = `Предыдущий запуск завершился ошибкой: ${exec.errorText ?? exec.text}`;
      continue;
    }

    // 2. QA: компиляция + тесты
    setTask(task, { status: "qa" });
    const qa = await runQa(featureId, task, cwd);
    if (isStopped(featureId)) return "stopped";
    if (qa.failed) {
      feedback = `QA: проверка не пройдена.\n${qa.text}`;
      continue;
    }

    // 3. Ревью (Opus)
    setTask(task, { status: "review" });
    const diff = await git.diffSince(cwd, task.base_sha!);
    if (!diff.stat) {
      feedback = "Ревьюер: в проекте нет никаких изменений — задача не выполнена.";
      logEvent(featureId, task.id, "reviewer", "verdict", { verdict: "rework", feedback });
      continue;
    }
    const { res, review } = await runReviewer(q.project(project.id)!, feature, task, exec.text, qa.text, diff);
    if (res.stopped) return "stopped";
    if (res.apiBlocked) {
      setTask(task, { status: "pending", attempts: task.attempts - 1 });
      return "api_blocked";
    }
    if (res.rateLimited) {
      setTask(task, { status: "pending", attempts: task.attempts - 1 });
      return "rate_limited";
    }
    if (!review) {
      feedback = undefined;
      logEvent(featureId, task.id, "reviewer", "error", { text: "Ревьюер не вернул вердикт — повторяем" });
      continue;
    }
    logEvent(featureId, task.id, "reviewer", "verdict", review);

    if (review.verdict === "accept") {
      // Без коммита: фиксируем состояние снимком, чтобы задачу можно было откатить
      setTask(task, { status: "done", commit_sha: await git.snapshot(cwd), notes: review.feedback });
      return "done";
    }
    feedback = `Ревьюер (архитектор) вернул на доработку:\n${review.feedback}`;
  }

  setTask(task, { status: "needs_user", notes: feedback ?? "Не удалось выполнить задачу" });
  return "needs_user";
}

async function runQa(featureId: number, task: Task, cwd: string) {
  logEvent(featureId, task.id, "qa", "start", { model: "unity", prompt: "Проверка компиляции и тестов" });
  const compile = await checkCompile(cwd);
  logEvent(featureId, task.id, "qa", "check", { name: "Компиляция", ...compile });
  let tests: CheckResult | null = null;
  if (compile.status !== "failed") {
    tests = await runEditModeTests(cwd);
    logEvent(featureId, task.id, "qa", "check", { name: "EditMode-тесты", ...tests });
  }
  const describe = (name: string, r: CheckResult) =>
    `${name}: ${r.status === "passed" ? "OK" : r.status === "skipped" ? "пропущено — " + r.details : "ОШИБКИ"}` +
    (r.errors.length ? "\n" + r.errors.map((e) => "  - " + e).join("\n") : "");
  const text = [describe("Компиляция", compile), tests ? describe("Тесты", tests) : ""].filter(Boolean).join("\n");
  return { failed: compile.status === "failed" || tests?.status === "failed", text };
}
