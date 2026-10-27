# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A system-design study set: **21 systems**, each with a deep Markdown note and a structured diagram, plus a Vite + React + React Flow site in `site/` that renders the diagrams interactively. `README.md` is the hub (index, learning path, concept matrix). The reader is a senior engineer preparing for interviews. **Correctness is the top requirement.**

## Commands

Run from this folder:

```sh
npm install
npm run validate   # schema, references, required sections, relative links, sources on non-speculative nodes
npm test           # validator tests (node:test via tsx); single file: npx tsx --test test/validate.test.ts
cd site && npm install && npm run dev      # http://localhost:5173
cd site && npm run build                   # tsc --noEmit + vite build, output in site/dist
```

Deep links: `site/#07-photo-upload-storage?flow=upload&step=2` opens a flow at a step.

## Layout and conventions

- `systems/NN-<slug>.md` and `systems/NN-<slug>.diagram.json` come in pairs and share the stem. The JSON `id` must equal the stem, and the md H1 must contain the JSON `title`.
- `schema/diagram.schema.ts` is the single definition of the diagram shape. The validator and the site both import it. Change it there only.
- **C4 model.** Every node has a `c4` role: `person` and `external-system` sit outside the system, `container` is a runnable or deployable unit or data store, `component` lives inside a container (set `parent` to the container id), and `note` is an annotation such as an alternative approach. `technology` is optional and only for technologies the node text already states. The site derives three views from this: **Context** (the system as one box), **Containers** (the system boundary) and **Components** (one container's internals). Relationships are written once, at the finest level, and rolled up to the parent at higher levels. To get a Components view, add a wrapper container for nodes the sources group together and point its components at it.
- A diagram flow step names an **edge id**, so renaming an edge means updating its flows. The validator catches dangling references.
- Required md headings are listed in `REQUIRED_SECTIONS` in `scripts/validate.ts`. They follow the template in `../neokim-post/CLAUDE.md`, including the 🏛️ Architecture lens (cites `../fundamentals-of-software-architecture/summaries/` chapters) and a `✅ Verification log` at the end.
- **Confidence tags** (`CONFIRMED` / `INDUSTRY PATTERN` / `SPECULATIVE`) appear on every diagram node and on non-trivial prose claims. A node takes the tag of its weakest claim. Non-speculative nodes need at least one source URL.
- `kind: "reference-design"` marks standard interview designs with no public architecture (notification system, payments, matchmaking, reservations). They are not claims about how a named company builds it.

## Adding or changing a system

1. Read the primary sources first (see Sourcing rules), then write `systems/NN-<slug>.md` and `.diagram.json` together. Use an existing note as the template (e.g. `systems/13-netflix.md`).
2. Every note has a **Kind** line (`real-system` or `reference-design`), a **Sources read on <date>** line, and a **Verification log** that lists what was checked **and what was not**.
3. `npm run validate` must pass, then update `README.md` (index, learning path, matrix) and the `PATH` list in `site/src/App.tsx` if the learning order changes.
4. Commit the pair as one commit. Notes that upgrade a `neokim-post/` note re-check its key claims and say what was not re-checked.
5. Before finishing, audit quotations: every phrase in double quotes should appear verbatim in the cited source. Reword paraphrases without quotation marks, especially for sources read in another language.

Extra tag used in upgraded notes: `[EARLIER PASS]` means verified in the earlier neokim-post fact-check but not re-read here.

## External link check

```sh
grep -ohE 'https?://[^) >"`|]+' systems/*.md README.md | sed 's/[.,;:]$//' | grep -v -E '[<>{}]|\.\.\.' | sort -u \
  | xargs -n1 -P10 sh -c 'printf "%s %s\n" "$(curl -s -o /dev/null -L -m 25 -A "Mozilla/5.0" -w "%{http_code}" "$0")" "$0"' | grep -v '^200 '
```

Expected non-200 results that are not broken links: `403`/`406` from sites that block scripts (blog.x.com, netflixtechblog.com, uber.com, sec.gov, microsoft.com research pages, doi.org, datacenterdynamics.com), `000` for `localhost` and for `instagram-engineering.com` (refused our connection; the post was read from an Internet Archive copy), `404` for the LinkedIn "The Log" URL (known), and `301` for `bit.ly/github` (it is the observed redirect). Re-run a failing URL before treating it as dead.

## Sourcing rules

- Cite only primary sources: company engineering posts, papers, official docs, conference talks. Fetch them with WebFetch and check the claim against the text. Do not write facts from memory.
- Blog rewrites (dev.to, Medium, Substack summaries), the System Design Primer and awesome-software-architecture are leads and "Further reading", never proof for a claim.
- A number that is not stated in a primary source is labelled illustrative, or left out.
- If a primary source cannot be fetched, downgrade the claim's tag instead of keeping `CONFIRMED`.
- WebFetch answers through a summarising model. Use it for quotes and numbers you then check against the page, and treat "not found" as "not in the returned extract", never as proof the page lacks it. For papers (PDF), download with curl and extract text locally, then grep it.
- Notes that restate an earlier note (the `neokim-post/` upgrades) re-check the key claims against primary sources and list what was **not** re-checked in the Verification log.
- Where a popular article disagrees with the primary source, say so in a Reviewer notes section rather than silently choosing.

## Git

The git root is `~/Dev/study`, a level above `architecture/`. Stage only this folder. One commit per system (`.md` + `.diagram.json`, with `npm run validate` green), and keep scaffolding, site and docs changes in separate commits.
