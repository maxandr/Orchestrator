import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  ApiError,
  api,
  featureStatusColor,
  featureStatusLabel,
  isBusy,
  roleLabel,
  taskStatusLabel,
  useResource,
  type Feature as F,
  type Plan,
  type Project,
  type Task,
} from "../api";
import AgentLog, { useFeatureEvents } from "../components/AgentLog";
import PlanEditor from "../components/PlanEditor";
import { Badge, Button, Card, ErrorBox, Md, Spinner, inputCls } from "../components/ui";
import { GitPanel, type PushStatus } from "../components/GitPanel";

interface Data {
  feature: F;
  tasks: Task[];
  project: Project;
  git: PushStatus | null;
}

const taskColor: Record<string, string> = {
  pending: "bg-zinc-800 text-zinc-400",
  running: "bg-sky-500/15 text-sky-300",
  qa: "bg-amber-500/15 text-amber-300",
  review: "bg-violet-500/15 text-violet-300",
  done: "bg-emerald-500/15 text-emerald-300",
  needs_user: "bg-rose-500/15 text-rose-300",
  skipped: "bg-zinc-800 text-zinc-500 line-through",
};

export default function Feature() {
  const featureId = Number(useParams().id);
  const { data, error, reload } = useResource<Data>(
    `/api/features/${featureId}`,
    (m) => m.type === "feature" && m.featureId === featureId,
  );
  const events = useFeatureEvents(featureId);
  /** undefined — весь лог, null — планирование/итог, число — задача */
  const [filter, setFilter] = useState<number | null | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [replanText, setReplanText] = useState("");
  const [replanOpen, setReplanOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  const [resumeText, setResumeText] = useState("");
  const navigate = useNavigate();

  if (error) return <div className="p-6"><ErrorBox>{error}</ErrorBox></div>;
  if (!data) return <div className="p-6 text-zinc-500">Загрузка…</div>;
  const { feature, tasks, project } = data;
  const busy = isBusy(feature.status);

  async function act(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError((err as Error).message);
    }
    reload();
  }

  const approve = () => act(() => api("POST", `/api/features/${featureId}/approve`, {}));
  const resume = () =>
    act(async () => {
      await api("POST", `/api/features/${featureId}/resume`, { comment: resumeText });
      setResumeText("");
    });
  const stop = () => act(() => api("POST", `/api/features/${featureId}/stop`));
  const replan = () =>
    act(async () => {
      await api("POST", `/api/features/${featureId}/replan`, { feedback: replanText });
      setReplanText("");
      setReplanOpen(false);
    });
  const refine = () =>
    act(async () => {
      await api("POST", `/api/features/${featureId}/refine`, { request: refineText });
      setRefineText("");
    });
  async function remove() {
    if (!window.confirm(`Удалить фичу «${feature.title}» вместе с планом и логом? Изменения в файлах проекта останутся как есть.`)) return;
    setActionError(null);
    try {
      await api("DELETE", `/api/features/${featureId}`);
      navigate(`/projects/${project.id}`);
    } catch (err) {
      setActionError((err as Error).message);
    }
  }
  const savePlan = (plan: Plan) =>
    act(async () => {
      await api("PUT", `/api/features/${featureId}/plan`, { plan });
      setEditing(false);
    });
  const taskAction = (t: Task, action: string, comment?: string) =>
    act(() => api("POST", `/api/tasks/${t.id}/action`, { action, comment }));

  const done = tasks.filter((t) => t.status === "done").length;

  return (
    <div className="flex h-full flex-col">
      {/* Шапка */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <div className="min-w-0 flex-1">
          <Link to={`/projects/${project.id}`} className="text-xs text-zinc-500 hover:text-zinc-300">← {project.name}</Link>
          <div className="flex items-center gap-3">
            <h1 className="truncate text-lg font-semibold">{feature.title}</h1>
            <Badge className={featureStatusColor[feature.status]}>
              {busy && <Spinner />}&nbsp;{featureStatusLabel[feature.status]}
            </Badge>
          </div>
        </div>
        <div className="text-right text-xs text-zinc-500">
          {tasks.length > 0 && <div>задачи {done}/{tasks.length}</div>}
          <div>токены {(feature.tokens_in / 1000).toFixed(0)}k → {(feature.tokens_out / 1000).toFixed(1)}k</div>
        </div>
        {busy && <Button variant="danger" onClick={stop}>■ Стоп</Button>}
        {(feature.status === "stopped" || feature.status === "failed") && (
          <Button variant="primary" onClick={resume}>▶ Продолжить</Button>
        )}
        {!busy && <Button variant="ghost" onClick={remove} title="Удалить фичу из оркестратора">Удалить</Button>}
      </div>

      <div className="space-y-2 px-5 pt-3 empty:hidden">
        {feature.error && <ErrorBox>{feature.error}</ErrorBox>}
        {actionError && <ErrorBox>{actionError}</ErrorBox>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        {/* Левая колонка: план и задачи */}
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          {feature.description && (
            <Card className="p-3 text-sm text-zinc-300">
              <div className="mb-1 text-xs text-zinc-500">Запрос</div>
              <div className="whitespace-pre-wrap">{feature.description}</div>
            </Card>
          )}

          {feature.status === "planning" && (
            <Card className="flex items-center gap-3 p-4 text-sm text-zinc-300">
              <Spinner /> Архитектор (Opus) изучает проект и составляет план…
            </Card>
          )}

          {feature.plan && editing && (
            <PlanEditor plan={feature.plan} onSave={savePlan} onCancel={() => setEditing(false)} />
          )}

          {feature.plan && !editing && (
            <Card className="space-y-3 p-4">
              <div>
                <div className="text-xs text-zinc-500">Цель</div>
                <Md>{feature.plan.goal}</Md>
              </div>
              {feature.plan.acceptance.length > 0 && (
                <div>
                  <div className="text-xs text-zinc-500">Готово, когда</div>
                  <ul className="list-disc pl-5 text-sm text-zinc-300">
                    {feature.plan.acceptance.map((a, i) => <li key={i}>{a}</li>)}
                  </ul>
                </div>
              )}
              {feature.plan.notes && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-xs text-zinc-500">Архитектурные решения</summary>
                  <Md className="mt-1 text-zinc-300">{feature.plan.notes}</Md>
                  {feature.plan.affected.length > 0 && (
                    <div className="mt-2 font-mono text-xs text-zinc-500">{feature.plan.affected.join(" · ")}</div>
                  )}
                </details>
              )}

              {feature.status === "awaiting_approval" && (
                <div className="space-y-2 border-t border-zinc-800 pt-3">
                  <div className="flex flex-wrap gap-2">
                    <Button variant="primary" onClick={approve}>✓ Утвердить и начать</Button>
                    <Button onClick={() => setEditing(true)}>Править вручную</Button>
                    <Button onClick={() => setReplanOpen(!replanOpen)}>Попросить переделать</Button>
                  </div>
                  {replanOpen && (
                    <div className="space-y-2">
                      <textarea
                        className={`${inputCls} min-h-20`}
                        placeholder="Что изменить в плане? Например: «без Input System, используй старый Input», «раздели задачу 2 на две»"
                        value={replanText}
                        onChange={(e) => setReplanText(e.target.value)}
                      />
                      <Button variant="primary" disabled={!replanText.trim()} onClick={replan}>Отправить архитектору</Button>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )}

          {tasks.length > 0 && !editing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Задачи</h2>
                <div className="flex gap-1 text-xs">
                  <FilterBtn active={filter === undefined} onClick={() => setFilter(undefined)}>весь лог</FilterBtn>
                  <FilterBtn active={filter === null} onClick={() => setFilter(null)}>планирование</FilterBtn>
                </div>
              </div>
              {tasks.map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  selected={filter === t.id}
                  onSelect={() => setFilter(filter === t.id ? undefined : t.id)}
                  onAction={(a, c) => taskAction(t, a, c)}
                  canAct={!busy}
                />
              ))}
            </div>
          )}

          {feature.summary && (
            <Card className="border-emerald-900 p-4">
              <div className="mb-1 text-xs text-emerald-400">Итог фичи</div>
              <Md>{feature.summary}</Md>
            </Card>
          )}

          {data.git && done > 0 && <GitPanel featureId={featureId} status={data.git} busy={busy} onDone={reload} />}

          {(feature.status === "stopped" || feature.status === "failed") && feature.plan && tasks.some((t) => t.status === "pending") && (
            <Card className="space-y-2 p-4">
              <div className="text-sm font-medium">Подсказка перед продолжением</div>
              <textarea
                className={`${inputCls} min-h-20`}
                placeholder="Что поправить в текущей задаче? Например: «не трогай PlayerController, сделай через событие»"
                value={resumeText}
                onChange={(e) => setResumeText(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <Button variant="primary" onClick={resume}>▶ Продолжить{resumeText.trim() ? " с подсказкой" : ""}</Button>
                <span className="text-xs text-zinc-500">Подсказка уйдёт исполнителю следующей задачи, попытки начнутся заново. Необязательно.</span>
              </div>
            </Card>
          )}

          {feature.status === "done" && (
            <Card className="space-y-2 p-4">
              <div className="text-sm font-medium">Доработать</div>
              <textarea
                className={`${inputCls} min-h-20`}
                placeholder="Что поправить или добавить? Например: «удали устаревшую строку Planned в ProjectMap.md», «добавь звук при подборе»"
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
              />
              <div className="flex items-center gap-3">
                <Button variant="primary" disabled={!refineText.trim()} onClick={refine}>Отправить архитектору</Button>
                <span className="text-xs text-zinc-500">Архитектор добавит новые задачи к выполненным — план снова придёт на утверждение.</span>
              </div>
            </Card>
          )}
        </div>

        {/* Правая колонка: живой лог */}
        <Card className="flex min-h-[400px] flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
            <span>
              Лог агентов
              {filter !== undefined && (
                <> · {filter === null ? "планирование и итог" : `задача #${(tasks.find((t) => t.id === filter)?.idx ?? 0) + 1}`}</>
              )}
            </span>
            {busy && <span className="flex items-center gap-1 text-sky-300"><Spinner /> live</span>}
          </div>
          <div className="min-h-0 flex-1">
            <AgentLog events={events} filter={filter} />
          </div>
        </Card>
      </div>
    </div>
  );
}

function FilterBtn({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`rounded px-2 py-0.5 ${active ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}>
      {children}
    </button>
  );
}

function TaskCard({
  task,
  selected,
  onSelect,
  onAction,
  canAct,
}: {
  task: Task;
  selected: boolean;
  onSelect: () => void;
  onAction: (action: string, comment?: string) => void;
  canAct: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const active = ["running", "qa", "review"].includes(task.status);

  return (
    <Card className={`p-3 ${selected ? "border-sky-700" : ""} ${task.status === "needs_user" ? "border-rose-800" : ""}`}>
      <div className="flex items-center gap-2">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onSelect} title="Показать лог этой задачи">
          <span className="text-xs text-zinc-500">#{task.idx + 1}</span>
          <span className="truncate text-sm font-medium">{task.title}</span>
        </button>
        <Badge className="bg-zinc-800 text-zinc-400">{roleLabel[task.role]}</Badge>
        <Badge className={taskColor[task.status]}>
          {active && <Spinner />}&nbsp;{taskStatusLabel[task.status]}
          {task.attempts > 1 && ` · ${task.attempts}`}
        </Badge>
        <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(!open)}>{open ? "▾" : "▸"}</button>
      </div>

      {open && (
        <div className="mt-2 space-y-2 border-t border-zinc-800 pt-2">
          <Md className="text-zinc-300">{task.brief}</Md>
          <div className="text-xs text-zinc-500">Проверка: {task.verify}</div>
          {task.commit_sha && <div className="font-mono text-xs text-zinc-500">снимок {task.commit_sha.slice(0, 10)}</div>}
        </div>
      )}

      {task.status === "needs_user" && (
        <div className="mt-2 space-y-2 border-t border-zinc-800 pt-2">
          {task.notes && (
            <details open>
              <summary className="cursor-pointer text-xs text-rose-300">Последние замечания</summary>
              <Md className="mt-1 text-zinc-300">{task.notes.replace(/^USER:/, "")}</Md>
            </details>
          )}
          <input className={inputCls} placeholder="Подсказка исполнителю (необязательно)" value={comment} onChange={(e) => setComment(e.target.value)} />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={!canAct} onClick={() => onAction("retry", comment)}>↻ Ещё раз</Button>
            <Button disabled={!canAct} onClick={() => onAction("accept")} title="Вы поправили сами или результат устраивает — принять как есть (без коммита)">
              ✓ Принять как есть
            </Button>
            <Button
              variant="danger"
              disabled={!canAct}
              onClick={() => window.confirm("Отменить все изменения этой задачи и пропустить её?") && onAction("skip")}
            >
              Пропустить и откатить
            </Button>
          </div>
        </div>
      )}

      {task.status === "done" && task.commit_sha && open && (
        <div className="mt-2">
          <Button
            variant="ghost"
            disabled={!canAct}
            onClick={() => window.confirm("Откатить изменения этой задачи в рабочей копии? Её можно будет выполнить заново.") && onAction("revert")}
          >
            ↶ Откатить задачу
          </Button>
        </div>
      )}
    </Card>
  );
}
