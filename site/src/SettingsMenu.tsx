import { useEffect, useRef, useState } from "react";
import { FONTS, LANGS, SIZE, THEMES } from "./settings-core.ts";
import { resetSettings, updateSettings, useSettings } from "./settings.ts";
import { useT } from "./i18n.tsx";

const FONT_NAME = { atkinson: "Atkinson Hyperlegible", lexend: "Lexend", literata: "Literata" } as const; // font names are not translated
const LANG_LABEL = { en: "English", "pt-BR": "Português (Brasil)" } as const; // each in its own language

export function SettingsMenu() {
  const s = useSettings();
  const t = useT();
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
      <button ref={button} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="settings-pop" aria-label={t.readingSettings}>⚙</button>
      {open && (
        <div id="settings-pop" className="settings-pop" role="dialog" aria-label={t.readingSettings}>
          <fieldset>
            <legend>{t.language}</legend>
            <div className="choices">
              {LANGS.map((l) => (
                <label key={l} className="choice">
                  <input type="radio" name="lang" checked={s.lang === l} onChange={() => updateSettings({ lang: l })} />
                  <span>{LANG_LABEL[l]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t.theme}</legend>
            <div className="choices">
              {THEMES.map((th) => (
                <label key={th} className={`choice swatch-${th}`}>
                  <input type="radio" name="theme" checked={s.theme === th} onChange={() => updateSettings({ theme: th })} />
                  <span>{t.themes[th]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t.font}</legend>
            <div className="choices fonts">
              {FONTS.map((f) => (
                <label key={f} className={`choice font-${f}`}>
                  <input type="radio" name="font" checked={s.font === f} onChange={() => updateSettings({ font: f })} />
                  <span>{f === "system" ? t.fontSystem : FONT_NAME[f]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend>{t.textSize}</legend>
            <div className="size-row">
              <button onClick={() => updateSettings({ size: s.size - 1 })} disabled={s.size <= SIZE.min} aria-label={t.smaller}>A−</button>
              <input type="range" min={SIZE.min} max={SIZE.max} step={1} value={s.size} onChange={(e) => updateSettings({ size: Number(e.target.value) })} aria-label={t.textSizeAria} />
              <button onClick={() => updateSettings({ size: s.size + 1 })} disabled={s.size >= SIZE.max} aria-label={t.larger}>A+</button>
              <output>{s.size} px</output>
            </div>
            <p className="muted small">{t.diagramFixed}</p>
          </fieldset>
          <button className="linkish" onClick={resetSettings}>{t.reset}</button>
        </div>
      )}
    </div>
  );
}
