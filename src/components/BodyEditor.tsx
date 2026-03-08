import { useCallback, useEffect, useMemo, useState } from "react";
import { Extension, Mark } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { DocContent, DocSummary } from "../types/documents";

type BodyEditorProps = {
  docId: string;
  content: DocContent;
  docs: DocSummary[];
  onOpenDocument: (docId: string) => void;
  onChange: (nextContent: DocContent) => void;
  onRegisterFocus: (focusEditor: () => void) => void;
};

type JsonNode = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: JsonNode[];
};

type DocSuggestionState = {
  from: number;
  to: number;
  query: string;
  left: number;
  top: number;
};

const CheckboxShortcut = Extension.create({
  name: "checkboxShortcut",
  addKeyboardShortcuts() {
    return {
      "Shift-Mod-c": () => this.editor.commands.toggleTaskList()
    };
  }
});

const BlockIndent = Extension.create({
  name: "blockIndent",
  addOptions() {
    return {
      types: ["paragraph", "listItem", "taskItem"],
      minLevel: 0,
      maxLevel: 8
    };
  },
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          indent: {
            default: 0,
            parseHTML: (element: HTMLElement) => {
              const value = Number.parseInt(element.getAttribute("data-indent") ?? "0", 10);
              return Number.isNaN(value) ? 0 : value;
            },
            renderHTML: (attributes: { indent?: number }) => {
              const level = typeof attributes.indent === "number" ? attributes.indent : 0;

              if (level <= 0) {
                return {};
              }

              return {
                "data-indent": String(level),
                style: `margin-left: ${level * 44}px;`
              };
            }
          }
        }
      },
      {
        types: ["listItem", "taskItem"],
        attributes: {
          collapsed: {
            default: false,
            parseHTML: (element: HTMLElement) => element.getAttribute("data-collapsed") === "true",
            renderHTML: (attributes: { collapsed?: boolean }) => {
              if (attributes.collapsed !== true) {
                return {};
              }

              return {
                "data-collapsed": "true"
              };
            }
          }
        }
      }
    ];
  },
  addKeyboardShortcuts() {
    const updateIndent = (delta: number) => {
      const { state, view } = this.editor;
      const { tr, selection } = state;
      let changed = false;

      tr.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
        if (!this.options.types.includes(node.type.name)) {
          return;
        }

        if (node.type.name === "paragraph") {
          const parent = state.doc.resolve(pos).parent;
          if (parent.type.name === "listItem" || parent.type.name === "taskItem") {
            return;
          }
        }

        const current = typeof node.attrs.indent === "number" ? node.attrs.indent : 0;
        const next = Math.max(this.options.minLevel, Math.min(this.options.maxLevel, current + delta));

        if (next === current) {
          return;
        }

        tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
        changed = true;
      });

      if (!changed) {
        return true;
      }

      view.dispatch(tr);
      return true;
    };

    return {
      Tab: () => updateIndent(1),
      "Shift-Tab": () => updateIndent(-1)
    };
  }
});

