import type { Diagram } from "../../schema/diagram.schema.ts";

// A tiny rehype plugin: in each h2 section, the first mention of a diagram element's name becomes a clickable
// reference that selects the element in the diagram. Mentions inside links, code, headings and buttons are left alone.
interface Hast { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] }
const SKIP = new Set(["a", "code", "pre", "h1", "h2", "h3", "h4", "h5", "h6", "button", "summary", "select", "option"]);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const labelOf = (label: string) => label.replace(/\s*\(.*$/, "").trim();

export function rehypeNodeRefs(diagram: Diagram) {
  const names = new Map<string, string>(); // lower-case name -> node id
  for (const n of diagram.nodes) {
    const l = labelOf(n.label).toLowerCase();
    if (l.length >= 4 && !names.has(l)) names.set(l, n.id);
  }
  const sorted = [...names.keys()].sort((a, b) => b.length - a.length);
  const re = sorted.length ? new RegExp(`(?<![\\p{L}\\p{N}])(${sorted.map(esc).join("|")})(?![\\p{L}\\p{N}])`, "iu") : null;
  return () => (tree: Hast) => {
    if (!re) return;
    let seen = new Set<string>();
    const walk = (node: Hast) => {
      if (node.tagName === "h2") seen = new Set();
      if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
      const out: Hast[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) { walk(child); out.push(child); continue; }
        let rest = child.value;
        for (;;) {
          // First mention not yet linked in this section: skip names already used.
          let m: RegExpExecArray | null = null, from = 0;
          for (;;) {
            const m2 = re.exec(rest.slice(from));
            if (!m2) break;
            if (!seen.has(m2[1].toLowerCase())) { m = m2; m.index += from; break; }
            from += m2.index + m2[0].length;
          }
          if (!m) break;
          seen.add(m[1].toLowerCase());
          if (m.index > 0) out.push({ type: "text", value: rest.slice(0, m.index) });
          out.push({ type: "element", tagName: "span", properties: { className: ["node-ref"], dataNode: names.get(m[1].toLowerCase()) }, children: [{ type: "text", value: m[1] }] });
          rest = rest.slice(m.index + m[1].length);
        }
        if (rest) out.push({ type: "text", value: rest });
      }
      node.children = out;
    };
    walk(tree);
  };
}
