import type { Components } from "react-markdown";
import { useT } from "./i18n.tsx";

// Confidence tags stay verbatim in the Markdown (the validator and trust card match them). On the site they are shown as
// short markers with a tooltip: a rehype plugin swaps each "[TAG]" in running text for a <conf-tag> element.
interface Hast { type: string; tagName?: string; value?: string; properties?: Record<string, unknown>; children?: Hast[] }
const SHORT = { CONFIRMED: "c", "INDUSTRY PATTERN": "ip", SPECULATIVE: "s", "EARLIER PASS": "ep" } as const;
type Tag = keyof typeof SHORT;
const RE = /\[(CONFIRMED|INDUSTRY PATTERN|SPECULATIVE|EARLIER PASS)\]/g;
const SKIP = new Set(["pre"]);

export function rehypeTags() {
  return (tree: Hast) => {
    const walk = (node: Hast) => {
      if (!node.children || (node.tagName && SKIP.has(node.tagName))) return;
      // A code span holding only a tag (the notes write them as `[CONFIRMED]`) is a tag; any other code is left alone.
      if (node.tagName === "code") {
        const only = node.children.length === 1 && node.children[0].type === "text" ? node.children[0].value?.match(new RegExp(`^${RE.source}$`)) : null;
        if (only) { node.tagName = "conf-tag"; node.properties = { dataTag: only[1] }; node.children = []; }
        return;
      }
      const out: Hast[] = [];
      for (const child of node.children) {
        if (child.type !== "text" || !child.value) { walk(child); out.push(child); continue; }
        let last = 0;
        for (const m of child.value.matchAll(RE)) {
          if (m.index > last) out.push({ type: "text", value: child.value.slice(last, m.index) });
          out.push({ type: "element", tagName: "conf-tag", properties: { dataTag: m[1] }, children: [] });
          last = m.index + m[0].length;
        }
        if (last === 0) { out.push(child); continue; }
        if (last < child.value.length) out.push({ type: "text", value: child.value.slice(last) });
      }
      node.children = out;
    };
    walk(tree);
  };
}

export const TagMark = ({ ...rest }: object) => {
  const t = useT();
  const tag = (rest as { "data-tag"?: Tag })["data-tag"] as Tag;
  const tip = { CONFIRMED: t.tipConfirmed, "INDUSTRY PATTERN": t.tipPattern, SPECULATIVE: t.tipSpeculative, "EARLIER PASS": t.tipEarlier }[tag];
  return <span className={`conf-tag conf-${SHORT[tag]}`} tabIndex={0} role="note" data-tip={tip} aria-label={`${tag}: ${tip}`}>[{SHORT[tag]}]</span>;
};

export const tagComponents = { "conf-tag": TagMark } as unknown as Components;
