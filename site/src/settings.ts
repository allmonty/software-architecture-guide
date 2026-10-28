import { useSyncExternalStore } from "react";
import { DEFAULTS, parseSettings, serializeSettings, clampSize, type Settings } from "./settings-core.ts";

// Reading settings live in one cookie. Cookie access is wrapped because it can be blocked (or absent on file://);
// the choice then lasts for the page session only.
const read = () => { try { return parseSettings(document.cookie); } catch { return { ...DEFAULTS }; } };

let state: Settings = read();
const listeners = new Set<() => void>();

// data-theme is left off for "system" so the prefers-color-scheme rules apply.
export function applySettings(s: Settings) {
  const root = document.documentElement;
  if (s.theme === "system") delete root.dataset.theme; else root.dataset.theme = s.theme;
  root.dataset.font = s.font;
  root.lang = s.lang;
  root.style.setProperty("--fs", `${s.size}px`);
}

export function updateSettings(patch: Partial<Settings>) {
  state = { ...state, ...patch, size: clampSize(patch.size ?? state.size) };
  applySettings(state);
  try { document.cookie = serializeSettings(state); } catch { /* keep in memory only */ }
  listeners.forEach((l) => l());
}
export const resetSettings = () => updateSettings(DEFAULTS);

applySettings(state);

export function useSettings(): Settings {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}
