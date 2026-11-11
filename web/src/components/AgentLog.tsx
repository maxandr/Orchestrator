import { useEffect, useMemo, useRef, useState } from "react";
import { agentModel, api, roleLabel, useBus, type AgentEvent } from "../api";
import { Md } from "./ui";

const agentColor: Record<string, string> = {
  architect: "text-violet-300",
  reviewer: "text-violet-300",
  coder: "text-sky-300",
  scene: "text-teal-300",
  ui: "text-pink-300",
  qa: "text-amber-300",
  system: "text-zinc-400",
};

/** Живой лог агентов фичи. filter: undefined — всё, null — только события без задачи (планирование/итог), число — задача. */
export function useFeatureEvents(featureId: number) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const lastId = useRef(0);

  useEffect(() => {
    lastId.current = 0;
    setEvents([]);
    api<AgentEvent[]>("GET", `/api/features/${featureId}/events`).then((list) => {
      setEvents(list);
      lastId.current = list.at(-1)?.id ?? 0;
    });
  }, [featureId]);

  useBus((msg) => {
    if (msg.type !== "event" || msg.event.feature_id !== featureId) return;
    if (msg.event.id <= lastId.current) return;
    lastId.current = msg.event.id;
    setEvents((prev) => [...prev, msg.event]);
  });
  return events;
}

export default function AgentLog({ events, filter }: { events: AgentEvent[]; filter: number | null | undefined }) {
  const shown = useMemo(
    () => (filter === undefined ? events : events.filter((e) => e.task_id === filter)),
    [events, filter],
  );
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown.length]);

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="h-full space-y-1.5 overflow-y-auto p-3 font-[450]"
    >
      {shown.length === 0 && <div className="p-6 text-center text-sm text-zinc-500">Событий пока нет.</div>}
      {shown.map((e) => (
        <EventRow key={e.id} e={e} />
      ))}
    </div>
  );
}

function Who({ agent }: { agent: string }) {
  const model = agentModel[agent];
  return (
    <span className={`shrink-0 text-xs font-semibold ${agentColor[agent] ?? "text-zinc-300"}`}>
      {roleLabel[agent] ?? agent}
      {model && <span className="ml-1 font-normal text-zinc-500">{model}</span>}
    </span>
  );
}

function Collapsible({ label, children, className = "" }: { label: string; children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={className}>
      <button className="text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {label}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

const time = (ts: string) => new Date(ts).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

function EventRow({ e }: { e: AgentEvent }) {
  const d = e.data;
  const row = (content: React.ReactNode, extra = "") => (
    <div className={`flex gap-2 rounded px-2 py-1 ${extra}`}>
      <span className="w-14 shrink-0 pt-0.5 text-[10px] text-zinc-600">{time(e.ts)}</span>
      <div className="min-w-0 flex-1">{content}</div>
    </div>
  );

  switch (e.kind) {
    case "start":
      return row(
        <div>
          <div className="flex items-center gap-2">
            <Who agent={e.agent} />
            <span className="text-xs text-zinc-400">{e.agent === "qa" ? "проверяет проект" : d.resume ? "продолжает сессию" : "запущен"}</span>
          </div>
          {d.prompt && e.agent !== "qa" && (
            <Collapsible label="что ему передали">
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-400">{d.prompt}</pre>
            </Collapsible>
          )}
        </div>,
        "border-t border-zinc-800 mt-3 pt-2",
      );
    case "text":
      return row(
        <div className="flex gap-2">
          <Who agent={e.agent} />
          <Md className="min-w-0 flex-1 text-zinc-200">{d.text}</Md>
        </div>,
      );
    case "thinking":
      return row(
        <Collapsible label="размышления">
          <div className="whitespace-pre-wrap text-xs italic text-zinc-500">{d.text}</div>
        </Collapsible>,
      );
    case "tool":
      return row(
        <div className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
          <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{d.name}</span>
          <span className="truncate text-zinc-400" title={d.input}>{d.input}</span>
        </div>,
      );
    case "tool_result":
      return row(
        <Collapsible label={d.isError ? "результат: ошибка" : "результат"} className={d.isError ? "[&>button]:text-rose-400" : ""}>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-400">{d.text}</pre>
        </Collapsible>,
      );
    case "result":
      return row(
        <div className="text-xs text-zinc-500">
          {d.isError ? "✗ завершился с ошибкой" : "✓ закончил"} · ходов {d.turns ?? "?"} · {Math.round((d.durationMs ?? 0) / 1000)} с ·
          токены {fmt(d.tokensIn)} → {fmt(d.tokensOut)}
        </div>,
      );
    case "check": {
      const color = d.status === "passed" ? "text-emerald-300" : d.status === "failed" ? "text-rose-300" : "text-zinc-400";
      const icon = d.status === "passed" ? "✓" : d.status === "failed" ? "✗" : "–";
      return row(
        <div>
          <div className="flex items-center gap-2">
            <Who agent="qa" />
            <span className={`text-sm ${color}`}>
              {icon} {d.name}: {d.status === "passed" ? "OK" : d.status === "failed" ? "ошибки" : "пропущено"}
            </span>
            {d.method && d.method !== "—" && <span className="text-xs text-zinc-600">{d.method}</span>}
          </div>
          {d.status === "skipped" && <div className="text-xs text-zinc-500">{d.details}</div>}
          {d.errors?.length > 0 && (
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap rounded bg-rose-950/30 p-2 text-xs text-rose-200">{d.errors.join("\n")}</pre>
          )}
          {d.details && d.status !== "skipped" && (
            <Collapsible label="лог Unity">
              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 text-xs text-zinc-500">{d.details}</pre>
            </Collapsible>
          )}
        </div>,
      );
    }
    case "verdict":
      return row(
        <div className={`rounded-md border p-2 ${d.verdict === "accept" ? "border-emerald-800 bg-emerald-950/30" : "border-amber-800 bg-amber-950/30"}`}>
          <div className="mb-1 flex items-center gap-2">
            <Who agent="reviewer" />
            <span className={d.verdict === "accept" ? "text-sm text-emerald-300" : "text-sm text-amber-300"}>
              {d.verdict === "accept" ? "✓ принято" : "↺ на доработку"}
            </span>
          </div>
          <Md className="text-zinc-300">{d.feedback}</Md>
        </div>,
      );
    case "info":
      return row(<div className="text-xs text-zinc-400">• {d.text}</div>);
    case "rate_limit":
      return row(<div className="text-xs text-amber-300">⚠ Лимит подписки: {d.status}{d.resetsAt ? `, сброс ${new Date(d.resetsAt * 1000).toLocaleTimeString("ru-RU")}` : ""}</div>);
    case "stopped":
      return row(<div className="text-xs text-zinc-400">■ <Who agent={e.agent} /> остановлен</div>);
    case "error":
      return row(<div className="whitespace-pre-wrap text-xs text-rose-300">✗ {d.text}</div>);
    default:
      return row(<div className="text-xs text-zinc-500">{e.kind}: {JSON.stringify(d)}</div>);
  }
}

const fmt = (n?: number) => (n == null ? "?" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
