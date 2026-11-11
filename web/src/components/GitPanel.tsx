import { useState } from "react";
import { api } from "../api";
import { Button, Card, ErrorBox, inputCls } from "./ui";

export interface PushStatus {
  branch: string | null;
  main: string | null;
  remote: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
}

function hint(s: PushStatus) {
  if (!s.remote) return "нет remote — git remote add origin <url>";
  const parts = [s.branch ? `ветка ${s.branch}` : "detached HEAD"];
  parts.push(s.dirty ? "есть незакоммиченные изменения" : "изменений нет");
  if (s.ahead) parts.push(`${s.ahead} не отправлено в ${s.remote}/${s.main}`);
  if (s.behind) parts.push(`${s.main} отстаёт от ${s.remote} на ${s.behind}`);
  return parts.join(" · ");
}

/** Коммит + пуш изменений фичи — только по нажатию пользователя. */
export function GitPanel({ featureId, status, busy, onDone }: { featureId: number; status: PushStatus; busy: boolean; onDone: () => void }) {
  const [pushing, setPushing] = useState<"main" | "branch" | null>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const s = status;
  const main = s.main ?? "main";

  async function commitPush(target: "main" | "branch") {
    setPushing(target);
    setResult(null);
    try {
      const r = await api<{ commit: string | null; branch: string; output: string }>("POST", `/api/features/${featureId}/commit-push`, {
        target,
        message,
      });
      const head = r.commit ? `Коммит ${r.commit} запушен в ${r.branch}` : `Новых изменений нет — запушена ${r.branch}`;
      setResult({ ok: true, text: `${head}\n\n${r.output}` });
      setMessage("");
    } catch (err) {
      setResult({ ok: false, text: (err as Error).message });
    }
    setPushing(null);
    onDone();
  }

  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-medium">Коммит и пуш</div>
        <div className="text-xs text-zinc-500">{hint(s)}</div>
      </div>
      <input
        className={inputCls}
        placeholder="Сообщение коммита (необязательно — по умолчанию название фичи)"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => commitPush("main")}
          disabled={!!pushing || busy || !s.remote || !s.main || s.branch !== s.main}
          title={`git add -A, commit и push в ${s.remote ?? "remote"}/${main}`}
        >
          {pushing === "main" ? "Коммит и пуш…" : `Коммит + пуш в ${main}`}
        </Button>
        <Button
          onClick={() => commitPush("branch")}
          disabled={!!pushing || busy || !s.remote || !s.branch}
          title="Коммит в новую ветку orchestrator/feature-<id>-<дата-время> и её пуш. Текущая ветка и файлы не меняются."
        >
          {pushing === "branch" ? "Коммит и пуш…" : "Коммит + пуш в новую ветку"}
        </Button>
      </div>
      {busy && <p className="text-xs text-zinc-500">Пока работает фича, коммитить нельзя.</p>}
      {s.main && s.branch !== s.main && <p className="text-xs text-zinc-500">Для пуша в {s.main} переключитесь на неё.</p>}
      {result &&
        (result.ok ? (
          <pre className="whitespace-pre-wrap rounded border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">{result.text}</pre>
        ) : (
          <ErrorBox>{result.text}</ErrorBox>
        ))}
    </Card>
  );
}
