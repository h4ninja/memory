import type { ContextMenuState, DocSummary } from "../types/documents";

type DocumentContextMenuProps = {
  contextMenu: ContextMenuState;
  contextTarget: DocSummary | null;
  onTogglePinned: (docId: string, pinned: boolean) => void;
  onDelete: (docId: string) => void;
};

export function DocumentContextMenu({ contextMenu, contextTarget, onTogglePinned, onDelete }: DocumentContextMenuProps) {
  return (
    <div
      className="fixed z-50 min-w-44 rounded-md border border-gray-200 bg-white py-1 shadow-lg"
      style={{ left: contextMenu.x, top: contextMenu.y }}
    >
      {contextTarget ? (
        <button
          type="button"
          className="block w-full px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-100"
          onClick={() => onTogglePinned(contextTarget.id, !contextTarget.pinned)}
        >
          {contextTarget.pinned ? "Unpin" : "Pin"}
        </button>
      ) : null}

      <button
        type="button"
        className="block w-full px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-gray-100"
        onClick={() => onDelete(contextMenu.docId)}
      >
        Delete document
      </button>
    </div>
  );
}
