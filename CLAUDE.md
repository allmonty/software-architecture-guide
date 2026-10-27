# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A system-design study set: one deep Markdown note plus one structured diagram per system, and (once built) a Vite + React + React Flow site in `site/` that renders the diagrams interactively. The target list (21 systems, ordered as a learning path) is in the plan at `~/.claude/plans/ok-now-let-s-create-recursive-ocean.md`. The reader is a senior engineer preparing for interviews. **Correctness is the top requirement.**

## Commands

Run from this folder:

```sh
npm run validate   # schema + integrity + section checks over systems/
npm test           # validator tests (node:test via tsx); single file: npx tsx --test test/validate.test.ts
```

## Layout and conventions

- `systems/NN-<slug>.md` and `systems/NN-<slug>.diagram.json` come in pairs and share the stem. The JSON `id` must equal the stem, and the md H1 must contain the JSON `title`.
- `schema/diagram.schema.ts` is the single definition of the diagram shape. The validator and the site both import it. Change it there only.
- A diagram flow step names an **edge id**, so renaming an edge means updating its flows. The validator catches dangling references.
- Required md headings are listed in `REQUIRED_SECTIONS` in `scripts/validate.ts`. They follow the template in `../neokim-post/CLAUDE.md`, including the 🏛️ Architecture lens (cites `../fundamentals-of-software-architecture/summaries/` chapters) and a `✅ Verification log` at the end.
- **Confidence tags** (`CONFIRMED` / `INDUSTRY PATTERN` / `SPECULATIVE`) appear on every diagram node and on non-trivial prose claims. A node takes the tag of its weakest claim. Non-speculative nodes need at least one source URL.
- `kind: "reference-design"` marks standard interview designs with no public architecture (notification system, payments, crawler, matchmaking, reservations). They are not claims about how a named company builds it.

## Sourcing rules

- Cite only primary sources: company engineering posts, papers, official docs, conference talks. Fetch them with WebFetch and check the claim against the text. Do not write facts from memory.
- Blog rewrites (dev.to, Medium, Substack summaries), the System Design Primer and awesome-software-architecture are leads and "Further reading", never proof for a claim.
- A number that is not stated in a primary source is labelled illustrative, or left out.
- If a primary source cannot be fetched, downgrade the claim's tag instead of keeping `CONFIRMED`.
- Where a popular article disagrees with the primary source, say so in a Reviewer notes section rather than silently choosing.

## Git

The git root is `~/Dev/study`, a level above `architecture/`. Stage only this folder. One commit per system (`.md` + `.diagram.json`, with `npm run validate` green), and keep scaffolding, site and docs changes in separate commits.
