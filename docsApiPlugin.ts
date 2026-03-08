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

const isSafeId = (id: string): boolean => /^[a-z0-9-]+$/i.test(id);

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
    )
  `);

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

      if (!pathname.startsWith("/api/documents")) {
        return next();
      }

      try {
        const database = await setupDb();

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
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error";
        return sendJson(res, 500, { error: message });
      }
    });
  }
});
