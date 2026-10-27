import { useSyncExternalStore } from "react";

// Study progress lives only in this browser (localStorage). Every access is wrapped because storage can be
// unavailable or throw (private windows, blocked site data); the app must work without it.
const KEY = "atlas-progress-v1";
interface State { done: string[]; last: string | null }

let state: State = read();
const listeners = new Set<() => void>();

function read(): State {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && Array.isArray(raw.done)) return { done: raw.done.filter((x: unknown) => typeof x === "string"), last: typeof raw.last === "string" ? raw.last : null };
  } catch { /* storage unavailable: start empty */ }
  return { done: [], last: null };
}

function commit(next: State) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* keep in memory only */ }
  listeners.forEach((l) => l());
}

export const toggleDone = (ref: string) =>
  commit({ ...state, done: state.done.includes(ref) ? state.done.filter((r) => r !== ref) : [...state.done, ref] });
export const setLast = (ref: string) => { if (state.last !== ref) commit({ ...state, last: ref }); };
export const resetProgress = () => commit({ done: [], last: null });

export function useProgress(): State {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}
