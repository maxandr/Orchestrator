import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, featureStatusColor, featureStatusLabel, isBusy, useResource, type Feature, type Project as P } from "../api";
import { Badge, Button, Card, ErrorBox, Md, inputCls } from "../components/ui";

interface Data {
  project: P;
  features: Omit<Feature, "plan">[];
  info: { unityVersion: string | null; git: "ok" | "no_commits" | "none"; exists: boolean };
}

export default function Project() {
  const { id } = useParams();
  const { data, error, reload } = useResource<Data>(`/api/projects/${id}`, (m) => m.type === "feature");
  const navigate = useNavigate();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [mapText, setMapText] = useState("");
  const [editingMap, setEditingMap] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    if (data && !editingMap) setMapText(data.project.map);
  }, [data, editingMap]);

  if (error) return <div className="p-6"><ErrorBox>{error}</ErrorBox></div>;
  if (!data) return <div className="p-6 text-zinc-500">Загрузка…</div>;
  const { project, features, info } = data;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    try {
      const r = await api("POST", `/api/projects/${id}/features`, { title, description: desc });
      navigate(`/features/${r.id}`);
    } catch (err: any) {
      setFormError(err.message);
    }
  }

  async function saveMap() {
    await api("PUT", `/api/projects/${id}/map`, { map: mapText });
    setEditingMap(false);
    reload();
  }

  async function remove() {
    if (!window.confirm(`Убрать проект «${project.name}» из оркестратора? Файлы проекта не трогаются.`)) return;
    await api("DELETE", `/api/projects/${id}`);
    navigate("/");
  }

  async function removeFeature(e: React.MouseEvent, f: Omit<Feature, "plan">) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Удалить фичу «${f.title}» вместе с планом и логом? Изменения в файлах проекта останутся как есть.`)) return;
    setListError(null);
    try {
      await api("DELETE", `/api/features/${f.id}`);
    } catch (err) {
      setListError((err as Error).message);
    }
    reload();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link to="/" className="text-xs text-zinc-500 hover:text-zinc-300">← Проекты</Link>
          <h1 className="text-xl font-semibold">{project.name}</h1>
          <div className="text-xs text-zinc-500">{project.path}</div>
          <div className="mt-2 flex flex-wrap gap-2 text-xs">
            <Badge className="bg-zinc-800 text-zinc-300">Unity {info.unityVersion ?? "?"}</Badge>
            {info.git !== "none" && <Badge className="bg-emerald-500/15 text-emerald-300">git ✓</Badge>}
            {info.git === "none" && <Badge className="bg-rose-500/15 text-rose-300">нет git — выполните git init</Badge>}
            {!info.exists && <Badge className="bg-rose-500/15 text-rose-300">папка не найдена</Badge>}
          </div>
        </div>
        <Button variant="ghost" onClick={remove}>Убрать</Button>
      </div>

      <Card className="p-4">
        <h2 className="mb-3 font-medium">Новая часть игры</h2>
        <form onSubmit={create} className="space-y-3">
          <input className={inputCls} placeholder="Название: «Движение игрока», «Инвентарь», «Главное меню»…" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea
            className={`${inputCls} min-h-28`}
            placeholder="Опишите, что должно получиться: управление, поведение, ограничения, на что похоже. Чем конкретнее — тем лучше план. Без описания архитектору не отдать."
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
          />
          <div className="flex items-center gap-3">
            <Button variant="primary" disabled={!title.trim() || !desc.trim()}>Отдать архитектору</Button>
            <span className="text-xs text-zinc-500">Opus изучит проект и предложит план — вы его утвердите.</span>
          </div>
          {formError && <ErrorBox>{formError}</ErrorBox>}
        </form>
      </Card>

      <div>
        <h2 className="mb-2 font-medium">Фичи</h2>
        {features.length === 0 && <p className="text-sm text-zinc-500">Пока ни одной.</p>}
        {listError && <div className="mb-2"><ErrorBox>{listError}</ErrorBox></div>}
        <div className="space-y-2">
          {features.map((f) => (
            <Link key={f.id} to={`/features/${f.id}`}>
              <Card className="mb-2 flex items-center justify-between p-3 transition hover:border-zinc-600">
                <div className="min-w-0">
                  <div className="font-medium">{f.title}</div>
                  {f.description && <div className="truncate text-xs text-zinc-500">{f.description}</div>}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge className={featureStatusColor[f.status]}>{featureStatusLabel[f.status]}</Badge>
                  {!isBusy(f.status) && (
                    <button
                      className="rounded px-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-rose-300"
                      title="Удалить фичу"
                      onClick={(e) => removeFeature(e, f)}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <Card className="p-4">
        <button className="flex w-full items-center justify-between text-left" onClick={() => setMapOpen(!mapOpen)}>
          <span className="font-medium">Карта проекта</span>
          <span className="text-xs text-zinc-500">{mapOpen ? "свернуть" : "Opus ведёт её после каждой фичи — развернуть"}</span>
        </button>
        {mapOpen && (
          <div className="mt-3 space-y-2">
            {editingMap ? (
              <>
                <textarea className={`${inputCls} min-h-80 font-mono text-xs`} value={mapText} onChange={(e) => setMapText(e.target.value)} />
                <div className="flex gap-2">
                  <Button variant="primary" onClick={saveMap}>Сохранить</Button>
                  <Button onClick={() => setEditingMap(false)}>Отмена</Button>
                </div>
              </>
            ) : (
              <>
                {project.map ? <Md>{project.map}</Md> : <p className="text-sm text-zinc-500">Пусто — появится после первой фичи. Можно заполнить вручную.</p>}
                <Button onClick={() => setEditingMap(true)}>Редактировать</Button>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
