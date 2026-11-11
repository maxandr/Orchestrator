import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z, ZodError } from "zod";
import { PORT, WEB_DIST } from "./config.js";
import { q } from "./db.js";
import { bus, type BusMessage } from "./bus.js";
import * as orch from "./orchestrator.js";
import { UserError } from "./orchestrator.js";
import { isUnityProject, unityVersion } from "./unity.js";
import * as git from "./git.js";

const app = Fastify({ logger: { level: "warn" } });
await app.register(websocket);

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof UserError) {
    const status = err.code === "not_found" ? 404 : ["busy", "dirty"].includes(err.code) ? 409 : 400;
    return reply.status(status).send({ error: err.message, code: err.code });
  }
  if (err instanceof ZodError) return reply.status(400).send({ error: "Некорректные данные: " + err.issues.map((i) => i.message).join("; ") });
  console.error(err);
  return reply.status(500).send({ error: (err as Error).message });
});

const id = (p: unknown) => Number((p as { id: string }).id);

/* ───────── Проекты ───────── */

app.get("/api/projects", async () => q.projects());

app.post("/api/projects", async (req) => {
  const body = z.object({ path: z.string().min(1), name: z.string().optional() }).parse(req.body);
  const path = resolve(body.path.trim().replace(/^"|"$/g, ""));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new UserError("Папка не найдена: " + path);
  if (!isUnityProject(path)) throw new UserError("Это не Unity-проект (нет папок Assets и ProjectSettings): " + path);
  if (q.projects().some((p) => p.path.toLowerCase() === path.toLowerCase())) throw new UserError("Проект уже добавлен");
  return { id: q.addProject(body.name?.trim() || basename(path), path) };
});

app.get("/api/projects/:id", async (req) => {
  const project = q.project(id(req.params));
  if (!project) throw new UserError("Проект не найден", "not_found");
  const isRepo = await git.isRepo(project.path);
  return {
    project,
    features: q.features(project.id),
    info: {
      unityVersion: await unityVersion(project.path),
      git: isRepo ? ((await git.hasCommits(project.path)) ? "ok" : "no_commits") : "none",
      exists: existsSync(project.path),
    },
  };
});

app.put("/api/projects/:id/map", async (req) => {
  const { map } = z.object({ map: z.string() }).parse(req.body);
  q.setProjectMap(id(req.params), map);
  return { ok: true };
});

app.delete("/api/projects/:id", async (req) => {
  orch.assertProjectIdle(id(req.params));
  q.deleteProject(id(req.params));
  return { ok: true };
});

/* ───────── Фичи ───────── */

app.post("/api/projects/:id/features", async (req) => {
  const body = z
    .object({
      title: z.string().trim().min(1, "Укажите название"),
      description: z.string().trim().min(1, "Опишите, что нужно сделать — без описания архитектор будет додумывать фичу сам"),
    })
    .parse(req.body);
  return { id: orch.createFeature(id(req.params), body.title, body.description) };
});

app.get("/api/features/:id", async (req) => {
  const feature = q.feature(id(req.params));
  if (!feature) throw new UserError("Фича не найдена", "not_found");
  return {
    feature: { ...feature, plan: feature.plan ? JSON.parse(feature.plan) : null },
    tasks: q.tasks(feature.id),
    project: q.project(feature.project_id),
  };
});

app.get("/api/features/:id/events", async (req) => {
  const after = Number((req.query as { after?: string }).after ?? 0);
  return q.events(id(req.params), after).map((e) => ({ ...e, data: JSON.parse(e.data) }));
});

app.post("/api/features/:id/approve", async (req) => {
  await orch.approve(id(req.params));
  return { ok: true };
});
app.post("/api/features/:id/replan", async (req) => {
  const { feedback } = z.object({ feedback: z.string().min(1) }).parse(req.body);
  orch.plan(id(req.params), feedback);
  return { ok: true };
});
app.post("/api/features/:id/refine", async (req) => {
  const { request } = z.object({ request: z.string().trim().min(1, "Опишите, что доработать") }).parse(req.body);
  orch.refine(id(req.params), request);
  return { ok: true };
});
app.put("/api/features/:id/plan", async (req) => {
  orch.editPlan(id(req.params), (req.body as { plan: unknown }).plan);
  return { ok: true };
});
app.post("/api/features/:id/stop", async (req) => {
  orch.stop(id(req.params));
  return { ok: true };
});
app.post("/api/features/:id/resume", async (req) => {
  await orch.resume(id(req.params));
  return { ok: true };
});
app.delete("/api/features/:id", async (req) => {
  await orch.deleteFeature(id(req.params));
  return { ok: true };
});

app.post("/api/tasks/:id/action", async (req) => {
  const body = z
    .object({ action: z.enum(["retry", "accept", "skip", "revert"]), comment: z.string().optional() })
    .parse(req.body);
  await orch.taskAction(id(req.params), body.action, body.comment);
  return { ok: true };
});

/* ───────── Живые обновления ───────── */

app.get("/ws", { websocket: true }, (socket) => {
  const onMsg = (msg: BusMessage) => {
    const payload =
      msg.type === "event" ? { ...msg, event: { ...msg.event, data: JSON.parse(msg.event.data) } } : msg;
    socket.send(JSON.stringify(payload));
  };
  bus.on("msg", onMsg);
  socket.on("close", () => bus.off("msg", onMsg));
});

/* ───────── Собранный фронт (npm run build) ───────── */

if (existsSync(WEB_DIST)) {
  await app.register(fastifyStatic, { root: WEB_DIST });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api")) return reply.status(404).send({ error: "Not found" });
    return reply.sendFile("index.html");
  });
}

orch.recoverAfterRestart(q.projects().flatMap((p) => q.features(p.id)));

await app.listen({ port: PORT, host: "127.0.0.1" });
console.log(`Оркестратор: http://localhost:${PORT}  (в режиме разработки страница — http://localhost:5173)`);