const CollapsibleIndentedItems = Extension.create({
  name: "collapsibleIndentedItems",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          decorations: (state) => {
            const decorations: Decoration[] = [];
            const hiddenPositions = new Set<number>();

            state.doc.descendants((node, pos) => {
              if (node.type.name !== "bulletList" && node.type.name !== "taskList") {
                return true;
              }

              const items: Array<{ nodeSize: number; pos: number; indent: number; collapsed: boolean }> = [];

              node.forEach((child, offset) => {
                if (child.type.name !== "listItem" && child.type.name !== "taskItem") {
                  return;
                }

                const indent = typeof child.attrs.indent === "number" ? child.attrs.indent : 0;
                const collapsed = child.attrs.collapsed === true;
                items.push({
                  nodeSize: child.nodeSize,
                  pos: pos + offset + 1,
                  indent,
                  collapsed
                });
              });

              for (let index = 0; index < items.length; index += 1) {
                const current = items[index];
                const next = items[index + 1];
                const hasChildren = !!next && next.indent > current.indent;

                if (!hasChildren) {
                  continue;
                }

                decorations.push(
                  Decoration.node(current.pos, current.pos + current.nodeSize, {
                    "data-has-children": "true",
                    "data-collapsed": current.collapsed ? "true" : "false"
                  })
                );

                decorations.push(
                  Decoration.widget(
                    current.pos + 2,
                    () => {
                      const button = document.createElement("button");
                      button.type = "button";
                      button.className = "collapse-toggle";
                      button.setAttribute("data-collapse-pos", String(current.pos));
                      button.setAttribute("contenteditable", "false");
                      button.textContent = current.collapsed ? "▸" : "▾";
                      return button;
                    },
                    { side: -1 }
                  )
                );

                if (!current.collapsed) {
                  continue;
                }

                for (let childIndex = index + 1; childIndex < items.length; childIndex += 1) {
                  const child = items[childIndex];

                  if (child.indent <= current.indent) {
                    break;
                  }

                  if (hiddenPositions.has(child.pos)) {
                    continue;
                  }

                  hiddenPositions.add(child.pos);
                  decorations.push(
                    Decoration.node(child.pos, child.pos + child.nodeSize, {
                      class: "collapsed-child",
                      style: "display: none;"
                    })
                  );
                }
              }

              return true;
            });

            return DecorationSet.create(state.doc, decorations);
          },
          handleDOMEvents: {
            mousedown: (view, event) => {
              if (!(event.target instanceof HTMLElement)) {
                return false;
              }

              const toggle = event.target.closest("button[data-collapse-pos]");

              if (!toggle) {
                return false;
              }

              event.preventDefault();
              const rawPos = toggle.getAttribute("data-collapse-pos");

              if (!rawPos) {
                return false;
              }

              const pos = Number.parseInt(rawPos, 10);

              if (Number.isNaN(pos)) {
                return false;
              }

              const node = view.state.doc.nodeAt(pos);

              if (!node || (node.type.name !== "listItem" && node.type.name !== "taskItem")) {
                return false;
              }

              const collapsed = node.attrs.collapsed === true;
              view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, collapsed: !collapsed }));
              return true;
            }
          }
        }
      })
    ];
  }
});

const DocumentLink = Mark.create<{
  onOpenDocument: (docId: string) => void;
}>({
  name: "documentLink",
  inclusive: false,
  addOptions() {
    return {
      onOpenDocument: () => {
      }
    };
  },
  addAttributes() {
    return {
      docId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-doc-link-id"),
        renderHTML: (attributes: { docId?: string | null }) => {
          if (!attributes.docId) {
            return {};
          }

          return {
            "data-doc-link-id": attributes.docId
          };
        }
      }
    };
  },
  parseHTML() {
    return [{ tag: "span[data-doc-link-id]" }];
  },
  renderHTML({ HTMLAttributes }) {
    return ["span", { ...HTMLAttributes, class: "doc-link" }, 0];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleClick: (view, _pos, event) => {
            if (!(event.target instanceof HTMLElement)) {
              return false;
            }

            const link = event.target.closest("[data-doc-link-id]");

            if (!link) {
              return false;
            }

            const targetDocId = link.getAttribute("data-doc-link-id");

            if (!targetDocId) {
              return false;
            }

            event.preventDefault();
            this.options.onOpenDocument(targetDocId);
            view.focus();
            return true;
          }
        }
      })
    ];
  }
});

const EMPTY_DOC: JsonNode = {
  type: "doc",
  content: [{ type: "paragraph" }]
};

const isDocContent = (value: unknown): value is JsonNode => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeDoc = value as JsonNode;
  return maybeDoc.type === "doc";
};

const normalizeContent = (value: DocContent): JsonNode => {
  if (isDocContent(value)) {
    return value;
  }

  return EMPTY_DOC;
};

const normalizeQuery = (value: string): string => value.trim().toLowerCase();

