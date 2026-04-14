import { useCallback, useEffect, useMemo, useState } from "react";
import type { RoutineTask } from "../types/documents";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type RoutineDraft = {
  title: string;
  timeOfDay: string;
  days: boolean[];
  subtasks: Array<{ id: string; text: string }>;
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

const isDayEnabled = (mask: number, dayIndex: number): boolean => {
  return (mask & (1 << dayIndex)) !== 0;
};

const parseMaskFromDays = (enabledDays: boolean[]): number => {
  return enabledDays.reduce((mask, enabled, index) => (enabled ? mask | (1 << index) : mask), 0);
};

const parseDaysFromMask = (mask: number): boolean[] => {
  return DAYS.map((_, index) => isDayEnabled(mask, index));
};

const reorder = <T,>(items: T[], fromIndex: number, toIndex: number): T[] => {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= items.length || toIndex >= items.length) {
    return items;
  }

  const next = [...items];
  const moved = next[fromIndex];

  if (moved === undefined) {
    return items;
  }

  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
};

const createDraftSubtask = (text = ""): { id: string; text: string } => {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return { id, text };
};

const makeEmptyDraft = (): RoutineDraft => ({
  title: "",
  timeOfDay: "08:00",
  days: [true, true, true, true, true, true, true],
  subtasks: []
});

const draftFromRoutine = (routine: RoutineTask): RoutineDraft => ({
  title: routine.title,
  timeOfDay: routine.timeOfDay,
  days: parseDaysFromMask(routine.weekdayMask),
  subtasks: routine.subtasks.map((item) => createDraftSubtask(item))
});

