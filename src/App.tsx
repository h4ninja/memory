import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Extension } from "@tiptap/core";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";

type DocSummary = {
  id: string;
  title: string;
  pinned: boolean;
};

type Doc = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
};

type ContextMenuState = {
  docId: string;
  x: number;
  y: number;
};

const getDocumentIdFromPath = (): string | null => {
  if (typeof window === "undefined") {
    return null;
  }

  const match = window.location.pathname.match(/^\/documents\/([^/]+)$/);

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

const getDocumentPath = (docId: string | null): string => {
  if (!docId) {
    return "/";
  }

  return `/documents/${encodeURIComponent(docId)}`;
};

const fetchJson = async <T,>(input: RequestInfo, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json"
    },
    ...init
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
};

type BodyEditorProps = {
  docId: string;
  markdown: string;
  onChange: (nextMarkdown: string) => void;
  onRegisterFocus: (focusEditor: () => void) => void;
};

type JsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
};

const CheckboxShortcut = Extension.create({
  name: "checkboxShortcut",
  addKeyboardShortcuts() {
    return {
      "Shift-Mod-c": () => this.editor.commands.toggleTaskList()
    };
  }
});

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const markdownToEditorHtml = (markdown: string): string => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const htmlParts: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^- \[( |x|X)\]\s+/.test(line)) {
      const taskItems: string[] = [];

      while (index < lines.length && /^- \[( |x|X)\]\s+/.test(lines[index])) {
        const isChecked = /^- \[(x|X)\]\s+/.test(lines[index]);
        const itemText = lines[index].replace(/^- \[( |x|X)\]\s+/, "");
        taskItems.push(
          `<li data-type="taskItem" data-checked="${isChecked ? "true" : "false"}"><p>${escapeHtml(itemText)}</p></li>`
        );
        index += 1;
      }

      htmlParts.push(`<ul data-type="taskList">${taskItems.join("")}</ul>`);
      continue;
    }

    if (/^-\s+/.test(line)) {
      const listItems: string[] = [];

      while (index < lines.length && /^-\s+/.test(lines[index])) {
        const itemText = lines[index].replace(/^-\s+/, "");
        listItems.push(`<li><p>${escapeHtml(itemText)}</p></li>`);
        index += 1;
      }

      htmlParts.push(`<ul>${listItems.join("")}</ul>`);
      continue;
    }

    if (line.trim() === "") {
      htmlParts.push("<p><br></p>");
      index += 1;
      continue;
    }

    htmlParts.push(`<p>${escapeHtml(line)}</p>`);
    index += 1;
  }

  return htmlParts.join("");
};

const flattenText = (node?: JsonNode): string => {
  if (!node) {
    return "";
  }

  if (node.type === "text") {
    return node.text ?? "";
  }

  if (!node.content || node.content.length === 0) {
    return "";
  }

  return node.content.map((child) => flattenText(child)).join("");
};

const editorJsonToMarkdown = (docJson: JsonNode): string => {
  const lines: string[] = [];

  for (const node of docJson.content ?? []) {
    if (node.type === "paragraph") {
      const text = flattenText(node);
      lines.push(text.trim() === "" ? "" : text);
      continue;
    }

    if (node.type === "bulletList") {
      for (const item of node.content ?? []) {
        if (item.type !== "listItem") {
          continue;
        }

        const text = flattenText(item).replace(/\n+/g, " ").trim();
        lines.push(`- ${text}`);
      }
      continue;
    }

    if (node.type === "taskList") {
      for (const item of node.content ?? []) {
        if (item.type !== "taskItem") {
          continue;
        }

        const checked = item.attrs?.checked === true;
        const text = flattenText(item).replace(/\n+/g, " ").trim();
        lines.push(`- [${checked ? "x" : " "}] ${text}`);
      }
      continue;
    }

    lines.push(flattenText(node));
  }

  return lines.join("\n").replace(/\s+$/g, "");
};

