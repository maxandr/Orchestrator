import { spawnSync, type ChildProcess } from "node:child_process";

/** Активные процессы по фиче (агенты claude, Unity CLI из QA) — чтобы кнопка «Стоп» могла их убить. */
const running = new Map<number, Set<ChildProcess>>();
const stoppedFeatures = new Set<number>();

/** Регистрирует процесс фичи; снимается с учёта сам при завершении. Если фича уже остановлена — убивается сразу. */
export function trackProcess(featureId: number, child: ChildProcess) {
  const set = running.get(featureId) ?? new Set();
  set.add(child);
  running.set(featureId, set);
  child.once("close", () => set.delete(child));
  if (stoppedFeatures.has(featureId)) killTree(child);
}

export function stopFeatureProcesses(featureId: number) {
  stoppedFeatures.add(featureId);
  for (const child of running.get(featureId) ?? []) killTree(child);
}
export function clearStop(featureId: number) {
  stoppedFeatures.delete(featureId);
}
export function isStopped(featureId: number) {
  return stoppedFeatures.has(featureId);
}

/** Убивает процесс вместе с дочерними (Unity CLI запускает Unity.exe отдельным процессом). */
export function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGTERM");
}