export function RoutinesPage() {
  const [routines, setRoutines] = useState<RoutineTask[]>([]);
  const [loading, setLoading] = useState(true);

  const [createDraft, setCreateDraft] = useState<RoutineDraft>(makeEmptyDraft);
  const [createDragIndex, setCreateDragIndex] = useState<number | null>(null);

  const [editingRoutineId, setEditingRoutineId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<RoutineDraft | null>(null);
  const [editDragIndex, setEditDragIndex] = useState<number | null>(null);

  const load = useCallback(async () => {
    const next = await fetchJson<RoutineTask[]>("/api/routines");
    setRoutines(next);
  }, []);

  useEffect(() => {
    setLoading(true);
    load()
      .catch(() => {
        setRoutines([]);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [load]);

  const sortedRoutines = useMemo(
    () =>
      [...routines].sort((a, b) => {
        if (a.timeOfDay !== b.timeOfDay) {
          return a.timeOfDay.localeCompare(b.timeOfDay);
        }

        if (a.sortOrder !== b.sortOrder) {
          return a.sortOrder - b.sortOrder;
        }

        return a.title.localeCompare(b.title);
      }),
    [routines]
  );

  const createRoutine = async () => {
    const trimmedTitle = createDraft.title.trim();

    if (!trimmedTitle) {
      return;
    }

    const weekdayMask = parseMaskFromDays(createDraft.days);

    if (weekdayMask === 0) {
      return;
    }

    const subtasks = createDraft.subtasks.map((item) => item.text.trim()).filter((item) => item.length > 0);

    const created = await fetchJson<RoutineTask>("/api/routines", {
      method: "POST",
      body: JSON.stringify({
        title: trimmedTitle,
        timeOfDay: createDraft.timeOfDay,
        weekdayMask,
        subtasks
      })
    });

    setCreateDraft(makeEmptyDraft());
    setCreateDragIndex(null);
    setRoutines((current) => [...current, created]);
  };

  const startEditing = (routine: RoutineTask) => {
    setEditingRoutineId(routine.id);
    setEditDraft(draftFromRoutine(routine));
    setEditDragIndex(null);
  };

  const cancelEditing = () => {
    setEditingRoutineId(null);
    setEditDraft(null);
    setEditDragIndex(null);
  };

  const saveEditing = async (routine: RoutineTask) => {
    if (!editDraft) {
      return;
    }

    const title = editDraft.title.trim();

    if (!title) {
      return;
    }

    const weekdayMask = parseMaskFromDays(editDraft.days);

    if (weekdayMask === 0) {
      return;
    }

    const subtasks = editDraft.subtasks.map((item) => item.text.trim()).filter((item) => item.length > 0);

    const updated = await fetchJson<RoutineTask>(`/api/routines/${routine.id}`, {
      method: "PUT",
      body: JSON.stringify({
        title,
        timeOfDay: editDraft.timeOfDay,
        weekdayMask,
        sortOrder: routine.sortOrder,
        active: routine.active,
        subtasks
      })
    });

    setRoutines((current) => current.map((item) => (item.id === routine.id ? updated : item)));
    cancelEditing();
  };

  const toggleActive = async (routine: RoutineTask) => {
    const updated = await fetchJson<RoutineTask>(`/api/routines/${routine.id}`, {
      method: "PUT",
      body: JSON.stringify({ active: !routine.active })
    });

    setRoutines((current) => current.map((item) => (item.id === routine.id ? updated : item)));
  };

  const deleteRoutine = async (routine: RoutineTask) => {
    await fetchJson<{ id: string }>(`/api/routines/${routine.id}`, {
      method: "DELETE"
    });

    setRoutines((current) => current.filter((item) => item.id !== routine.id));

    if (editingRoutineId === routine.id) {
      cancelEditing();
    }
  };

  return (
    <section className="w-full max-w-[840px] pt-10">
      <h1 className="text-3xl font-semibold text-gray-900">Routines</h1>
      <p className="mt-2 text-sm text-gray-600">Edit routine tasks, add subtasks, and drag to reorder subtasks.</p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <h2 className="text-sm font-semibold text-gray-900">Add routine task</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <input
            value={createDraft.title}
            onChange={(event) => {
              const nextTitle = event.target.value;
              setCreateDraft((current) => ({ ...current, title: nextTitle }));
            }}
            placeholder="Task title"
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <input
            type="time"
            value={createDraft.timeOfDay}
            onChange={(event) => {
              const nextTime = event.target.value;
              setCreateDraft((current) => ({ ...current, timeOfDay: nextTime }));
            }}
            className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {DAYS.map((day, index) => (
            <button
              key={day}
              type="button"
              className={`cursor-pointer rounded border px-2 py-1 text-xs ${
                createDraft.days[index] ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600"
              }`}
              onClick={() => {
                setCreateDraft((current) => ({
                  ...current,
                  days: current.days.map((enabled, idx) => (idx === index ? !enabled : enabled))
                }));
              }}
            >
              {day}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded border border-gray-200 p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold tracking-wide text-gray-700 uppercase">Subtasks</h3>
            <button
              type="button"
              className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              onClick={() => {
                setCreateDraft((current) => ({ ...current, subtasks: [...current.subtasks, createDraftSubtask()] }));
              }}
            >
              Add subtask
            </button>
          </div>

          {createDraft.subtasks.length === 0 ? <p className="mt-2 text-xs text-gray-500">No subtasks.</p> : null}

          <ul className="mt-2 space-y-2">
            {createDraft.subtasks.map((subtask, index) => (
              <li
                key={subtask.id}
                className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5"
                onDragOver={(event) => {
                  event.preventDefault();
                }}
                onDrop={(event) => {
                  event.preventDefault();

                  if (createDragIndex === null) {
                    return;
                  }

                  setCreateDraft((current) => ({ ...current, subtasks: reorder(current.subtasks, createDragIndex, index) }));
                  setCreateDragIndex(null);
                }}
              >
                <button
                  type="button"
                  draggable
                  className="cursor-grab px-1 text-sm text-gray-500"
                  onDragStart={() => {
                    setCreateDragIndex(index);
                  }}
                  onDragEnd={() => {
                    setCreateDragIndex(null);
                  }}
                >
                  ⋮⋮
                </button>
                <input
                  value={subtask.text}
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setCreateDraft((current) => ({
                      ...current,
                      subtasks: current.subtasks.map((item, idx) => (idx === index ? { ...item, text: nextValue } : item))
                    }));
                  }}
                  placeholder={`Subtask ${index + 1}`}
                  className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
                />
                <button
                  type="button"
                  className="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                  onClick={() => {
                    setCreateDraft((current) => ({
                      ...current,
                      subtasks: current.subtasks.filter((_, idx) => idx !== index)
                    }));
                    setCreateDragIndex(null);
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          className="mt-4 cursor-pointer rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          onClick={() => {
            void createRoutine();
          }}
        >
          Add routine
        </button>
      </div>

      <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900">Existing routines</h2>
        {loading ? <p className="mt-2 text-sm text-gray-500">Loading routines...</p> : null}
        {!loading && sortedRoutines.length === 0 ? <p className="mt-2 text-sm text-gray-500">No routines yet.</p> : null}

        <ul className="mt-3 space-y-2">
          {sortedRoutines.map((routine) => {
            const isEditing = editingRoutineId === routine.id;

            return (
              <li key={routine.id} className="rounded border border-gray-200 px-3 py-3">
                {!isEditing ? (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-medium text-gray-900">{routine.title}</p>
                      <p className="text-xs text-gray-600">
                        {routine.timeOfDay} - {DAYS.filter((_, index) => isDayEnabled(routine.weekdayMask, index)).join(", ")}
                      </p>
                      {routine.subtasks.length > 0 ? (
                        <p className="mt-1 text-xs text-gray-500">{routine.subtasks.join(" + ")}</p>
                      ) : (
                        <p className="mt-1 text-xs text-gray-400">No subtasks</p>
                      )}
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          startEditing(routine);
                        }}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                        onClick={() => {
                          void toggleActive(routine);
                        }}
                      >
                        {routine.active ? "Disable" : "Enable"}
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                        onClick={() => {
                          void deleteRoutine(routine);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ) : editDraft ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <input
                        value={editDraft.title}
                        onChange={(event) => {
                          const nextTitle = event.target.value;
                          setEditDraft((current) => (current ? { ...current, title: nextTitle } : current));
                        }}
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                      />
                      <input
                        type="time"
                        value={editDraft.timeOfDay}
                        onChange={(event) => {
                          const nextTime = event.target.value;
                          setEditDraft((current) => (current ? { ...current, timeOfDay: nextTime } : current));
                        }}
                        className="w-full rounded border border-gray-300 px-3 py-2 text-sm outline-none focus:border-blue-500"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      {DAYS.map((day, index) => (
                        <button
                          key={`${routine.id}-${day}`}
                          type="button"
                          className={`cursor-pointer rounded border px-2 py-1 text-xs ${
                            editDraft.days[index] ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600"
                          }`}
                          onClick={() => {
                            setEditDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    days: current.days.map((enabled, idx) => (idx === index ? !enabled : enabled))
                                  }
                                : current
                            );
                          }}
                        >
                          {day}
                        </button>
                      ))}
                    </div>

                    <div className="rounded border border-gray-200 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xs font-semibold tracking-wide text-gray-700 uppercase">Subtasks</h3>
                        <button
                          type="button"
                          className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
                          onClick={() => {
                            setEditDraft((current) =>
                              current ? { ...current, subtasks: [...current.subtasks, createDraftSubtask()] } : current
                            );
                          }}
                        >
                          Add subtask
                        </button>
                      </div>

                      {editDraft.subtasks.length === 0 ? <p className="mt-2 text-xs text-gray-500">No subtasks.</p> : null}

                      <ul className="mt-2 space-y-2">
                        {editDraft.subtasks.map((subtask, index) => (
                          <li
                            key={subtask.id}
                            className="flex items-center gap-2 rounded border border-gray-200 px-2 py-1.5"
                            onDragOver={(event) => {
                              event.preventDefault();
                            }}
                            onDrop={(event) => {
                              event.preventDefault();

                              if (editDragIndex === null) {
                                return;
                              }

                              setEditDraft((current) =>
                                current ? { ...current, subtasks: reorder(current.subtasks, editDragIndex, index) } : current
                              );
                              setEditDragIndex(null);
                            }}
                          >
                            <button
                              type="button"
                              draggable
                              className="cursor-grab px-1 text-sm text-gray-500"
                              onDragStart={() => {
                                setEditDragIndex(index);
                              }}
                              onDragEnd={() => {
                                setEditDragIndex(null);
                              }}
                            >
                              ⋮⋮
                            </button>
                            <input
                              value={subtask.text}
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setEditDraft((current) =>
                                  current
                                    ? {
                                        ...current,
                                        subtasks: current.subtasks.map((item, idx) =>
                                          idx === index ? { ...item, text: nextValue } : item
                                        )
                                      }
                                    : current
                                );
                              }}
                              placeholder={`Subtask ${index + 1}`}
                              className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm outline-none focus:border-blue-500"
                            />
                            <button
                              type="button"
                              className="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
                              onClick={() => {
                                setEditDraft((current) =>
                                  current
                                    ? { ...current, subtasks: current.subtasks.filter((_, idx) => idx !== index) }
                                    : current
                                );
                                setEditDragIndex(null);
                              }}
                            >
                              Remove
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="button"
                        className="cursor-pointer rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700"
                        onClick={() => {
                          void saveEditing(routine);
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className="cursor-pointer rounded border border-gray-300 px-3 py-2 text-xs text-gray-700 hover:bg-gray-50"
                        onClick={cancelEditing}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
