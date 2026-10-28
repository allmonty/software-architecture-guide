import { useEffect } from "react";
import { useT } from "./i18n.tsx";
import { setLast, toggleDone, useProgress } from "./progress.ts";

/** "Mark as studied" button; opening a page also records it as the place to continue from. */
export function StudyToggle({ refId }: { refId: string }) {
  const { done } = useProgress();
  const t = useT();
  useEffect(() => setLast(refId), [refId]);
  const isDone = done.includes(refId);
  return (
    <button className="study" aria-pressed={isDone} onClick={() => toggleDone(refId)}>
      {isDone ? t.studied : t.markStudied}
    </button>
  );
}
