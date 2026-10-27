import { useEffect, useRef, useState } from "react";
import { FONTS, THEMES } from "./settings-core.ts";
import { resetSettings, updateSettings, useSettings } from "./settings.ts";

const THEME_LABEL = { system: "System", light: "Light", warm: "Warm", dark: "Dark" } as const;
const FONT_LABEL = { system: "System default", atkinson: "Atkinson Hyperlegible", lexend: "Lexend", literata: "Literata" } as const;

export function SettingsMenu() {
  const s = useSettings();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div className="settings" ref={box}>
      <button ref={button} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="settings-pop" aria-label="Reading settings">⚙</button>
      {open && (
        <div id="settings-pop" className="settings-pop" role="dialog" aria-label="Reading settings">
          <fieldset>
            <legend>Theme</legend>
            <div className="choices">
              {THEMES.map((t) => (
                <label key={t} className={`choice swatch-${t}`}>
                  <input type="radio" name="theme" checked={s.theme === t} onChange={() => updateSettings({ theme: t })} />
                  <span>{THEME_LABEL[t]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>Font</legend>
            <div className="choices fonts">
              {FONTS.map((f) => (
                <label key={f} className={`choice font-${f}`}>
                  <input type="radio" name="font" checked={s.font === f} onChange={() => updateSettings({ font: f })} />
                  <span>{FONT_LABEL[f]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button className="linkish" onClick={resetSettings}>Reset to defaults</button>
        </div>
      )}
    </div>
  );
}
