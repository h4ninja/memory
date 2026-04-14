import { useCallback, useEffect, useMemo, useState } from "react";
import { Extension, Mark } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Fragment, Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import { Decoration, DecorationSet, EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import type { DocContent, DocSummary } from "../types/documents";

type BodyEditorProps = {
  docId: string;
  content: DocContent;
  docs: DocSummary[];
  onOpenDocument: (docId: string) => void;
  onCreateLinkedDocument: (title: string) => Promise<DocSummary>;
  onMoveFocusToTitle: () => void;
  onRegisterFocusStart: (focusEditor: () => void) => void;
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

type DragItemInfo = {
  itemPos: number;
  index: number;
  itemType: string;
  parentPos: number;
  parentType: string;
  parentNode: ProseMirrorNode;
};

const getDragItemInfoAtPos = (doc: ProseMirrorNode, pos: number): DragItemInfo | null => {
  const clampedPos = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clampedPos);

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const itemNode = $pos.node(depth);
    const itemType = itemNode.type.name;

    if (itemType !== "listItem" && itemType !== "taskItem") {
      continue;
    }

    const parentNode = $pos.node(depth - 1);
    const parentType = parentNode.type.name;

    if (parentType !== "bulletList" && parentType !== "taskList") {
      continue;
    }

    return {
      itemPos: $pos.before(depth),
      index: $pos.index(depth - 1),
      itemType,
      parentPos: $pos.before(depth - 1),
      parentType,
      parentNode
    };
  }

  return null;
};

const moveListItem = (view: EditorView, source: DragItemInfo, target: DragItemInfo, dropAfter: boolean): boolean => {
  if (source.parentPos !== target.parentPos || source.parentType !== target.parentType || source.itemType !== target.itemType) {
    return false;
  }

  const children: ProseMirrorNode[] = [];
  source.parentNode.forEach((child) => {
    children.push(child);
  });

  if (source.index < 0 || source.index >= children.length || target.index < 0 || target.index >= children.length) {
    return false;
  }

  let insertionIndex = target.index + (dropAfter ? 1 : 0);

  if (source.index < insertionIndex) {
    insertionIndex -= 1;
  }

  if (insertionIndex === source.index) {
    return false;
  }

  const moved = children[source.index];

  if (!moved) {
    return false;
  }

  children.splice(source.index, 1);
  children.splice(insertionIndex, 0, moved);

  const nextParentNode = source.parentNode.copy(Fragment.fromArray(children));
  const tr = view.state.tr.replaceWith(source.parentPos, source.parentPos + source.parentNode.nodeSize, nextParentNode);
  view.dispatch(tr);
  return true;
};

