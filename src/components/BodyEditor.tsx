import { useEffect, useMemo } from "react";
import { Extension } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

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

const markdownToEditorJson = (markdown: string): JsonNode => {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const content: JsonNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (/^- \[( |x|X)\]\s+/.test(line)) {
      const taskItems: JsonNode[] = [];

      while (index < lines.length && /^- \[( |x|X)\]\s+/.test(lines[index])) {
        const isChecked = /^- \[(x|X)\]\s+/.test(lines[index]);
        const itemText = lines[index].replace(/^- \[( |x|X)\]\s+/, "");
        taskItems.push({
          type: "taskItem",
          attrs: { checked: isChecked },
          content: [{ type: "paragraph", content: itemText ? [{ type: "text", text: itemText }] : [] }]
        });
        index += 1;
      }

      content.push({ type: "taskList", content: taskItems });
      continue;
    }

    if (/^-\s+/.test(line)) {
      const listItems: JsonNode[] = [];

      while (index < lines.length && /^-\s+/.test(lines[index])) {
        const itemText = lines[index].replace(/^-\s+/, "");
        listItems.push({
          type: "listItem",
          content: [{ type: "paragraph", content: itemText ? [{ type: "text", text: itemText }] : [] }]
        });
        index += 1;
      }

      content.push({ type: "bulletList", content: listItems });
      continue;
    }

    if (line.trim() === "") {
      content.push({ type: "paragraph" });
      index += 1;
      continue;
    }

    content.push({ type: "paragraph", content: [{ type: "text", text: line }] });
    index += 1;
  }

  return { type: "doc", content };
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

  return lines.join("\n").replace(/[ \t]+$/gm, "");
};

export function BodyEditor({ docId, markdown, onChange, onRegisterFocus }: BodyEditorProps) {
  const initialDoc = useMemo(() => markdownToEditorJson(markdown), [markdown]);

  const editor = useEditor(
    {
      extensions: [StarterKit, TaskList, TaskItem.configure({ nested: false }), CheckboxShortcut],
      content: initialDoc,
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
