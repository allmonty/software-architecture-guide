import type { Diagram } from "../../schema/diagram.schema.ts";

// A tiny rehype plugin: in each h2 section, the first mention of a diagram element's name becomes a clickable
// reference that selects the element in the diagram. Mentions inside links, code, headings and buttons are left alone.
interface Hast { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] }
const SKIP = new Set(["a", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "button", "summary", "select", "option"]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const labelOf = (label: string) => label.replace(/\s*\(.*$/, "").trim();

export function rehypeNodeRefs(diagram: Diagram) {
  // Names that two elements share are skipped: a click could not know which one the note means.
  const owners = new Map<string, string[]>();
  for (const n of diagram.nodes) {
    const l = labelOf(n.label);
    if (l.length >= 4) owners.set(l.toLowerCase(), [...(owners.get(l.toLowerCase()) ?? []), n.id]);
  }
  const names = new Map<string, { id: string; written: string }>();
  for (const n of diagram.nodes) {
    const l = labelOf(n.label);
    if (l.length >= 4 && owners.get(l.toLowerCase())!.length === 1) names.set(l.toLowerCase(), { id: n.id, written: l });
  }
  // One-word names (Room, Push, Database) are also ordinary words, so they must match their capitalisation; longer names need not.
  const multi = [...names.values()].filter((v) => /\s/.test(v.written)).map((v) => v.written).sort((a, b) => b.length - a.length);
  const single = [...names.values()].filter((v) => !/\s/.test(v.written)).map((v) => v.written).sort((a, b) => b.length - a.length);
  const build = (list: string[], flags: string) => list.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${list.map(esc).join("|")})(?![\\p{L}\\p{N}])`, flags) : null;
  const reMulti = build(multi, "iu"), reSingle = build(single, "u");
  return () => (tree: Hast) => {
    if (!reMulti && !reSingle) return;
    let seen = new Set<string>();
    // The earliest mention at or after `from` whose name has not been linked yet in this section.
    const find = (text: string) => {
      let best: { index: number; text: string } | null = null;
      for (const re of [reMulti, reSingle]) {
        if (!re) continue;
        let from = 0;
        for (;;) {
          const m = re.exec(text.slice(from));
          if (!m) break;
          const at = from + m.index;
          if (!seen.has(m[1].toLowerCase())) { if (!best || at < best.index) best = { index: at, text: m[1] }; break; }
          from = at + m[0].length;
        }
      }
      return best;
    };
    const walk = (node: Hast) => {
      if (node.tagName === "h2") seen = new Set();
      if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
      const out: Hast[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) { walk(child); out.push(child); continue; }
        let rest = child.value;
        for (;;) {
          const m = find(rest);
          if (!m) break;
          seen.add(m.text.toLowerCase());
          if (m.index > 0) out.push({ type: "text", value: rest.slice(0, m.index) });
          out.push({ type: "element", tagName: "span", properties: { className: ["node-ref"], dataNode: names.get(m.text.toLowerCase())!.id }, children: [{ type: "text", value: m.text }] });
          rest = rest.slice(m.index + m.text.length);
        }
        if (rest) out.push({ type: "text", value: rest });
      }
      node.children = out;
    };
    walk(tree);
  };
}