const CollapsibleIndentedItems = Extension.create({
  name: "collapsibleIndentedItems",
  addProseMirrorPlugins() {
    let sourceItemPos: number | null = null;
    let handleMouseUp: ((event: MouseEvent) => void) | null = null;

    const stopDrag = () => {
      if (handleMouseUp) {
        window.removeEventListener("mouseup", handleMouseUp);
      }

      sourceItemPos = null;
      handleMouseUp = null;
      document.body.classList.remove("dragging-list-item");
    };

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

                decorations.push(
                  Decoration.widget(
                    current.pos + 2,
                    () => {
                      const button = document.createElement("button");
                      button.type = "button";
                      button.className = "drag-handle";
                      button.setAttribute("data-drag-item-pos", String(current.pos));
                      button.setAttribute("contenteditable", "false");
                      button.textContent = "⋮⋮";
                      return button;
                    },
                    { side: -1 }
                  )
                );

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

              if (toggle) {
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

              const dragHandle = event.target.closest("button[data-drag-item-pos]");

              if (!dragHandle) {
                return false;
              }

              event.preventDefault();

              const rawPos = dragHandle.getAttribute("data-drag-item-pos");

              if (!rawPos) {
                return false;
              }

              const pos = Number.parseInt(rawPos, 10);

              if (Number.isNaN(pos)) {
                return false;
              }

              sourceItemPos = pos;
              document.body.classList.add("dragging-list-item");

              handleMouseUp = (mouseUpEvent: MouseEvent) => {
                const activeSourcePos = sourceItemPos;
                stopDrag();

                if (activeSourcePos === null) {
                  return;
                }

                const sourceInfo = getDragItemInfoAtPos(view.state.doc, activeSourcePos + 1);

                if (!sourceInfo) {
                  return;
                }

                const coords = view.posAtCoords({ left: mouseUpEvent.clientX, top: mouseUpEvent.clientY });

                if (!coords) {
                  return;
                }

                const targetInfo = getDragItemInfoAtPos(view.state.doc, coords.pos);

                if (!targetInfo) {
                  return;
                }

                const targetDom = view.nodeDOM(targetInfo.itemPos);
                const targetElement = targetDom instanceof HTMLElement ? targetDom : null;
                const targetRect = targetElement?.getBoundingClientRect();
                const dropAfter = !!targetRect && mouseUpEvent.clientY > targetRect.top + targetRect.height / 2;

                moveListItem(view, sourceInfo, targetInfo, dropAfter);
              };

              window.addEventListener("mouseup", handleMouseUp, { once: true });
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
          handleKeyDown: (view, event) => {
            if (event.key !== "Backspace") {
              return false;
            }

            const { state } = view;
            const { selection } = state;

            if (!selection.empty) {
              return false;
            }

            const markType = state.schema.marks.documentLink;

            if (!markType) {
              return false;
            }

            const hasDocLinkMark = (node: { marks?: ReadonlyArray<{ type: { name: string } }> } | null) =>
              !!node?.marks?.some((mark) => mark.type.name === markType.name);

            const { $from } = selection;
            const before = $from.nodeBefore;
            const after = $from.nodeAfter;

            if (before && hasDocLinkMark(before)) {
              const from = selection.from - before.nodeSize;
              const to = selection.from;
              view.dispatch(state.tr.delete(from, to));
              return true;
            }

            if (after && hasDocLinkMark(after)) {
              const from = selection.from;
              const to = selection.from + after.nodeSize;
              view.dispatch(state.tr.delete(from, to));
              return true;
            }

            return false;
          },
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

export function BodyEditor({
  docId,
  content,
  docs,
  onOpenDocument,
  onCreateLinkedDocument,
  onMoveFocusToTitle,
  onRegisterFocusStart,
  onChange,
  onRegisterFocus
}: BodyEditorProps) {
  const [suggestion, setSuggestion] = useState<DocSuggestionState | null>(null);
  const [creatingDoc, setCreatingDoc] = useState(false);
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
        },
        handleKeyDown: (view, event) => {
          if (event.key !== "ArrowUp") {
            return false;
          }

          const { selection } = view.state;

          if (!selection.empty || selection.from !== 1) {
            return false;
          }

          event.preventDefault();
          onMoveFocusToTitle();
          return true;
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

    onRegisterFocusStart(() => {
      editor.commands.focus("start");
    });

    onRegisterFocus(() => {
      editor.commands.focus("end");
    });
  }, [editor, onRegisterFocus, onRegisterFocusStart]);

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

  const createTitle = useMemo(() => {
    if (!suggestion) {
      return "";
    }

    return suggestion.query.trim();
  }, [suggestion]);

  const canCreateFromSuggestion = useMemo(() => {
    if (!suggestion || createTitle === "") {
      return false;
    }

    const normalizedTitle = createTitle.toLowerCase();
    const hasMatch = docs.some((item) => item.title.trim().toLowerCase() === normalizedTitle);
    return !hasMatch;
  }, [docs, createTitle, suggestion]);

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

  const createAndInsertDocumentLink = useCallback(async () => {
    if (!suggestion || !canCreateFromSuggestion || creatingDoc) {
      return;
    }

    setCreatingDoc(true);

    try {
      const created = await onCreateLinkedDocument(createTitle);
      insertDocumentLink(created);
    } finally {
      setCreatingDoc(false);
    }
  }, [canCreateFromSuggestion, createTitle, creatingDoc, insertDocumentLink, onCreateLinkedDocument, suggestion]);

  return (
    <div className="relative">
      <EditorContent editor={editor} />
      {suggestion && (suggestedDocs.length > 0 || canCreateFromSuggestion) ? (
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
          {canCreateFromSuggestion ? (
            <button
              type="button"
              className="block w-full cursor-pointer rounded px-2 py-1.5 text-left text-sm text-blue-700 hover:bg-blue-50 disabled:cursor-default disabled:opacity-60"
              disabled={creatingDoc}
              onMouseDown={(event) => {
                event.preventDefault();
                void createAndInsertDocumentLink();
              }}
            >
              {creatingDoc ? `Creating +${createTitle}...` : `Create +${createTitle}`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
