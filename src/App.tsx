import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { DocumentContextMenu } from "./components/DocumentContextMenu";
import { EditorPanel } from "./components/EditorPanel";
import { Sidebar } from "./components/Sidebar";
import type { ContextMenuState, Doc, DocSummary } from "./types/documents";

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

export default function App() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(getDocumentIdFromPath);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [focusTitleToken, setFocusTitleToken] = useState(0);

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
      body: JSON.stringify({ title: "" })
    });

    setDocs((current) => [...current, { id: created.id, title: created.title, pinned: created.pinned }]);
    selectDocument(created.id);
    setDoc(created);
    setFocusTitleToken((current) => current + 1);
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

  const contextTarget = contextMenu ? docs.find((item) => item.id === contextMenu.docId) ?? null : null;

  return (
    <div className="relative h-screen">
      <Sidebar
        docs={docs}
        selectedId={selectedId}
        loading={loading}
        onCreateDocument={() => {
          void createDocument();
        }}
        onSelectDocument={selectDocument}
        onOpenContextMenu={openContextMenu}
      />

      <main className="relative flex h-full justify-center p-4">
        <EditorPanel
          doc={doc}
          loading={loading}
          onChangeTitle={(title) => setDoc((current) => (current ? { ...current, title } : current))}
          onChangeBody={(body) => setDoc((current) => (current ? { ...current, body } : current))}
          focusTitleToken={focusTitleToken}
        />
      </main>

      {contextMenu ? (
        <DocumentContextMenu
          contextMenu={contextMenu}
          contextTarget={contextTarget}
          onTogglePinned={(docId, pinned) => {
            setContextMenu(null);
            void setPinnedState(docId, pinned);
          }}
          onDelete={(docId) => {
            setContextMenu(null);
            void deleteDocument(docId);
          }}
        />
      ) : null}
    </div>
  );
}
