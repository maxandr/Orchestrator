import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useResource, type Project } from "../api";
import { Button, Card, ErrorBox, inputCls } from "../components/ui";

export default function Projects() {
  const { data: projects, reload } = useResource<Project[]>("/api/projects", (m) => m.type === "project");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const { id } = await api("POST", "/api/projects", { path });
      setPath("");
      reload();
      navigate(`/projects/${id}`);
    } catch (err: any) {
      setError(err.message);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold">Unity-проекты</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Добавьте папку проекта. Оркестратор будет делать игру по частям: вы описываете фичу, Opus проектирует её и ставит
          задачи, Sonnet выполняет, Unity проверяет компиляцию, изменения остаются в рабочей копии — коммитите вы сами.
        </p>
      </div>

      <Card className="p-4">
        <form onSubmit={add} className="flex gap-2">
          <input
            className={inputCls}
            placeholder="D:\Projects\MyGame — путь к папке с Assets и ProjectSettings"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <Button variant="primary" disabled={!path.trim()}>
            Добавить
          </Button>
        </form>
        {error && <div className="mt-3"><ErrorBox>{error}</ErrorBox></div>}
      </Card>

      <div className="space-y-2">
        {projects?.length === 0 && <p className="text-sm text-zinc-500">Пока нет проектов.</p>}
        {projects?.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`}>
            <Card className="mb-2 flex items-center justify-between p-4 transition hover:border-zinc-600">
              <div>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-zinc-500">{p.path}</div>
              </div>
              <span className="text-zinc-500">→</span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
