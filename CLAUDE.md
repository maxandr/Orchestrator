# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Что это

Локальный сервер + веб-страница, которые делают Unity-игру по фичам командой агентов Claude Code. Агенты — это дочерние процессы `claude -p` (CLI пользователя, работают по подписке, без API-ключа). Opus — архитектор/ревьюер, Sonnet — исполнители (`coder`, `scene`, `ui`), QA — Unity CLI. Весь UI, логи, промпты и сообщения об ошибках на русском — сохраняйте этот стиль.

## Команды

npm workspaces: `server` и `web`. Запускать из корня.

```
npm install
npm run dev                  # сервер (tsx watch) на :4321 + Vite на :5173 (проксирует /api и /ws)
npm run build                # vite build фронта + tsc --noEmit сервера
npm start                    # только сервер; отдаёт web/dist, если он собран
npm run typecheck -w server  # проверка типов сервера
npm run build -w web         # tsc + vite build фронта
```

Тестов и линтера в репозитории нет; проверка изменений — `npm run build` (тайпчек обеих частей). `start.bat` — запуск для Windows (проверяет `node`/`claude`, ставит зависимости, открывает страницу).

Требования: Node с встроенным `node:sqlite` (`DatabaseSync`), `claude` в PATH, для QA — `unity` CLI. Переменные окружения: `PORT`, `ARCHITECT_MODEL`, `EXECUTOR_MODEL`, `CLAUDE_BIN`, `UNITY_BIN`, `ORCH_DATA_DIR` (см. `server/src/config.ts`).

## Архитектура

**Сервер** (`server/src`, Fastify, ESM, импорты с `.js`, запуск через `tsx` без сборки):

- `index.ts` — HTTP API (`/api/...`, валидация zod) и WebSocket `/ws`. `UserError` из оркестратора мапится в HTTP-коды по `code` (`not_found`→404, `busy`/`dirty`→409, иначе 400).
- `orchestrator.ts` — конечный автомат фичи. Статусы фичи: `planning → awaiting_approval → running → (awaiting_user) → summarizing → done`, плюс `stopped`/`failed`. Статусы задачи: `pending → running → qa → review → done`, либо `needs_user`/`skipped`. Цикл задачи (`runTask`): исполнитель → QA (`unity.ts`) → `git.diffSince` → ревьюер; до `MAX_ATTEMPTS` (3) кругов, затем `needs_user`. **Никто не коммитит и не пушит сам** — ни оркестратор, ни агенты (исполнителю git-команды на запись запрещены через `disallowedTools`). Исключение — кнопки на странице фичи (`GitPanel`, `POST /api/features/:id/commit-push`, только по нажатию пользователя и не во время работы фичи в проекте): «Коммит + пуш в main» (`git.commitPushMain`: `add -A` + `commit` + `push`, нужно быть на main/master) и «Коммит + пуш в новую ветку» (`git.commitPushBranch`: коммит рабочей копии через `commit-tree` от HEAD в ветку `orchestrator/feature-<id>-<дата-время>` и её пуш; HEAD, индекс и файлы не меняются). Сообщение по умолчанию — «Оркестратор: <название фичи>». Состояние задачи фиксируется снимками (`git.snapshot`: commit-объект вне истории под `refs/orchestrator/<sha>`): `base_sha` — до задачи, `commit_sha` — после принятия. Изменения остаются в рабочей копии Unity-проекта, коммитит пользователь сам.
  - В одном Unity-проекте одновременно выполняется только одна фича (`active` + `assertProjectFree`) — git и Unity общие.
  - Нужен только git-репозиторий (`ensureRepo`); незакоммиченные изменения пользователя допустимы — они входят в базовый снимок задачи.
  - «Доработать» (`refine`, только из `done`): архитектор продолжает свою сессию и возвращает план только из новых задач. Они добавляются после выполненных (`replacePendingTasks` не трогает `done`/`skipped`), план снова ждёт утверждения. Прерванная доработка возвращает фичу в `done`.
  - Удаление фичи (`deleteFeature`) стирает её из БД и убирает ссылки на её снимки. Рабочую копию не трогает.
  - После рестарта сервера активные фичи переводятся в `stopped` (`recoverAfterRestart`); «Продолжить» возобновляет с текущей задачи. Rate limit подписки → `stopped`, попытка не засчитывается.
- `agents/runAgent.ts` — спавн `claude -p --output-format stream-json --verbose`. **Только по подписке, никогда по API**: из окружения агента вычищаются `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_BASE_URL`/`CLAUDE_CODE_USE_*` и т.п. (`subscriptionEnv`), а если в событии `system/init` `apiKeySource` не `"none"` (или ответ пришёл раньше init) — агент убивается, `apiBlocked` → фича в `stopped` с `API_BLOCKED_MSG`, попытка не засчитывается. Дальше — парсинг потока событий в лог, учёт токенов, детект rate limit, `--json-schema` для структурированного ответа, `--resume` для продолжения сессии. «Стоп» убивает дерево процессов (`taskkill /T /F` на Windows).
- `agents/roles.ts` — роли: архитектор (план, только чтение), исполнитель (Read/Edit/Write/Bash/Skill, `acceptEdits`), ревьюер и итоговый summarizer (только чтение). Каждая роль задаёт JSON-схему ответа + zod-схему для парсинга (`PlanSchema` и т.д.). Системный промпт исполнителя = `executor-common.md` + `<role>.md`. Сессии архитектора/исполнителя сохраняются в БД и переиспользуются при replan/повторе.
- `server/prompts/*.md` — системные промпты ролей, читаются с диска при каждом запуске агента.
- `db.ts` — SQLite (WAL) в `data/orchestrator.db`: `projects` (включая `map` — «карта проекта», которую summarizer обновляет после каждой фичи и архитектор получает на вход), `features` (план хранится JSON-строкой), `tasks`, `events` (лог). Схема создаётся `CREATE TABLE IF NOT EXISTS` при старте — миграций нет.
- `bus.ts` — `logEvent` пишет событие в БД и шлёт его по WebSocket; `featureChanged` сигналит странице перечитать фичу.
- `unity.ts` — компиляция: открытый редактор с пакетом Pipeline → `unity recompile`; редактор закрыт (lock-файл `Temp/UnityLockfile`) → batch-режим; открыт без Pipeline → `skipped`. EditMode-тесты только при закрытом редакторе.
- `git.ts` — снимки через временный индекс (HEAD, ветки и staging пользователя не трогаются), diff относительно снимка `base_sha` (бинарные/огромные Unity-ассеты `*.unity`, `*.prefab`, `*.meta`, `*.asset` и т.п. исключены из полного diff), откат (`discardSince`) и `revertTask` (base→after в рабочей копии, отказ при конфликте).

**Фронт** (`web/src`, React 18 + react-router + Tailwind v4 + Vite): страницы `Projects` → `Project` → `Feature` (план, задачи, живой лог `AgentLog`). Типы в `web/src/api.ts` дублируют серверные вручную — при изменении статусов, схемы плана или формы событий правьте обе стороны.
