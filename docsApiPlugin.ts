import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PluginOption } from "vite";

type DocContent = {
  type: string;
  content?: unknown[];
  [key: string]: unknown;
};

type Doc = {
  id: string;
  title: string;
  content: DocContent;
  pinned: boolean;
};

type DocRow = {
  id: string;
  title: string;
  content_json: string;
  pinned: number;
};

type RoutineTask = {
  id: string;
  title: string;
  timeOfDay: string;
  weekdayMask: number;
  sortOrder: number;
  active: boolean;
  subtasks: string[];
};

type RoutineTaskRow = {
  id: string;
  title: string;
  time_of_day: string;
  weekday_mask: number;
  sort_order: number;
  active: number;
  subtasks_json: string;
};

type RoutineTaskCompletionRow = {
  routine_task_id: string;
  completed_subtasks_json: string;
};

type NextRoutineTask = {
  routineTaskId: string;
  title: string;
  timeOfDay: string;
  due: boolean;
  subtaskText: string | null;
  subtaskIndex: number | null;
  completedSubtaskCount: number;
  totalSubtaskCount: number;
};

type NextTaskResponse = {
  currentTime: string;
  nextTask:
    | ({ source: "routine" } & NextRoutineTask)
    | ({ source: "todo"; docId: string; docTitle: string; text: string })
    | null;
  upcoming: NextRoutineTask[];
};

const docsDir = path.resolve(process.cwd(), "documents");
const dataDir = path.resolve(process.cwd(), "data");
const dbPath = path.resolve(dataDir, "memory.sqlite");

const sendJson = (res: ServerResponse, status: number, data: unknown) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
};

const readRequestBody = async (req: IncomingMessage): Promise<unknown> => {
  let raw = "";

  for await (const chunk of req) {
    raw += chunk;
  }

  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const parseMarkdown = (id: string, markdown: string): { id: string; title: string; body: string; pinned: boolean } => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const pinnedLine = lines[0]?.trim();
  const hasPinnedLine = pinnedLine === "<!-- pinned: true -->" || pinnedLine === "<!-- pinned: false -->";
  const pinned = pinnedLine === "<!-- pinned: true -->";
  const titleLineIndex = hasPinnedLine ? 1 : 0;
  const first = lines[titleLineIndex] ?? "";

  if (!first.trimStart().startsWith("#")) {
    return {
      id,
      title: id,
      body: (hasPinnedLine ? lines.slice(1).join("\n") : markdown).trim(),
      pinned
    };
  }

  const match = first.match(/^#\s*(.*)$/);
  const title = (match?.[1] ?? "").trim();

  return {
    id,
    title,
    body: lines.slice(titleLineIndex + 1).join("\n").trimStart(),
    pinned
  };
};

const markdownBodyToContent = (body: string): DocContent => {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const content = lines.map((line) => {
    if (line.trim() === "") {
      return { type: "paragraph" };
    }

    return {
      type: "paragraph",
      content: [{ type: "text", text: line }]
    };
  });

  return {
    type: "doc",
    content: content.length > 0 ? content : [{ type: "paragraph" }]
  };
};

const normalizeDocContent = (value: unknown): DocContent => {
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "doc") {
    return value as DocContent;
  }

  return {
    type: "doc",
    content: [{ type: "paragraph" }]
  };
};

const rowToDoc = (row: DocRow): Doc => {
  let parsed: unknown = null;

  try {
    parsed = JSON.parse(row.content_json);
  } catch {
    parsed = null;
  }

  return {
    id: row.id,
    title: row.title,
    content: normalizeDocContent(parsed),
    pinned: row.pinned === 1
  };
};

const parseSubtasks = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
};

const parseSubtasksJson = (value: string): string[] => {
  try {
    const parsed = JSON.parse(value);
    return parseSubtasks(parsed);
  } catch {
    return [];
  }
};

const parseCompletedSubtaskIndexesJson = (value: string): number[] => {
  try {
    const parsed = JSON.parse(value);

    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((item) => (typeof item === "number" && Number.isInteger(item) ? item : -1))
      .filter((item) => item >= 0);
  } catch {
    return [];
  }
};

