import { useCallback, useEffect, useState } from "react";
import type { NextTaskResponse } from "../types/documents";

type NextTaskPageProps = {
  onOpenDocument: (docId: string) => void;
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

export function NextTaskPage({ onOpenDocument }: NextTaskPageProps) {
  const [data, setData] = useState<NextTaskResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [completing, setCompleting] = useState(false);

  const load = useCallback(async () => {
    const next = await fetchJson<NextTaskResponse>("/api/next-task");
    setData(next);
  }, []);

  useEffect(() => {
    setLoading(true);
    load()
      .catch(() => {
        setData(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [load]);

  const completeRoutine = async (routineTaskId: string, subtaskIndex?: number, completeAll = false) => {
    if (completing) {
      return;
    }

    setCompleting(true);

    try {
      await fetchJson<{ ok: true }>("/api/next-task/complete", {
        method: "POST",
        body: JSON.stringify({ source: "routine", routineTaskId, subtaskIndex, completeAll })
      });

      await load();
    } finally {
      setCompleting(false);
    }
  };

  if (loading) {
    return <p className="w-full max-w-[700px] text-sm text-gray-500">Loading next task...</p>;
  }

  if (!data || !data.nextTask) {
    return (
      <section className="w-full max-w-[700px] pt-10">
        <h1 className="text-3xl font-semibold text-gray-900">Next task</h1>
        <p className="mt-4 text-base text-gray-600">No pending routine or todo task found.</p>
      </section>
    );
  }

  const { nextTask } = data;

  return (
    <section className="w-full max-w-[700px] pt-10">
      <h1 className="text-3xl font-semibold text-gray-900">Next task</h1>
      <p className="mt-1 text-sm text-gray-500">Current time: {data.currentTime}</p>

      <div className="mt-5 rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
        {nextTask.source === "routine" ? (
          <>
            <p className="text-xs font-semibold tracking-wide text-blue-700 uppercase">Routine</p>
            <h2 className="mt-2 text-2xl font-medium text-gray-900">{nextTask.title}</h2>
            {nextTask.subtaskText ? <p className="mt-2 text-lg text-gray-900">- {nextTask.subtaskText}</p> : null}
            <p className="mt-2 text-sm text-gray-600">
              Scheduled at {nextTask.timeOfDay} {nextTask.due ? "(due now)" : "(upcoming)"}
            </p>
            {nextTask.totalSubtaskCount > 0 ? (
              <p className="mt-1 text-sm text-gray-600">
                {nextTask.completedSubtaskCount}/{nextTask.totalSubtaskCount} subtasks completed today
              </p>
            ) : null}
            <button
              type="button"
              className="mt-4 cursor-pointer rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-default disabled:opacity-60"
              onClick={() => {
                if (nextTask.subtaskIndex !== null) {
                  void completeRoutine(nextTask.routineTaskId, nextTask.subtaskIndex, false);
                  return;
                }

                void completeRoutine(nextTask.routineTaskId, undefined, true);
              }}
              disabled={completing}
            >
              {completing
                ? "Completing..."
                : nextTask.subtaskIndex !== null
                  ? "Mark subtask done"
                  : "Mark routine task done"}
            </button>
          </>
        ) : (
          <>
            <p className="text-xs font-semibold tracking-wide text-gray-700 uppercase">Todo</p>
            <h2 className="mt-2 text-2xl font-medium text-gray-900">{nextTask.text}</h2>
            <p className="mt-2 text-sm text-gray-600">From {nextTask.docTitle || "Untitled"}</p>
            <button
              type="button"
              className="mt-4 cursor-pointer rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
              onClick={() => onOpenDocument(nextTask.docId)}
            >
              Open document
            </button>
          </>
        )}
      </div>

      {data.upcoming.length > 0 ? (
        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-800">Upcoming routine tasks today</h3>
          <ul className="mt-2 space-y-1">
            {data.upcoming.slice(0, 8).map((item) => (
              <li key={item.routineTaskId} className="text-sm text-gray-600">
                {item.timeOfDay} - {item.title}
                {item.subtaskText ? ` - ${item.subtaskText}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