function BodyEditor({ docId, markdown, onChange, onRegisterFocus }: BodyEditorProps) {
  const initialHtml = useMemo(() => markdownToEditorHtml(markdown), [markdown]);

  const editor = useEditor(
    {
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: false }), CheckboxShortcut],
      content: initialHtml,
      editorProps: {
        attributes: {
          class: "editor-content h-full px-3 py-2 font-light outline-none"
        }
      },
      onUpdate: ({ editor: currentEditor }) => {
        const nextMarkdown = editorJsonToMarkdown(currentEditor.getJSON() as JsonNode);
        onChange(nextMarkdown);
      }
    },
    [docId]
  );

  useEffect(() => {
    if (!editor) {
      return;
    }

    onRegisterFocus(() => {
      editor.commands.focus("end");
    });
  }, [editor, onRegisterFocus]);

  return <EditorContent editor={editor} className="min-h-0 flex-1" />;
}

export default function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(getDocumentIdFromPath);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const bodyFocusRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const loadDocs = async () => {
      setLoading(true);
      const list = await fetchJson<DocSummary[]>("/api/documents");
      setDocs(list);

      setSelectedId((current) => {
        if (current && list.some((item) => item.id === current)) {
          return current;
        }

        return list[0]?.id ?? null;
      });

      setLoading(false);
    };

    loadDocs().catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDoc(null);
      return;
    }

    fetchJson<Doc>(`/api/documents/${selectedId}`)
      .then(setDoc)
      .catch(() => setDoc(null));
  }, [selectedId]);

  useEffect(() => {
    if (!doc) {
      return;
    }

    const timeout = window.setTimeout(async () => {
      await fetchJson<Doc>(`/api/documents/${doc.id}`, {
        method: "PUT",
        body: JSON.stringify({ title: doc.title, body: doc.body, pinned: doc.pinned })
      });

      setDocs((current) =>
        current.map((item) =>
          item.id === doc.id ? { ...item, title: doc.title || "Untitled", pinned: doc.pinned } : item
        )
      );
    }, 350);

    return () => window.clearTimeout(timeout);
  }, [doc]);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("click", closeMenu);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);
    window.addEventListener("keydown", closeOnEscape);

    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      setSelectedId(getDocumentIdFromPath());
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    const nextPath = getDocumentPath(selectedId);

    if (window.location.pathname !== nextPath) {
      window.history.replaceState(null, "", nextPath);
    }
  }, [selectedId]);

  const selectDocument = (docId: string, historyMode: "push" | "replace" = "push") => {
    const nextPath = getDocumentPath(docId);

    if (window.location.pathname !== nextPath) {
      if (historyMode === "push") {
        window.history.pushState(null, "", nextPath);
      } else {
        window.history.replaceState(null, "", nextPath);
      }
    }

    setSelectedId(docId);
  };

  const createDocument = async () => {
    const created = await fetchJson<Doc>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ title: "Untitled" })
    });

    setDocs((current) => [...current, { id: created.id, title: created.title, pinned: created.pinned }]);
    selectDocument(created.id);
    setDoc(created);
  };

  const setPinnedState = async (targetId: string, pinned: boolean) => {
    const target = docs.find((item) => item.id === targetId);

    if (!target) {
      return;
    }

    const targetDoc =
      doc?.id === targetId
        ? doc
        : await fetchJson<Doc>(`/api/documents/${targetId}`).catch(() => null);

    if (!targetDoc) {
      return;
    }

    await fetchJson<Doc>(`/api/documents/${targetId}`, {
      method: "PUT",
      body: JSON.stringify({ title: targetDoc.title, body: targetDoc.body, pinned })
    });

    setDocs((current) => current.map((item) => (item.id === targetId ? { ...item, pinned } : item)));

    if (doc?.id === targetId) {
      setDoc((current) => (current ? { ...current, pinned } : current));
    }
  };

  const deleteDocument = async (targetId: string) => {
    const target = docs.find((item) => item.id === targetId);

    if (!target) {
      return;
    }

    if (!window.confirm(`Delete \"${target.title || "Untitled"}\"?`)) {
      return;
    }

    await fetchJson<{ id: string }>(`/api/documents/${targetId}`, {
      method: "DELETE"
    });

    setDocs((current) => {
      const currentIndex = current.findIndex((item) => item.id === targetId);

      if (currentIndex < 0) {
        return current;
      }

      const next = current.filter((item) => item.id !== targetId);

      if (selectedId === targetId) {
        const nextSelected = next[currentIndex] ?? next[currentIndex - 1] ?? null;

        if (nextSelected) {
          selectDocument(nextSelected.id, "replace");
        } else {
          setSelectedId(null);
        }
      }

      return next;
    });

    if (doc?.id === targetId) {
      setDoc(null);
    }
  };

  const openContextMenu = (event: ReactMouseEvent<HTMLButtonElement>, docId: string) => {
    event.preventDefault();
    const menuWidth = 176;
    const menuHeight = 48;
    const offset = 6;
    const x = Math.min(event.clientX + offset, window.innerWidth - menuWidth - offset);
    const y = Math.min(event.clientY + offset, window.innerHeight - menuHeight - offset);
    setContextMenu({ docId, x, y });
  };

  const pinnedDocs = docs.filter((item) => item.pinned);
  const unpinnedDocs = docs.filter((item) => !item.pinned);
  const contextTarget = contextMenu ? docs.find((item) => item.id === contextMenu.docId) ?? null : null;

  return (
    <div className="relative h-screen">
      <div className="group absolute left-0 top-0 z-20 h-screen w-64">
        <aside className="pointer-events-none absolute left-0 top-0 h-screen w-64 bg-white p-3 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
          <button
            type="button"
            className="mb-8 flex h-9 w-9 items-center justify-center rounded-full border border-gray-300 bg-gray-100 text-lg text-gray-700 transition-opacity hover:opacity-70"
            onClick={createDocument}
            aria-label="New document"
          >
            +
          </button>

          <div>
            {pinnedDocs.map((item) => (
              <div key={item.id} className="mb-1">
                <button
                  type="button"
                  className={`block w-full truncate px-2 py-2 text-left text-sm ${
                    item.id === selectedId ? "text-blue-500" : ""
                  }`}
                  onClick={() => selectDocument(item.id)}
                  onContextMenu={(event) => openContextMenu(event, item.id)}
                >
                  {item.title || "Untitled"}
                </button>
              </div>
            ))}

            {pinnedDocs.length > 0 && unpinnedDocs.length > 0 ? <hr className="my-3 border-gray-200" /> : null}

            {unpinnedDocs.map((item) => (
              <div key={item.id} className="mb-1">
                <button
                  type="button"
                  className={`block w-full truncate px-2 py-2 text-left text-sm ${
                    item.id === selectedId ? "text-blue-500" : ""
                  }`}
                  onClick={() => selectDocument(item.id)}
                  onContextMenu={(event) => openContextMenu(event, item.id)}
                >
                  {item.title || "Untitled"}
                </button>
              </div>
            ))}

            {!loading && docs.length === 0 ? <p className="text-sm text-gray-500">No documents yet.</p> : null}
          </div>
        </aside>
      </div>

      <main className="relative flex h-full justify-center p-4">
        {!doc ? (
          <p className="w-full max-w-[700px] text-sm text-gray-500">{loading ? "Loading..." : "Select or create a document."}</p>
        ) : (
          <div className="flex h-full w-full max-w-[700px] flex-col pt-10">
            <input
              className="mb-3 rounded px-3 py-2 text-3xl font-bold outline-none"
              value={doc.title}
              onChange={(event) => setDoc((current) => (current ? { ...current, title: event.target.value } : current))}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  bodyFocusRef.current?.();
                }
              }}
              placeholder="Title"
            />

            <BodyEditor
              docId={doc.id}
              markdown={doc.body}
              onRegisterFocus={(focusEditor) => {
                bodyFocusRef.current = focusEditor;
              }}
              onChange={(nextBody) =>
                setDoc((current) => (current ? { ...current, body: nextBody } : current))
              }
            />
          </div>
        )}
      </main>

      {contextMenu ? (
        <div
          className="fixed z-50 min-w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextTarget ? (
            <button
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
              onClick={() => {
                setContextMenu(null);
                void setPinnedState(contextTarget.id, !contextTarget.pinned);
              }}
            >
              {contextTarget.pinned ? "Unpin" : "Pin"}
            </button>
          ) : null}

          <button
            type="button"
            className="block w-full px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-gray-100"
            onClick={() => {
              setContextMenu(null);
              void deleteDocument(contextMenu.docId);
            }}
          >
            Delete document
          </button>
        </div>
      ) : null}
    </div>
  );
}
