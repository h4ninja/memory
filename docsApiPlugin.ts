import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { PluginOption } from "vite";

type Doc = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
};

const docsDir = path.resolve(process.cwd(), "documents");

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

const parseMarkdown = (id: string, markdown: string): Doc => {
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

const toMarkdown = (title: string, body: string, pinned: boolean): string => {
  const safeTitle = title.replace(/\r?\n/g, " ").trim();
  return `<!-- pinned: ${pinned ? "true" : "false"} -->\n# ${safeTitle}\n\n${body}`;
};

const isSafeId = (id: string): boolean => /^[a-z0-9-]+$/i.test(id);
const isUuidV4 = (id: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

const createDocumentId = (): string => randomUUID();

const migrateDocumentIdsToUuidV4 = async () => {
  const entries = await readdir(docsDir, { withFileTypes: true });

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map(async (entry) => {
        const currentId = entry.name.slice(0, -3);

        if (isUuidV4(currentId)) {
          return;
        }

        const nextId = createDocumentId();
        const currentPath = path.join(docsDir, entry.name);
        const nextPath = path.join(docsDir, `${nextId}.md`);
        await rename(currentPath, nextPath);
      })
  );
};

export const docsApiPlugin = (): PluginOption => ({
  name: "docs-api",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const method = req.method || "GET";
      const url = req.url || "";

      if (!url.startsWith("/api/documents")) {
        return next();
      }

      await mkdir(docsDir, { recursive: true });
      await migrateDocumentIdsToUuidV4();

      try {
        if (method === "GET" && url === "/api/documents") {
          const files = await readdir(docsDir, { withFileTypes: true });

          const docs = await Promise.all(
            files
              .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
              .map(async (entry) => {
                const id = entry.name.slice(0, -3);
                const content = await readFile(path.join(docsDir, entry.name), "utf8");
                const parsed = parseMarkdown(id, content);

                return { id: parsed.id, title: parsed.title, pinned: parsed.pinned };
              })
          );

          docs.sort((a, b) => {
            if (a.pinned !== b.pinned) {
              return a.pinned ? -1 : 1;
            }

            return a.title.localeCompare(b.title);
          });
          return sendJson(res, 200, docs);
        }

        if (method === "POST" && url === "/api/documents") {
          const payload = (await readRequestBody(req)) as { title?: string };
          const title = typeof payload.title === "string" ? payload.title : "";
          const id = createDocumentId();
          const filePath = path.join(docsDir, `${id}.md`);

          await writeFile(filePath, toMarkdown(title, "", false), "utf8");
          return sendJson(res, 201, { id, title, body: "", pinned: false });
        }

        const match = url.match(/^\/api\/documents\/([a-z0-9-]+)$/i);

        if (!match) {
          return sendJson(res, 404, { error: "Not found" });
        }

        const id = decodeURIComponent(match[1]);

        if (!isSafeId(id)) {
          return sendJson(res, 400, { error: "Invalid id" });
        }

        const filePath = path.join(docsDir, `${id}.md`);

        if (method === "GET") {
          const content = await readFile(filePath, "utf8");
          const doc = parseMarkdown(id, content);
          return sendJson(res, 200, doc);
        }

        if (method === "PUT") {
          const payload = (await readRequestBody(req)) as { title?: string; body?: string; pinned?: boolean };
          const title = typeof payload.title === "string" ? payload.title : "";
          const body = typeof payload.body === "string" ? payload.body : "";
          const pinned = payload.pinned === true;

          await writeFile(filePath, toMarkdown(title, body, pinned), "utf8");
          return sendJson(res, 200, { id, title, body, pinned });
        }

        if (method === "DELETE") {
          await unlink(filePath);
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
