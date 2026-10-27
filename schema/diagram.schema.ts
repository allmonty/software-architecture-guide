import { z } from "zod";

// Confidence tags are the same ones privacy/CLAUDE.md uses for prose.
export const Confidence = z.enum(["CONFIRMED", "INDUSTRY PATTERN", "SPECULATIVE"]);

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "kebab-case id");

const Node = z.object({
  id: Id,
  label: z.string().min(1),
  kind: z.enum(["client", "edge", "service", "datastore", "queue", "external"]),
  group: z.string().optional(),
  summary: z.string().min(1),
  details: z.string().optional(), // markdown
  confidence: Confidence,
  sources: z.array(z.string().url()),
});

const Edge = z.object({
  id: Id,
  from: Id,
  to: Id,
  label: z.string().optional(),
  protocol: z.string().optional(),
  mode: z.enum(["sync", "async"]).default("sync"),
});

const Flow = z.object({
  id: Id,
  name: z.string().min(1),
  steps: z.array(z.object({ edge: Id, caption: z.string().min(1) })).min(1),
});

export const Diagram = z.object({
  // "NN-slug": must equal the file name stem and the md file's stem.
  id: z.string().regex(/^\d{2}-[a-z0-9-]+$/),
  title: z.string().min(1),
  // reference-design = standard interview design, not a claim about a company's real system.
  kind: z.enum(["real-system", "reference-design"]),
  nodes: z.array(Node).min(2),
  edges: z.array(Edge).min(1),
  flows: z.array(Flow).default([]),
});

export type Diagram = z.infer<typeof Diagram>;
