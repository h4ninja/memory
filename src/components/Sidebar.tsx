import type { MouseEvent as ReactMouseEvent } from "react";
import type { DocSummary } from "../types/documents";

type SidebarProps = {
  docs: DocSummary[];
  selectedId: string | null;
  loading: boolean;
  onCreateDocument: () => void;
  onSelectDocument: (docId: string) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, docId: string) => void;
};

const DocumentButton = ({
  item,
  selectedId,
  onSelectDocument,
  onOpenContextMenu
}: {
  item: DocSummary;
  selectedId: string | null;
  onSelectDocument: (docId: string) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, docId: string) => void;
}) => {
  return (
    <div className="mb-1">
      <button
        type="button"
        className={`block w-full cursor-pointer truncate px-2 py-2 text-left text-sm transition-colors ${
          item.id === selectedId ? "text-blue-600" : "text-gray-700 hover:text-blue-600"
        }`}
        onClick={() => onSelectDocument(item.id)}
        onContextMenu={(event) => onOpenContextMenu(event, item.id)}
      >
        {item.title || "Untitled"}
      </button>
    </div>
  );
};

export function Sidebar({ docs, selectedId, loading, onCreateDocument, onSelectDocument, onOpenContextMenu }: SidebarProps) {
  const pinnedDocs = docs.filter((item) => item.pinned);
  const unpinnedDocs = docs.filter((item) => !item.pinned);

  return (
    <div className="group absolute left-0 top-0 z-20 h-screen w-64">
      <aside className="pointer-events-none absolute left-0 top-0 h-screen w-64 bg-white p-3 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
        <button
          type="button"
          className="mb-8 flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-gray-300 bg-gray-100 text-lg text-gray-700 transition-opacity hover:opacity-70"
          onClick={onCreateDocument}
          aria-label="New document"
        >
          +
        </button>

        <div>
          {pinnedDocs.map((item) => (
            <DocumentButton
              key={item.id}
              item={item}
              selectedId={selectedId}
              onSelectDocument={onSelectDocument}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}

          {pinnedDocs.length > 0 && unpinnedDocs.length > 0 ? <hr className="my-3 border-gray-200" /> : null}

          {unpinnedDocs.map((item) => (
            <DocumentButton
              key={item.id}
              item={item}
              selectedId={selectedId}
              onSelectDocument={onSelectDocument}
              onOpenContextMenu={onOpenContextMenu}
            />
          ))}

          {!loading && docs.length === 0 ? <p className="text-sm text-gray-500">No documents yet.</p> : null}
        </div>
      </aside>
    </div>
  );
}