const rowToRoutineTask = (row: RoutineTaskRow): RoutineTask => {
  return {
    id: row.id,
    title: row.title,
    timeOfDay: row.time_of_day,
    weekdayMask: row.weekday_mask,
    sortOrder: row.sort_order,
    active: row.active === 1,
    subtasks: parseSubtasksJson(row.subtasks_json)
  };
};

const getTableColumns = (database: DatabaseSync, tableName: string): Set<string> => {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

const isSafeId = (id: string): boolean => /^[a-z0-9-]+$/i.test(id);

const isValidTimeOfDay = (value: string): boolean => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

const timeToMinutes = (value: string): number => {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }

  return hours * 60 + minutes;
};

const toLocalDateKey = (date: Date): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const toLocalTimeKey = (date: Date): string => {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
};

const collectText = (value: unknown): string => {
  if (!value) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map((item) => collectText(item)).join(" ").trim();
  }

  if (typeof value !== "object") {
    return "";
  }

  const node = value as { type?: unknown; text?: unknown; content?: unknown[] };
  const nodeType = typeof node.type === "string" ? node.type : "";

  if (nodeType === "taskItem" || nodeType === "taskList") {
    return "";
  }

  const ownText = typeof node.text === "string" ? node.text : "";
  const contentText = node.content ? collectText(node.content) : "";
  return `${ownText} ${contentText}`.replace(/\s+/g, " ").trim();
};

const extractUncheckedTasksFromContent = (value: unknown): string[] => {
  const tasks: string[] = [];

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      node.forEach((child) => walk(child));
      return;
    }

    const item = node as { type?: unknown; attrs?: unknown; content?: unknown[] };
    const itemType = typeof item.type === "string" ? item.type : "";

    if (itemType === "taskItem") {
      const attrs = item.attrs as { checked?: unknown } | undefined;
      const checked = attrs?.checked === true;

      if (!checked) {
        const label = collectText(item.content).trim();

        if (label) {
          tasks.push(label);
        }
      }
    }

    if (item.content) {
      item.content.forEach((child) => walk(child));
    }
  };

  walk(value);
  return tasks;
};

const findNextUncheckedTodo = (database: DatabaseSync): { docId: string; docTitle: string; text: string } | null => {
  const rows = database
    .prepare("SELECT id, title, content_json FROM documents ORDER BY pinned DESC, updated_at DESC, title COLLATE NOCASE ASC")
    .all() as Array<{ id: string; title: string; content_json: string }>;

  for (const row of rows) {
    let parsed: unknown = null;

    try {
      parsed = JSON.parse(row.content_json);
    } catch {
      parsed = null;
    }

    const tasks = extractUncheckedTasksFromContent(parsed);

    if (tasks.length > 0) {
      return {
        docId: row.id,
        docTitle: row.title,
        text: tasks[0]
      };
    }
  }

  return null;
};