export function BodyEditor({ docId, content, docs, onOpenDocument, onChange, onRegisterFocus }: BodyEditorProps) {
  const [suggestion, setSuggestion] = useState<DocSuggestionState | null>(null);
  const initialDoc = useMemo(() => normalizeContent(content), [content]);

  const editor = useEditor(
    {
      extensions: [
        StarterKit,
        TaskList,
        TaskItem.configure({ nested: false }),
        CheckboxShortcut,
        BlockIndent,
        CollapsibleIndentedItems,
        DocumentLink.configure({
          onOpenDocument
        })
      ],
      content: initialDoc,
      editorProps: {
        attributes: {
          class: "editor-content min-h-[50vh] px-3 pt-2 pb-[50vh] font-light outline-none"
        }
      },
      onUpdate: ({ editor: currentEditor }) => {
        onChange(currentEditor.getJSON() as DocContent);
      }
    },
    [docId]
  );

  const resolveSuggestion = useCallback((): DocSuggestionState | null => {
    if (!editor) {
      return null;
    }

    const { state, view } = editor;
    const { selection } = state;

    if (!selection.empty) {
      return null;
    }

    const $from = selection.$from;

    if (!$from.parent.isTextblock) {
      return null;
    }

    const textBefore = $from.parent.textBetween(0, $from.parentOffset, "\0", "\0");
    const match = textBefore.match(/(?:^|\s)\+([^\s+]*)$/);

    if (!match) {
      return null;
    }

    const query = match[1] ?? "";
    const from = selection.from - query.length - 1;
    const to = selection.from;
    const coords = view.coordsAtPos(selection.from);

    return {
      from,
      to,
      query,
      left: Math.min(coords.left, window.innerWidth - 280),
      top: Math.min(coords.bottom + 8, window.innerHeight - 220)
    };
  }, [editor]);

  const refreshSuggestion = useCallback(() => {
    setSuggestion(resolveSuggestion());
  }, [resolveSuggestion]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    onRegisterFocus(() => {
      editor.commands.focus("end");
    });
  }, [editor, onRegisterFocus]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const handleSelection = () => {
      refreshSuggestion();
    };

    const handleUpdate = () => {
      refreshSuggestion();
    };

    editor.on("selectionUpdate", handleSelection);
    editor.on("update", handleUpdate);
    window.addEventListener("resize", handleSelection);
    window.addEventListener("scroll", handleSelection, true);

    return () => {
      editor.off("selectionUpdate", handleSelection);
      editor.off("update", handleUpdate);
      window.removeEventListener("resize", handleSelection);
      window.removeEventListener("scroll", handleSelection, true);
    };
  }, [editor, refreshSuggestion]);

  const suggestedDocs = useMemo(() => {
    if (!suggestion) {
      return [];
    }

    const query = normalizeQuery(suggestion.query);

    const filtered = docs.filter((item) => {
      if (item.id === docId) {
        return false;
      }

      if (!query) {
        return true;
      }

      return item.title.toLowerCase().includes(query);
    });

    return filtered
      .sort((a, b) => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }

        return a.title.localeCompare(b.title);
      })
      .slice(0, 8);
  }, [docs, docId, suggestion]);

  const insertDocumentLink = useCallback(
    (target: DocSummary) => {
      if (!editor || !suggestion) {
        return;
      }

      const label = target.title || "Untitled";

      editor
        .chain()
        .focus()
        .setTextSelection({ from: suggestion.from, to: suggestion.to })
        .insertContent([
          {
            type: "text",
            text: `+${label}`,
            marks: [{ type: "documentLink", attrs: { docId: target.id } }]
          },
          {
            type: "text",
            text: " "
          }
        ])
        .run();

      setSuggestion(null);
    },
    [editor, suggestion]
  );

  return (
    <div className="relative">
      <EditorContent editor={editor} />
      {suggestion && suggestedDocs.length > 0 ? (
        <div
          className="doc-link-suggestions fixed z-40 min-w-[220px] rounded-md border border-gray-200 bg-white p-1 shadow-lg"
          style={{ left: suggestion.left, top: suggestion.top }}
        >
          {suggestedDocs.map((item) => (
            <button
              key={item.id}
              type="button"
              className="block w-full cursor-pointer rounded px-2 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100"
              onMouseDown={(event) => {
                event.preventDefault();
                insertDocumentLink(item);
              }}
            >
              +{item.title || "Untitled"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
