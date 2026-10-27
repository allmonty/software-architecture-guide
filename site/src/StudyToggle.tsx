import { useEffect } from "react";
import { setLast, toggleDone, useProgress } from "./progress.ts";

/** "Mark as studied" button; opening a page also records it as the place to continue from. */
export function StudyToggle({ refId }: { refId: string }) {
  const { done } = useProgress();
  useEffect(() => setLast(refId), [refId]);
  const isDone = done.includes(refId);
  return (
    <button className="study" aria-pressed={isDone} onClick={() => toggleDone(refId)}>
      {isDone ? "✓ Studied" : "Mark as studied"}
    </button>
  );
}
