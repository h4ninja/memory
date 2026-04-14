import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { DocumentContextMenu } from "./components/DocumentContextMenu";
import { EditorPanel } from "./components/EditorPanel";
import { NextTaskPage } from "./components/NextTaskPage";
import { RoutinesPage } from "./components/RoutinesPage";
import { Sidebar } from "./components/Sidebar";
import type { ContextMenuState, Doc, DocSummary } from "./types/documents";

type AppPage = "home" | "editor" | "next-task" | "routines";

const getRouteFromPath = (): { page: AppPage; docId: string | null } => {
  if (typeof window === "undefined") {
    return { page: "home", docId: null };
  }

  if (window.location.pathname === "/") {
    return { page: "home", docId: null };
  }

  if (window.location.pathname === "/next-task") {
    return { page: "next-task", docId: null };
  }

  if (window.location.pathname === "/routines") {
    return { page: "routines", docId: null };
  }

  const match = window.location.pathname.match(/^\/documents\/([^/]+)$/);

  if (!match) {
    return { page: "home", docId: null };
  }

  try {
    return { page: "editor", docId: decodeURIComponent(match[1]) };
  } catch {
    return { page: "home", docId: null };
  }
};

const getPathForPage = (page: AppPage, docId: string | null): string => {
  if (page === "home") {
    return "/";
  }

  if (page === "next-task") {
    return "/next-task";
  }

  if (page === "routines") {
    return "/routines";
  }

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
  const initialRoute = getRouteFromPath();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [currentPage, setCurrentPage] = useState<AppPage>(initialRoute.page);
  const [selectedId, setSelectedId] = useState<string | null>(initialRoute.docId);
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
        if (currentPage !== "editor") {
          return current;
        }

        if (current && list.some((item) => item.id === current)) {
          return current;
        }

        return list[0]?.id ?? null;
      });

      setLoading(false);
    };

    loadDocs().catch(() => setLoading(false));
  }, [currentPage]);

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
        body: JSON.stringify({ title: doc.title, content: doc.content, pinned: doc.pinned })
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
      const route = getRouteFromPath();
      setCurrentPage(route.page);
      setSelectedId(route.docId);
    };

    window.addEventListener("popstate", handlePopState);

    return () => {
      window.removeEventListener("popstate", handlePopState);
    };
  }, []);

  useEffect(() => {
    const nextPath = getPathForPage(currentPage, selectedId);

    if (window.location.pathname !== nextPath) {
      window.history.replaceState(null, "", nextPath);
    }
  }, [currentPage, selectedId]);

  const selectDocument = (docId: string, historyMode: "push" | "replace" = "push") => {
    const nextPath = getPathForPage("editor", docId);

    if (window.location.pathname !== nextPath) {
      if (historyMode === "push") {
        window.history.pushState(null, "", nextPath);
      } else {
        window.history.replaceState(null, "", nextPath);
      }
    }

    setCurrentPage("editor");
    setSelectedId(docId);
  };

  const navigateToPage = (page: AppPage) => {
    const nextPath = getPathForPage(page, selectedId);

    if (window.location.pathname !== nextPath) {
      window.history.pushState(null, "", nextPath);
    }

    setCurrentPage(page);
  };

  const createDocument = async (title = "") => {
    const created = await fetchJson<Doc>("/api/documents", {
      method: "POST",
      body: JSON.stringify({ title })
    });

    setDocs((current) => [...current, { id: created.id, title: created.title, pinned: created.pinned }]);
    return created;
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
      body: JSON.stringify({ title: targetDoc.title, content: targetDoc.content, pinned })
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
    <div className="relative h-screen overflow-hidden">
      <Sidebar
        docs={docs}
        selectedId={selectedId}
        loading={loading}
        currentPage={currentPage}
        onCreateDocument={() => {
          void createDocument().then((created) => {
            selectDocument(created.id);
            setDoc(created);
            setFocusTitleToken((current) => current + 1);
          });
        }}
        onOpenNextTask={() => navigateToPage("next-task")}
        onOpenRoutines={() => navigateToPage("routines")}
        onSelectDocument={selectDocument}
        onOpenContextMenu={openContextMenu}
      />

      <main className="relative flex h-screen justify-center overflow-y-auto p-4">
        {currentPage === "next-task" ? (
          <NextTaskPage
            onOpenDocument={(docId) => {
              selectDocument(docId);
            }}
          />
        ) : null}

        {currentPage === "routines" ? <RoutinesPage /> : null}

        {currentPage === "editor" ? (
          <EditorPanel
            doc={doc}
            loading={loading}
            docs={docs}
            onChangeTitle={(title) => setDoc((current) => (current ? { ...current, title } : current))}
            onChangeBody={(content) => setDoc((current) => (current ? { ...current, content } : current))}
            onOpenDocument={(docId) => {
              selectDocument(docId);
            }}
            onCreateLinkedDocument={async (title) => {
              const created = await createDocument(title);
              return { id: created.id, title: created.title, pinned: created.pinned };
            }}
            focusTitleToken={focusTitleToken}
          />
        ) : null}

        {currentPage === "home" ? (
          <section className="flex h-full w-full items-center justify-center">
            <h1 className="text-3xl font-semibold text-gray-900">memory</h1>
          </section>
        ) : null}
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
