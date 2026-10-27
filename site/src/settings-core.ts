// Reading settings and their cookie format. Pure string functions, so they can be tested without a DOM.
// index.html repeats the cookie parsing in a few lines to apply the settings before the first paint; keep both in step.
export const THEMES = ["system", "light", "warm", "dark"] as const;
export const FONTS = ["system", "atkinson", "lexend", "literata"] as const;
export const SIZE = { min: 13, max: 24, default: 15 } as const;
export const COOKIE = "atlas-settings";

export interface Settings { theme: (typeof THEMES)[number]; font: (typeof FONTS)[number]; size: number }
export const DEFAULTS: Settings = { theme: "system", font: "system", size: SIZE.default };

export const clampSize = (n: unknown) =>
  typeof n === "number" && Number.isFinite(n) ? Math.min(SIZE.max, Math.max(SIZE.min, Math.round(n))) : SIZE.default;

// Takes a document.cookie string. Anything missing or invalid falls back to the default for that field.
export function parseSettings(cookie: string): Settings {
  const entry = cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
  if (!entry) return { ...DEFAULTS };
  try {
    const raw = JSON.parse(decodeURIComponent(entry.slice(COOKIE.length + 1)));
    return {
      theme: THEMES.find((t) => t === raw?.theme) ?? DEFAULTS.theme,
      font: FONTS.find((f) => f === raw?.font) ?? DEFAULTS.font,
      size: clampSize(raw?.size),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

// Returns the string to assign to document.cookie.
export const serializeSettings = (s: Settings) =>
  `${COOKIE}=${encodeURIComponent(JSON.stringify(s))}; Max-Age=31536000; Path=/; SameSite=Lax`;
