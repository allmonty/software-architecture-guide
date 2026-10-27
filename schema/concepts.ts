// Reads the "Concept → systems matrix" table of README.md: one row per concept, with the system numbers that cover it.
export interface Concept { slug: string; name: string; systems: string[] }

export function parseConcepts(readme: string): Concept[] {
  const start = readme.indexOf("## Concept → systems matrix");
  if (start < 0) return [];
  const section = readme.slice(start).split(/\n## /)[0];
  return section.split("\n").filter((l) => l.startsWith("|")).slice(2).flatMap((line) => {
    const [name, nums] = line.split("|").slice(1, 3).map((c) => c.trim());
    const systems = (nums ?? "").split(",").map((t) => t.trim()).filter((t) => /^\d\d$/.test(t));
    return name && systems.length ? [{ slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), name, systems }] : [];
  });
}
