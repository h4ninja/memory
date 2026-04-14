export type DocSummary = {
  id: string;
  title: string;
  pinned: boolean;
  pinnedOrder: number | null;
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
  pinnedOrder: number | null;
};

export type ContextMenuState = {
  docId: string;
  x: number;
  y: number;
};

export type RoutineTask = {
  id: string;
  title: string;
  timeOfDay: string;
  weekdayMask: number;
  sortOrder: number;
  active: boolean;
  subtasks: string[];
};

export type NextRoutineTask = {
  routineTaskId: string;
  title: string;
  timeOfDay: string;
  due: boolean;
  subtaskText: string | null;
  subtaskIndex: number | null;
  completedSubtaskCount: number;
  totalSubtaskCount: number;
};

export type NextTodoTask = {
  docId: string;
  docTitle: string;
  text: string;
  nodePath: number[];
};

export type NextTask =
  | ({ source: "routine" } & NextRoutineTask)
  | ({ source: "todo" } & NextTodoTask);

export type NextTaskResponse = {
  currentTime: string;
  nextTask: NextTask | null;
  upcoming: NextRoutineTask[];
};
