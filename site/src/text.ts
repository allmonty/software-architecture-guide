// Pure text helpers for notes: heading slugs, sections and searching. No DOM, so they can be tested directly.

export const slugify = (t: string) =>
  t.toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").trim().replace(/\s+/g, "-");

/** Gives repeated slugs a numeric suffix, in document order, the same way for the outline and for the headings. */
export function dedupe() {
  const seen = new Map<string, number>();
  return (slug: string) => { const n = (seen.get(slug) ?? 0) + 1; seen.set(slug, n); return n === 1 ? slug : `${slug}-${n}`; };
}

export interface Section { slug: string; text: string; level: number; line: number }

/** The h2 and h3 headings of a Markdown note, outside code fences. */
export function sectionsOf(md: string): Section[] {
  const unique = dedupe();
  let code = false;
  const out: Section[] = [];
  md.split("\n").forEach((line, i) => {
    if (line.startsWith("```")) { code = !code; return; }
    const m = !code && line.match(/^(#{2,4}) (.+)/);
    if (!m) return;
    const text = m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim();
    out.push({ slug: unique(slugify(m[2])), text, level: m[1].length, line: i + 1 });
  });
  return out;
}

export interface Chunk { slug: string; heading: string; body: string }

/** A note cut at its h2 headings. Text before the first heading is a chunk with an empty slug. Slugs match the headings on screen. */
export function splitSections(md: string): Chunk[] {
  const unique = dedupe();
  const out: Chunk[] = [{ slug: "", heading: "", body: "" }];
  let code = false;
  for (const line of md.split("\n")) {
    if (line.startsWith("```")) code = !code;
    const m = !code && line.match(/^(#{2,4}) (.+)/);
    if (m) {
      const slug = unique(slugify(m[2])); // every level takes a slug, so suffixes match the rendered ids
      if (m[1].length === 2) { out.push({ slug, heading: m[2].replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*]/g, "").trim(), body: "" }); continue; }
    }
    out[out.length - 1].body += line + "\n";
  }
  return out;
}

/** The h2 sections that mention a term most often, for "discussed in" links. */
export function mentionsOf(md: string, term: string, limit = 3): Section[] {
  const t = term.trim();
  if (t.length < 4) return [];
  // A one-word name (Room, Push, Database) also appears as an ordinary word, so it must match its capitalisation.
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, /\s/.test(t) ? "giu" : "gu");
  return splitSections(md).filter((c) => c.slug)
    .map((c) => ({ c, n: (c.body.match(re) ?? []).length }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, limit)
    .map(({ c }) => ({ slug: c.slug, text: c.heading, level: 2, line: 0 }));
}

// ---- Full-text search ---------------------------------------------------------------------------------------
export interface SearchPage { id: string; title: string; href: string; type: string; markdown: string }
export interface Hit { page: SearchPage; slug: string; heading: string; snippet: string; score: number }

const plain = (t: string) => t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/<[^>]+>/g, " ").replace(/[`*_|>#]/g, " ").replace(/\s+/g, " ").trim();
const cache = new Map<string, { slug: string; heading: string; text: string; low: string; lowHeading: string }[]>();

function chunksOf(p: SearchPage) {
  let c = cache.get(p.id);
  if (!c) {
    c = splitSections(p.markdown).map((x) => { const text = plain(x.body); return { slug: x.slug, heading: x.heading, text, low: text.toLowerCase(), lowHeading: x.heading.toLowerCase() }; });
    cache.set(p.id, c);
  }
  return c;
}

const count = (hay: string, needle: string) => { let n = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0 && n < 5) n++; return n; };

/** Sections containing every word of the query, best first, at most `perPage` from one page. */
export function searchPages(pages: SearchPage[], query: string, limit = 30, perPage = 3): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
  if (words.length === 0) return [];
  const hits: Hit[] = [];
  for (const page of pages) {
    const found: Hit[] = [];
    for (const c of chunksOf(page)) {
      const all = c.lowHeading + " " + c.low;
      if (!words.every((w) => all.includes(w))) continue;
      const score = words.reduce((s, w) => s + count(c.lowHeading, w) * 6 + count(c.low, w), 0) + (words.every((w) => page.title.toLowerCase().includes(w)) ? 8 : 0);
      const at = Math.max(0, c.low.indexOf(words[0]) - 70);
      found.push({ page, slug: c.slug, heading: c.heading, snippet: (at > 0 ? "…" : "") + c.text.slice(at, at + 190) + (at + 190 < c.text.length ? "…" : ""), score });
    }
    hits.push(...found.sort((a, b) => b.score - a.score).slice(0, perPage));
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
