export type DocSummary = {
  id: string;
  title: string;
  pinned: boolean;
};

export type Doc = {
  id: string;
  title: string;
  body: string;
  pinned: boolean;
};

export type ContextMenuState = {
  docId: string;
  x: number;
  y: number;
};
