import { useCallback, useEffect, useRef } from "react";
import { BodyEditor } from "./BodyEditor";
import type { Doc, DocContent, DocSummary } from "../types/documents";

type EditorPanelProps = {
  doc: Doc | null;
  loading: boolean;
  docs: DocSummary[];
  onChangeTitle: (title: string) => void;
  onChangeBody: (content: DocContent) => void;
  onOpenDocument: (docId: string) => void;
  onCreateLinkedDocument: (title: string) => Promise<DocSummary>;
  focusTitleToken?: number;
};

export function EditorPanel({
  doc,
  loading,
  docs,
  onChangeTitle,
  onChangeBody,
  onOpenDocument,
  onCreateLinkedDocument,
  focusTitleToken
}: EditorPanelProps) {
  const bodyFocusRef = useRef<(() => void) | null>(null);
  const bodyFocusStartRef = useRef<(() => void) | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const focusTitleInput = useCallback(() => {
    const input = titleInputRef.current;

    if (!input) {
      return;
    }

    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  useEffect(() => {
    if (!focusTitleToken) {
      return;
    }

    focusTitleInput();
  }, [focusTitleInput, focusTitleToken]);

  if (!doc) {
    return <p className="w-full max-w-[700px] text-sm text-gray-500">{loading ? "Loading..." : "Select or create a document."}</p>;
  }

  return (
    <div className="w-full max-w-[700px] pt-10">
      <input
        className="mb-6 w-full rounded px-3 py-2 text-4xl font-bold outline-none"
        ref={titleInputRef}
        value={doc.title}
        onChange={(event) => onChangeTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            bodyFocusRef.current?.();
            return;
          }

          if (event.key === "ArrowDown") {
            event.preventDefault();
            bodyFocusStartRef.current?.();
          }
        }}
        placeholder="Title"
      />

      <BodyEditor
        docId={doc.id}
        content={doc.content}
        docs={docs}
        onOpenDocument={onOpenDocument}
        onCreateLinkedDocument={onCreateLinkedDocument}
        onMoveFocusToTitle={focusTitleInput}
        onRegisterFocusStart={(focusEditor: () => void) => {
          bodyFocusStartRef.current = focusEditor;
        }}
        onRegisterFocus={(focusEditor) => {
          bodyFocusRef.current = focusEditor;
        }}
        onChange={onChangeBody}
      />
    </div>
  );
}
