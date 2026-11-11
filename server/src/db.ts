import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.js";

mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, "orchestrator.db"));

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  map TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS features (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planning',
  plan TEXT,
  plan_feedback TEXT,
  architect_session TEXT,
  summary TEXT,
  error TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  title TEXT NOT NULL,
  role TEXT NOT NULL,
  brief TEXT NOT NULL,
  verify TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  executor_session TEXT,
  base_sha TEXT,
  commit_sha TEXT,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  feature_id INTEGER NOT NULL,
  task_id INTEGER,
  agent TEXT NOT NULL,
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS events_feature ON events(feature_id, id);
`);

export type FeatureStatus =
  | "planning" // архитектор думает
  | "awaiting_approval" // план ждёт пользователя
  | "running" // задачи выполняются
  | "awaiting_user" // задача застряла, нужно решение
  | "summarizing" // архитектор подводит итог
  | "done"
  | "stopped"
  | "failed";

export type TaskStatus =
  | "pending"
  | "running"
  | "qa"
  | "review"
  | "done"
  | "needs_user"
  | "skipped";

export interface Project {
  id: number;
  name: string;
  path: string;
  map: string;
  created_at: string;
}
export interface Feature {
  id: number;
  project_id: number;
  title: string;
  description: string;
  status: FeatureStatus;
  plan: string | null;
  plan_feedback: string | null;
  architect_session: string | null;
  summary: string | null;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  created_at: string;
}
export interface Task {
  id: number;
  feature_id: number;
  idx: number;
  title: string;
  role: string;
  brief: string;
  verify: string;
  status: TaskStatus;
  attempts: number;
  executor_session: string | null;
  base_sha: string | null;
  commit_sha: string | null;
  notes: string | null;
}
export interface EventRow {
  id: number;
  feature_id: number;
  task_id: number | null;
  agent: string;
  kind: string;
  data: string;
  ts: string;
}

type Val = string | number | null;

export const q = {
  projects: () => db.prepare("SELECT * FROM projects ORDER BY id DESC").all() as unknown as Project[],
  project: (id: number) => db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as Project | undefined,
  addProject: (name: string, path: string) =>
    Number(db.prepare("INSERT INTO projects (name, path) VALUES (?, ?)").run(name, path).lastInsertRowid),
  deleteProject: (id: number) => db.prepare("DELETE FROM projects WHERE id = ?").run(id),
  setProjectMap: (id: number, map: string) => db.prepare("UPDATE projects SET map = ? WHERE id = ?").run(map, id),

  features: (projectId: number) =>
    db.prepare("SELECT * FROM features WHERE project_id = ? ORDER BY id DESC").all(projectId) as unknown as Feature[],
  feature: (id: number) => db.prepare("SELECT * FROM features WHERE id = ?").get(id) as unknown as Feature | undefined,
  addFeature: (projectId: number, title: string, description: string) =>
    Number(
      db.prepare("INSERT INTO features (project_id, title, description) VALUES (?, ?, ?)").run(projectId, title, description)
        .lastInsertRowid,
    ),
  updateFeature: (id: number, fields: Partial<Record<keyof Feature, Val>>) => update("features", id, fields),
  addTokens: (id: number, tin: number, tout: number) =>
    db.prepare("UPDATE features SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?").run(tin, tout, id),

  tasks: (featureId: number) =>
    db.prepare("SELECT * FROM tasks WHERE feature_id = ? ORDER BY idx").all(featureId) as unknown as Task[],
  task: (id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task | undefined,
  replaceTasks: (featureId: number, tasks: { title: string; role: string; brief: string; verify: string }[]) => {
    db.prepare("DELETE FROM tasks WHERE feature_id = ?").run(featureId);
    const ins = db.prepare("INSERT INTO tasks (feature_id, idx, title, role, brief, verify) VALUES (?, ?, ?, ?, ?, ?)");
    tasks.forEach((t, i) => ins.run(featureId, i, t.title, t.role, t.brief, t.verify));
  },
  updateTask: (id: number, fields: Partial<Record<keyof Task, Val>>) => update("tasks", id, fields),

  events: (featureId: number, afterId = 0) =>
    db.prepare("SELECT * FROM events WHERE feature_id = ? AND id > ? ORDER BY id").all(featureId, afterId) as unknown as EventRow[],
  addEvent: (featureId: number, taskId: number | null, agent: string, kind: string, data: unknown) => {
    const r = db
      .prepare("INSERT INTO events (feature_id, task_id, agent, kind, data) VALUES (?, ?, ?, ?, ?)")
      .run(featureId, taskId, agent, kind, JSON.stringify(data));
    return db.prepare("SELECT * FROM events WHERE id = ?").get(r.lastInsertRowid) as unknown as EventRow;
  },
};

function update(table: string, id: number, fields: Record<string, Val | undefined>) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...keys.map((k) => fields[k] as Val), id);
}