const resolveNextTask = (database: DatabaseSync): NextTaskResponse => {
  const now = new Date();
  const dateKey = toLocalDateKey(now);
  const timeKey = toLocalTimeKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const dayBit = 1 << now.getDay();

  const routineRows = database
    .prepare(
      "SELECT id, title, time_of_day, weekday_mask, sort_order, active, subtasks_json FROM routine_tasks WHERE active = 1 AND (weekday_mask & ?) != 0 ORDER BY time_of_day ASC, sort_order ASC, title COLLATE NOCASE ASC"
    )
    .all(dayBit) as RoutineTaskRow[];

  const completedRows = database
    .prepare("SELECT routine_task_id, completed_subtasks_json FROM routine_task_completions WHERE completion_date = ?")
    .all(dateKey) as RoutineTaskCompletionRow[];

  const completionByRoutine = new Map<string, Set<number>>();

  completedRows.forEach((row) => {
    completionByRoutine.set(row.routine_task_id, new Set(parseCompletedSubtaskIndexesJson(row.completed_subtasks_json)));
  });

  const pendingRoutine = routineRows
    .map((row) => rowToRoutineTask(row))
    .map((item) => {
      const completed = completionByRoutine.get(item.id) ?? new Set<number>();
      const totalSubtaskCount = item.subtasks.length;
      const boundedCompleted = new Set([...completed].filter((index) => index >= 0 && index < totalSubtaskCount));
      const isComplete =
        totalSubtaskCount === 0
          ? completionByRoutine.has(item.id)
          : item.subtasks.every((_, index) => boundedCompleted.has(index));
      const nextSubtaskIndex = totalSubtaskCount === 0 ? -1 : item.subtasks.findIndex((_, index) => !boundedCompleted.has(index));
      return {
        ...item,
        isComplete,
        completedSubtaskCount: boundedCompleted.size,
        totalSubtaskCount,
        nextSubtaskIndex: nextSubtaskIndex >= 0 ? nextSubtaskIndex : null
      };
    })
    .filter((item) => !item.isComplete);

  const upcoming = pendingRoutine.map((item) => ({
    routineTaskId: item.id,
    title: item.title,
    timeOfDay: item.timeOfDay,
    due: timeToMinutes(item.timeOfDay) <= nowMinutes,
    subtaskText: item.nextSubtaskIndex === null ? null : item.subtasks[item.nextSubtaskIndex] ?? null,
    subtaskIndex: item.nextSubtaskIndex,
    completedSubtaskCount: item.completedSubtaskCount,
    totalSubtaskCount: item.totalSubtaskCount
  }));

  const dueRoutine = upcoming.find((item) => item.due);

  if (dueRoutine) {
    return {
      currentTime: timeKey,
      nextTask: {
        source: "routine",
        routineTaskId: dueRoutine.routineTaskId,
        title: dueRoutine.title,
        timeOfDay: dueRoutine.timeOfDay,
        due: true,
        subtaskText: dueRoutine.subtaskText,
        subtaskIndex: dueRoutine.subtaskIndex,
        completedSubtaskCount: dueRoutine.completedSubtaskCount,
        totalSubtaskCount: dueRoutine.totalSubtaskCount
      },
      upcoming
    };
  }

  const todo = findNextUncheckedTodo(database);

  if (todo) {
    return {
      currentTime: timeKey,
      nextTask: {
        source: "todo",
        docId: todo.docId,
        docTitle: todo.docTitle,
        text: todo.text
      },
      upcoming
    };
  }

  const nextUpcomingRoutine = upcoming[0] ?? null;

  return {
    currentTime: timeKey,
    nextTask: nextUpcomingRoutine
      ? {
          source: "routine",
          routineTaskId: nextUpcomingRoutine.routineTaskId,
          title: nextUpcomingRoutine.title,
          timeOfDay: nextUpcomingRoutine.timeOfDay,
          due: false,
          subtaskText: nextUpcomingRoutine.subtaskText,
          subtaskIndex: nextUpcomingRoutine.subtaskIndex,
          completedSubtaskCount: nextUpcomingRoutine.completedSubtaskCount,
          totalSubtaskCount: nextUpcomingRoutine.totalSubtaskCount
        }
      : null,
    upcoming
  };
};

let db: DatabaseSync | null = null;

