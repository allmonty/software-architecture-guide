import { Diagram } from "../../schema/diagram.schema.ts";

export interface System {
  id: string;
  diagram: Diagram;
  markdown: string;
}

const diagrams = import.meta.glob("../../systems/*.diagram.json", { eager: true, import: "default" });
const notes = import.meta.glob("../../systems/*.md", { eager: true, query: "?raw", import: "default" });

// Parsing at load time means a malformed file fails loudly in the browser console and is skipped,
// while `npm run validate` is the gate that keeps it from being committed.
export const systems: System[] = Object.entries(diagrams)
  .flatMap(([path, raw]) => {
    const parsed = Diagram.safeParse(raw);
    if (!parsed.success) {
      console.error(`Invalid diagram ${path}`, parsed.error.issues);
      return [];
    }
    const md = notes[path.replace(".diagram.json", ".md")] as string | undefined;
    return [{ id: parsed.data.id, diagram: parsed.data, markdown: md ?? "" }];
  })
  .sort((a, b) => a.id.localeCompare(b.id));
