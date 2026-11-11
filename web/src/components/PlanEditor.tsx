import { useState } from "react";
import { roleLabel, type Plan, type PlanTask, type Role } from "../api";
import { Button, Card, inputCls } from "./ui";

/** Ручная правка плана перед утверждением. */
export default function PlanEditor({ plan, onSave, onCancel }: { plan: Plan; onSave: (p: Plan) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Plan>(() => structuredClone(plan));
  const setTask = (i: number, patch: Partial<PlanTask>) =>
    setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const tasks = [...d.tasks];
      const j = i + dir;
      if (j < 0 || j >= tasks.length) return d;
      [tasks[i], tasks[j]] = [tasks[j], tasks[i]];
      return { ...d, tasks };
    });

  return (
    <div className="space-y-3">
      <label className="block text-xs text-zinc-400">
        Цель
        <textarea className={`${inputCls} mt-1 min-h-16`} value={draft.goal} onChange={(e) => setDraft({ ...draft, goal: e.target.value })} />
      </label>
      <label className="block text-xs text-zinc-400">
        Критерии готовности (по одному в строке)
        <textarea
          className={`${inputCls} mt-1 min-h-20`}
          value={draft.acceptance.join("\n")}
          onChange={(e) => setDraft({ ...draft, acceptance: e.target.value.split("\n").filter((s) => s.trim()) })}
        />
      </label>

      {draft.tasks.map((t, i) => (
        <Card key={i} className="space-y-2 p-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">#{i + 1}</span>
            <input className={inputCls} value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} />
            <select
              className={`${inputCls} w-40`}
              value={t.role}
              onChange={(e) => setTask(i, { role: e.target.value as Role })}
            >
              {(["coder", "scene", "ui"] as const).map((r) => (
                <option key={r} value={r}>{roleLabel[r]}</option>
              ))}
            </select>
            <Button variant="ghost" onClick={() => move(i, -1)} title="Выше">↑</Button>
            <Button variant="ghost" onClick={() => move(i, 1)} title="Ниже">↓</Button>
            <Button
              variant="ghost"
              onClick={() => setDraft((d) => ({ ...d, tasks: d.tasks.filter((_, j) => j !== i) }))}
              disabled={draft.tasks.length === 1}
              title="Удалить"
            >
              ✕
            </Button>
          </div>
          <textarea className={`${inputCls} min-h-32 font-mono text-xs`} value={t.brief} onChange={(e) => setTask(i, { brief: e.target.value })} />
          <input className={inputCls} placeholder="Как проверить" value={t.verify} onChange={(e) => setTask(i, { verify: e.target.value })} />
        </Card>
      ))}

      <div className="flex gap-2">
        <Button
          onClick={() =>
            setDraft((d) => ({ ...d, tasks: [...d.tasks, { title: "Новая задача", role: "coder", brief: "", verify: "Компилируется" }] }))
          }
        >
          + Задача
        </Button>
        <div className="flex-1" />
        <Button onClick={onCancel}>Отмена</Button>
        <Button variant="primary" onClick={() => onSave(draft)}>Сохранить план</Button>
      </div>
    </div>
  );
}
