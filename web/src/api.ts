import { useEffect, useRef, useState, useCallback } from "react";

/* ───────── Типы (совпадают с сервером) ───────── */

export interface Project {
  id: number;
  name: string;
  path: string;
  map: string;
  created_at: string;
}
export type FeatureStatus =
  | "planning"
  | "awaiting_approval"
  | "running"
  | "awaiting_user"
  | "summarizing"
  | "done"
  | "stopped"
  | "failed";
export type TaskStatus = "pending" | "running" | "qa" | "review" | "done" | "needs_user" | "skipped";
export type Role = "coder" | "scene" | "ui";

export interface PlanTask {
  title: string;
  role: Role;
  brief: string;
  verify: string;
}
export interface Plan {
  goal: string;
  acceptance: string[];
  affected: string[];
  notes: string;
  tasks: PlanTask[];
}
export interface Feature {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: FeatureStatus;
  plan: Plan | null;
  summary: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
}
export interface Task extends PlanTask {
  id: number;
  feature_id: number;
  idx: number;
  status: TaskStatus;
  attempts: number;
  commit_sha: string | null;
  notes: string | null;
}
export interface AgentEvent {
  id: number;
  feature_id: number;
  task_id: number | null;
  agent: string;
  kind: string;
  data: any;
  ts: string;
}

/* ───────── HTTP ───────── */

export class ApiError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error ?? res.statusText, data.code);
  return data as T;
}

/* ───────── WebSocket: одно соединение на страницу ───────── */

type Listener = (msg: any) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;

function connect() {
  if (socket && socket.readyState <= 1) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    listeners.forEach((l) => l(msg));
  };
  socket.onclose = () => setTimeout(connect, 1500);
}

export function useBus(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    connect();
    const l: Listener = (m) => ref.current(m);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

/** Загружает данные и перезагружает их, когда сервер сообщает об изменениях. */
export function useResource<T>(url: string, shouldReload: (msg: any) => boolean) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    api<T>("GET", url)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  }, [url]);
  useEffect(reload, [reload]);
  useBus((msg) => {
    if (shouldReload(msg)) reload();
  });
  return { data, error, reload };
}

/* ───────── Подписи ───────── */

export const featureStatusLabel: Record<FeatureStatus, string> = {
  planning: "Архитектор планирует",
  awaiting_approval: "План ждёт утверждения",
  running: "Выполняется",
  awaiting_user: "Нужно ваше решение",
  summarizing: "Подводим итог",
  done: "Готово",
  stopped: "Остановлено",
  failed: "Ошибка",
};
export const featureStatusColor: Record<FeatureStatus, string> = {
  planning: "bg-violet-500/15 text-violet-300",
  awaiting_approval: "bg-amber-500/15 text-amber-300",
  running: "bg-sky-500/15 text-sky-300",
  awaiting_user: "bg-amber-500/15 text-amber-300",
  summarizing: "bg-violet-500/15 text-violet-300",
  done: "bg-emerald-500/15 text-emerald-300",
  stopped: "bg-zinc-500/20 text-zinc-300",
  failed: "bg-rose-500/15 text-rose-300",
};
export const taskStatusLabel: Record<TaskStatus, string> = {
  pending: "ожидает",
  running: "в работе",
  qa: "QA",
  review: "ревью",
  done: "готово",
  needs_user: "нужно решение",
  skipped: "пропущена",
};
export const roleLabel: Record<string, string> = {
  coder: "Программист",
  scene: "Сцены",
  ui: "UI",
  architect: "Архитектор",
  reviewer: "Ревьюер",
  qa: "QA",
  system: "Система",
};
export const agentModel: Record<string, string> = {
  architect: "Opus",
  reviewer: "Opus",
  coder: "Sonnet",
  scene: "Sonnet",
  ui: "Sonnet",
  qa: "Unity",
};
export const isBusy = (s: FeatureStatus) => s === "planning" || s === "running" || s === "summarizing";
