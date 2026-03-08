export type DocSummary = {
  id: string;
  title: string;
  pinned: boolean;
};

export type DocContent = {
  type: string;
  content?: unknown[];
  [key: string]: unknown;
};

export type Doc = {
  id: string;
  title: string;
  content: DocContent;
  pinned: boolean;
};

export type ContextMenuState = {
  docId: string;
  x: number;
  y: number;
};