const setupDb = async (): Promise<DatabaseSync> => {
  if (db) {
    return db;
  }

  await mkdir(dataDir, { recursive: true });
  const nextDb = new DatabaseSync(dbPath);

  nextDb.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content_json TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS routine_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      time_of_day TEXT NOT NULL,
      weekday_mask INTEGER NOT NULL DEFAULT 127,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      subtasks_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS routine_task_completions (
      routine_task_id TEXT NOT NULL,
      completion_date TEXT NOT NULL,
      completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_subtasks_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (routine_task_id, completion_date)
    );

    CREATE INDEX IF NOT EXISTS idx_routine_tasks_active_time ON routine_tasks (active, time_of_day, sort_order);
    CREATE INDEX IF NOT EXISTS idx_routine_completion_date ON routine_task_completions (completion_date);
  `);

  const routineTaskColumns = getTableColumns(nextDb, "routine_tasks");

  if (!routineTaskColumns.has("subtasks_json")) {
    nextDb.exec("ALTER TABLE routine_tasks ADD COLUMN subtasks_json TEXT NOT NULL DEFAULT '[]'");
  }

  const routineCompletionColumns = getTableColumns(nextDb, "routine_task_completions");

  if (!routineCompletionColumns.has("completed_subtasks_json")) {
    nextDb.exec("ALTER TABLE routine_task_completions ADD COLUMN completed_subtasks_json TEXT NOT NULL DEFAULT '[]'");
  }

  const countRow = nextDb.prepare("SELECT COUNT(*) as count FROM documents").get() as { count: number };

  if (countRow.count === 0) {
    let files: Array<{ isFile: () => boolean; name: string }> = [];

    try {
      files = await readdir(docsDir, { withFileTypes: true });
    } catch {
      files = [];
    }

    const insertStatement = nextDb.prepare(
      "INSERT OR IGNORE INTO documents (id, title, content_json, pinned) VALUES (?, ?, ?, ?)"
    );

    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const id = entry.name.slice(0, -3);

      if (!isSafeId(id)) {
        continue;
      }

      const markdown = await readFile(path.join(docsDir, entry.name), "utf8");
      const parsed = parseMarkdown(id, markdown);
      const content = markdownBodyToContent(parsed.body);

      insertStatement.run(parsed.id, parsed.title, JSON.stringify(content), parsed.pinned ? 1 : 0);
    }
  }

  db = nextDb;
  return nextDb;
};

export const docsApiPlugin = (): PluginOption => ({
  name: "docs-api",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const method = req.method || "GET";
      const rawUrl = req.url || "";
      const pathname = rawUrl.split("?")[0] || "";

      if (!pathname.startsWith("/api/")) {
        return next();
      }

      try {
        const database = await setupDb();

        if (pathname.startsWith("/api/documents")) {
          if (method === "GET" && pathname === "/api/documents") {
            const rows = database
              .prepare("SELECT id, title, pinned FROM documents ORDER BY pinned DESC, title COLLATE NOCASE ASC")
              .all() as Array<{ id: string; title: string; pinned: number }>;

            const docs = rows.map((row) => ({
              id: row.id,
              title: row.title,
              pinned: row.pinned === 1
            }));

            return sendJson(res, 200, docs);
          }

          if (method === "POST" && pathname === "/api/documents") {
            const payload = (await readRequestBody(req)) as { title?: unknown };
            const title = typeof payload.title === "string" ? payload.title : "";
            const id = randomUUID();
            const content: DocContent = { type: "doc", content: [{ type: "paragraph" }] };

            database
              .prepare("INSERT INTO documents (id, title, content_json, pinned) VALUES (?, ?, ?, ?)")
              .run(id, title, JSON.stringify(content), 0);

            return sendJson(res, 201, { id, title, content, pinned: false });
          }

          const match = pathname.match(/^\/api\/documents\/([a-z0-9-]+)$/i);

          if (!match) {
            return sendJson(res, 404, { error: "Not found" });
          }

          const id = decodeURIComponent(match[1]);

          if (!isSafeId(id)) {
            return sendJson(res, 400, { error: "Invalid id" });
          }

          if (method === "GET") {
            const row = database
              .prepare("SELECT id, title, content_json, pinned FROM documents WHERE id = ?")
              .get(id) as DocRow | undefined;

            if (!row) {
              return sendJson(res, 404, { error: "Not found" });
            }

            return sendJson(res, 200, rowToDoc(row));
          }

          if (method === "PUT") {
            const row = database
              .prepare("SELECT id, title, content_json, pinned FROM documents WHERE id = ?")
              .get(id) as DocRow | undefined;

            if (!row) {
              return sendJson(res, 404, { error: "Not found" });
            }

            const payload = (await readRequestBody(req)) as { title?: unknown; content?: unknown; pinned?: unknown };
            const existing = rowToDoc(row);
            const nextTitle = typeof payload.title === "string" ? payload.title : existing.title;
            const nextContent = payload.content !== undefined ? normalizeDocContent(payload.content) : existing.content;
            const nextPinned = payload.pinned === true;

            database
              .prepare("UPDATE documents SET title = ?, content_json = ?, pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
              .run(nextTitle, JSON.stringify(nextContent), nextPinned ? 1 : 0, id);

            return sendJson(res, 200, { id, title: nextTitle, content: nextContent, pinned: nextPinned });
          }

          if (method === "DELETE") {
            const result = database.prepare("DELETE FROM documents WHERE id = ?").run(id) as { changes?: number };

            if (!result.changes) {
              return sendJson(res, 404, { error: "Not found" });
            }

            return sendJson(res, 200, { id });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        }

        if (pathname.startsWith("/api/routines")) {
          if (method === "GET" && pathname === "/api/routines") {
            const rows = database
              .prepare(
                "SELECT id, title, time_of_day, weekday_mask, sort_order, active, subtasks_json FROM routine_tasks ORDER BY time_of_day ASC, sort_order ASC, title COLLATE NOCASE ASC"
              )
              .all() as RoutineTaskRow[];

            return sendJson(
              res,
              200,
              rows.map((row) => rowToRoutineTask(row))
            );
          }

          if (method === "POST" && pathname === "/api/routines") {
            const payload = (await readRequestBody(req)) as {
              title?: unknown;
              timeOfDay?: unknown;
              weekdayMask?: unknown;
              sortOrder?: unknown;
              active?: unknown;
              subtasks?: unknown;
            };
            const title = typeof payload.title === "string" ? payload.title.trim() : "";
            const timeOfDay = typeof payload.timeOfDay === "string" ? payload.timeOfDay : "";
            const weekdayMask = typeof payload.weekdayMask === "number" ? payload.weekdayMask : 127;
            const active = payload.active === false ? 0 : 1;
            const subtasks = parseSubtasks(payload.subtasks);

            if (!title) {
              return sendJson(res, 400, { error: "Title is required" });
            }

            if (!isValidTimeOfDay(timeOfDay)) {
              return sendJson(res, 400, { error: "timeOfDay must be HH:MM" });
            }

            const nextOrderRow = database
              .prepare("SELECT COALESCE(MAX(sort_order), -1) AS max_order FROM routine_tasks WHERE time_of_day = ?")
              .get(timeOfDay) as { max_order: number };
            const sortOrder =
              typeof payload.sortOrder === "number" && Number.isFinite(payload.sortOrder)
                ? Math.trunc(payload.sortOrder)
                : nextOrderRow.max_order + 1;
            const id = randomUUID();

            database
              .prepare(
                "INSERT INTO routine_tasks (id, title, time_of_day, weekday_mask, sort_order, active, subtasks_json) VALUES (?, ?, ?, ?, ?, ?, ?)"
              )
              .run(id, title, timeOfDay, Math.max(0, Math.min(127, Math.trunc(weekdayMask))), sortOrder, active, JSON.stringify(subtasks));

            return sendJson(res, 201, {
              id,
              title,
              timeOfDay,
              weekdayMask: Math.max(0, Math.min(127, Math.trunc(weekdayMask))),
              sortOrder,
              active: active === 1,
              subtasks
            });
          }

          const match = pathname.match(/^\/api\/routines\/([a-z0-9-]+)$/i);

          if (!match) {
            return sendJson(res, 404, { error: "Not found" });
          }

          const id = decodeURIComponent(match[1]);

          if (!isSafeId(id)) {
            return sendJson(res, 400, { error: "Invalid id" });
          }

          const existingRow = database
            .prepare("SELECT id, title, time_of_day, weekday_mask, sort_order, active, subtasks_json FROM routine_tasks WHERE id = ?")
            .get(id) as RoutineTaskRow | undefined;

          if (!existingRow) {
            return sendJson(res, 404, { error: "Not found" });
          }

          if (method === "PUT") {
            const payload = (await readRequestBody(req)) as {
              title?: unknown;
              timeOfDay?: unknown;
              weekdayMask?: unknown;
              sortOrder?: unknown;
              active?: unknown;
              subtasks?: unknown;
            };

            const nextTitle = typeof payload.title === "string" ? payload.title.trim() : existingRow.title;
            const nextTimeOfDay = typeof payload.timeOfDay === "string" ? payload.timeOfDay : existingRow.time_of_day;
            const nextWeekdayMask =
              typeof payload.weekdayMask === "number"
                ? Math.max(0, Math.min(127, Math.trunc(payload.weekdayMask)))
                : existingRow.weekday_mask;
            const nextSortOrder =
              typeof payload.sortOrder === "number" && Number.isFinite(payload.sortOrder)
                ? Math.trunc(payload.sortOrder)
                : existingRow.sort_order;
            const nextActive = payload.active === undefined ? existingRow.active : payload.active === true ? 1 : 0;
            const nextSubtasks = payload.subtasks === undefined ? parseSubtasksJson(existingRow.subtasks_json) : parseSubtasks(payload.subtasks);

            if (!nextTitle) {
              return sendJson(res, 400, { error: "Title is required" });
            }

            if (!isValidTimeOfDay(nextTimeOfDay)) {
              return sendJson(res, 400, { error: "timeOfDay must be HH:MM" });
            }

            database
              .prepare(
                "UPDATE routine_tasks SET title = ?, time_of_day = ?, weekday_mask = ?, sort_order = ?, active = ?, subtasks_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
              )
              .run(nextTitle, nextTimeOfDay, nextWeekdayMask, nextSortOrder, nextActive, JSON.stringify(nextSubtasks), id);

            return sendJson(res, 200, {
              id,
              title: nextTitle,
              timeOfDay: nextTimeOfDay,
              weekdayMask: nextWeekdayMask,
              sortOrder: nextSortOrder,
              active: nextActive === 1,
              subtasks: nextSubtasks
            });
          }

          if (method === "DELETE") {
            database.prepare("DELETE FROM routine_task_completions WHERE routine_task_id = ?").run(id);
            const result = database.prepare("DELETE FROM routine_tasks WHERE id = ?").run(id) as { changes?: number };

            if (!result.changes) {
              return sendJson(res, 404, { error: "Not found" });
            }

            return sendJson(res, 200, { id });
          }

          return sendJson(res, 405, { error: "Method not allowed" });
        }

        if (pathname === "/api/next-task" && method === "GET") {
          return sendJson(res, 200, resolveNextTask(database));
        }

        if (pathname === "/api/next-task/complete" && method === "POST") {
          const payload = (await readRequestBody(req)) as {
            source?: unknown;
            routineTaskId?: unknown;
            subtaskIndex?: unknown;
            completeAll?: unknown;
          };

          if (payload.source !== "routine") {
            return sendJson(res, 400, { error: "Only routine completion is supported" });
          }

          const routineTaskId = typeof payload.routineTaskId === "string" ? payload.routineTaskId : "";

          if (!routineTaskId || !isSafeId(routineTaskId)) {
            return sendJson(res, 400, { error: "Invalid routineTaskId" });
          }

          const routineRow = database
            .prepare("SELECT id, subtasks_json FROM routine_tasks WHERE id = ?")
            .get(routineTaskId) as { id: string; subtasks_json: string } | undefined;

          if (!routineRow) {
            return sendJson(res, 404, { error: "Routine task not found" });
          }

          const dateKey = toLocalDateKey(new Date());
          const subtaskIndex =
            typeof payload.subtaskIndex === "number" && Number.isInteger(payload.subtaskIndex) ? payload.subtaskIndex : null;
          const completeAll = payload.completeAll === true;
          const subtasks = parseSubtasksJson(routineRow.subtasks_json);
          const totalSubtaskCount = subtasks.length;

          if (subtaskIndex !== null && (subtaskIndex < 0 || subtaskIndex >= totalSubtaskCount)) {
            return sendJson(res, 400, { error: "Invalid subtaskIndex" });
          }

          const existingCompletion = database
            .prepare(
              "SELECT completed_subtasks_json FROM routine_task_completions WHERE routine_task_id = ? AND completion_date = ?"
            )
            .get(routineTaskId, dateKey) as { completed_subtasks_json: string } | undefined;

          const nextCompletedSet = new Set(
            existingCompletion ? parseCompletedSubtaskIndexesJson(existingCompletion.completed_subtasks_json) : []
          );

          if (completeAll || totalSubtaskCount === 0) {
            for (let index = 0; index < totalSubtaskCount; index += 1) {
              nextCompletedSet.add(index);
            }
          } else if (subtaskIndex !== null) {
            nextCompletedSet.add(subtaskIndex);
          }

          database
            .prepare(
              "INSERT OR REPLACE INTO routine_task_completions (routine_task_id, completion_date, completed_at, completed_subtasks_json) VALUES (?, ?, CURRENT_TIMESTAMP, ?)"
            )
            .run(routineTaskId, dateKey, JSON.stringify([...nextCompletedSet].sort((a, b) => a - b)));

          return sendJson(res, 200, { ok: true });
        }

        return sendJson(res, 404, { error: "Not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        return sendJson(res, 500, { error: message });
      }
    });
  }
});
