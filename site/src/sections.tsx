import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";

// Section navigation for long notes. Links are buttons, not hash links: a hash change would re-route the whole page.

export const slugify = (t: string) =>
  t.toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

const textOf = (n: ReactNode): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("")
    : n && typeof n === "object" && "props" in n ? textOf((n as { props: { children?: ReactNode } }).props.children) : "";

/** Gives repeated slugs a numeric suffix, in document order, the same way for the outline and for the headings. */
function dedupe() {
  const seen = new Map<string, number>();
  return (slug: string) => { const n = (seen.get(slug) ?? 0) + 1; seen.set(slug, n); return n === 1 ? slug : `${slug}-${n}`; };
}

export interface Section { slug: string; text: string; level: number }

/** The h2 and h3 headings of a Markdown note, outside code fences. */
export function sectionsOf(md: string): Section[] {
  const unique = dedupe();
  let code = false;
  const out: Section[] = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) { code = !code; continue; }
    const m = !code && line.match(/^(#{2,4}) (.+)/);
    if (!m) continue;
    const text = m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim();
    out.push({ slug: unique(slugify(m[2])), text, level: m[1].length });
  }
  return out;
}

/** Updates ?section= in the address bar without a navigation, keeping the other parameters. */
function rememberSection(slug: string | null) {
  const [id, q = ""] = location.hash.slice(1).split("?");
  const p = new URLSearchParams(q);
  if (slug) p.set("section", slug); else p.delete("section");
  history.replaceState(null, "", `#${id}${p.size ? `?${p}` : ""}`);
}

export function scrollToSection(slug: string, remember = true) {
  const el = document.getElementById(slug);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  if (remember) rememberSection(slug);
}

function Heading({ level, id, children }: { level: 2 | 3 | 4; id: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const Tag = `h${level}` as "h2";
  const copy = async () => {
    rememberSection(id);
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the address bar has the link */ }
  };
  return (
    <Tag id={id} className="sec">
      {children}
      <button className="anchor" onClick={copy} aria-label="Copy link to this section" title="Copy link to this section">{copied ? "copied" : "#"}</button>
    </Tag>
  );
}

/** Heading overrides that add ids and copy-link buttons. Create one per note so duplicate headings get stable suffixes. */
export function useHeadingComponents(markdown: string): Components {
  return useMemo(() => {
    const unique = dedupe();
    const make = (level: 2 | 3 | 4) => ({ children }: { children?: ReactNode }) => <Heading level={level} id={unique(slugify(textOf(children)))}>{children}</Heading>;
    return { h2: make(2), h3: make(3), h4: make(4) } as Components;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markdown]);
}

/** The slug of the last heading that has scrolled past the top of its scroll container. */
function useActiveSection(slugs: string[], deps: unknown[]) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const first = slugs.map((s) => document.getElementById(s)).find(Boolean);
    if (!first) return;
    let root: HTMLElement | null = first.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
    const target: HTMLElement | Window = root ?? window;
    let raf = 0;
    const run = () => {
      raf = 0;
      const top = (root?.getBoundingClientRect().top ?? 0) + 24;
      let cur: string | null = null;
      for (const s of slugs) { const el = document.getElementById(s); if (el && el.getBoundingClientRect().top <= top) cur = s; }
      setActive(cur);
    };
    const on = () => { if (!raf) raf = requestAnimationFrame(run); };
    target.addEventListener("scroll", on, { passive: true });
    run();
    return () => { target.removeEventListener("scroll", on); cancelAnimationFrame(raf); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slugs.join("|"), ...deps]);
  return active;
}

/** Compact "jump to" control for the top of a note, and a list that shows the current section. */
export function Outline({ markdown, variant, remount }: { markdown: string; variant: "select" | "list"; remount?: unknown }) {
  const sections = useMemo(() => sectionsOf(markdown).filter((s) => s.level === 2), [markdown]);
  const active = useActiveSection(sections.map((s) => s.slug), [remount, variant]);
  if (sections.length < 3) return null;
  if (variant === "select") {
    return (
      <div className="outline-select">
        <label>
          <span className="muted">Jump to</span>
          <select value={active ?? ""} onChange={(e) => e.target.value && scrollToSection(e.target.value)} aria-label="Jump to section">
            <option value="" disabled>Section…</option>
            {sections.map((s) => <option key={s.slug} value={s.slug}>{s.text}</option>)}
          </select>
        </label>
      </div>
    );
  }
  return (
    <nav className="outline-list" aria-label="Contents">
      <b>Contents</b>
      <ol>
        {sections.map((s) => (
          <li key={s.slug} className={s.slug === active ? "current" : ""}>
            <a href={`#${s.slug}`} onClick={(e) => { e.preventDefault(); scrollToSection(s.slug); }}>{s.text}</a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
