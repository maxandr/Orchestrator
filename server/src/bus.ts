import { EventEmitter } from "node:events";
import { q, type EventRow } from "./db.js";

/** Сообщения, которые сервер шлёт на страницу по WebSocket. */
export type BusMessage =
  | { type: "event"; event: EventRow }
  | { type: "feature"; featureId: number }
  | { type: "project"; projectId: number };

export const bus = new EventEmitter();
bus.setMaxListeners(100);

export function emit(msg: BusMessage) {
  bus.emit("msg", msg);
}

/** Записать событие лога в БД и отправить на страницу. */
export function logEvent(featureId: number, taskId: number | null, agent: string, kind: string, data: unknown) {
  const event = q.addEvent(featureId, taskId, agent, kind, data);
  emit({ type: "event", event });
  return event;
}

export function featureChanged(featureId: number) {
  emit({ type: "feature", featureId });
}
