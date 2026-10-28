# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A system-design study set: **35 systems** (22 to 31 cover AI systems, live streaming, observability and stream processing; 32 to 35 are building blocks: cache, coordination, top-K and ID generation), plus a `toolkit/` folder (casebook, primers, workbook, see its README), each with a deep Markdown note and a structured diagram, plus a Vite + React + React Flow site in `site/` that renders the diagrams interactively. `README.md` is the hub (index, learning path, concept matrix). The reader is a senior engineer preparing for interviews. **Correctness is the top requirement.**

## Commands

Run from this folder:

```sh
npm install
npm run validate   # schema, references, required sections, relative links, sources on non-speculative nodes
npm test           # unit tests (node:test via tsx): validator, trust helpers, text search, settings, design tokens, learning order; single file: npx tsx --test test/validate.test.ts
cd site && npm install && npm run dev      # http://localhost:5173
npm run build      # tsc --noEmit + vite build, output in site/dist (not committed; the Pages workflow builds and deploys it)
npm run sweep      # needs `vite preview` on :5188 and headless Chrome on :9333 (see scripts/browser-sweep.mjs); checks every page
```

Deep links: `site/#07-photo-upload-storage?flow=upload&step=2` opens a flow at a step.

## Site reading settings

The gear menu in the site header sets theme (System, Light, Warm, Dark), font (system, Atkinson Hyperlegible, Lexend, Literata, self-hosted through Fontsource) reading text size (13 to 24 px) and language (English or Português do Brasil; sets `<html lang>`). They are stored in one cookie, `atlas-settings` (`site/src/settings-core.ts` holds the format and its tests; study progress stays in localStorage). `site/index.html` repeats the cookie parsing in a small inline script so the choice applies before first paint; change both together. Theme tokens are CSS variables on `:root[data-theme]`; the OS dark rule applies only when no theme is set. Diagram text is in px on purpose (nodes have fixed sizes), so it does not follow the reading size or font. Home artwork (`site/src/Art.tsx`, `icons.tsx`) is inline SVG and lucide icons, with no image files.

## Translations (pt-BR)

The language is a setting (`lang` in the `atlas-settings` cookie). UI text lives in `site/src/i18n.tsx`: add every new string to the English object and to the pt-BR one (typed, so `tsc` fails on a gap), and use `useT()`. Track and stage prose is overlaid from `site/src/locales/pt-BR/{tracks,stages}.json` (keyed by track id, step ref and English stage title; `test/i18n.test.ts` checks the keys). Notes are translated by mirroring them at `locales/pt-BR/systems/NN-slug.md` and `locales/pt-BR/toolkit/XNN-slug.md`; a note with no mirror shows in English with a notice. Diagram JSON is not translated yet.

Rules for a translated note, checked by `validateTranslations` in `scripts/validate.ts`: change prose only. Keep every `##` heading, link target, confidence tag, `Sources read on <date>` line and `- Not ...` bullet exactly as in the original (the site, trust card and validator match them), keep quotations in their source language, and keep each term of `schema/glossary.json` that the original uses in English. Run `npm run verify` on the English original only. Commit one translated note per commit.

## Site features that depend on data conventions

- **Trust card** (`site/src/TrustCard.tsx`, helpers in `schema/trust.ts`): read date from the `Sources read on` / `Fact-check,` / `Re-verification ...,` lines (`lastReadDate`; the freshness script shares it), quote tallies from the `.claims.json` ledger, and the "did not verify" list from the `- Not ...` bullets of the Verification log (`notVerified`). Keep those phrasings, or the card shows nothing for the note. Change history comes from `git log` at build time (`vite.config.ts`).
- **Failure flows:** every diagram needs at least one flow with `"failure": true` (validator). Use it for faults, overloads and other abnormal cases, not the normal path.
- **Section links and search** use heading slugs from `site/src/text.ts` (`slugify`, same suffixing as the rendered ids). Do not rename a heading without expecting old `?section=` links to break.
- **Concept index** is parsed from the README's `Concept → systems matrix` table (`schema/concepts.ts`): one row per concept, system numbers separated by commas.
- **Names in the note** that match a diagram element's label (parentheses stripped, 4+ letters) become clickable in Split view (`site/src/nodeRefs.ts`), once per h2 section. Keep element labels distinctive.

## Site design system

`site/src/design.css` holds the tokens (4px spacing grid, three radii, type scale, shadows, layers, themes, diagram palette), the page frame and the one card look; its header comment is the guide. `site/src/styles.css` has page-specific rules only and must use the tokens: `test/design.test.ts` fails on raw px in `padding`, `margin`, `gap` or `border-radius` and on rem font sizes outside the scale (a line ending in `/* raw: reason */` is exempt). A new card-like element goes into the surface selector list in `design.css` rather than getting its own border, radius and shadow. The top bar (brand, Buy me a coffee link, settings) is sticky on every page and the browser sweep fails if a page lacks it; anything that sticks below it must use `top: var(--top-h)`, and body overflow-x must stay `clip` (with `hidden`, sticky stops working).

## Layout and conventions

- `systems/NN-<slug>.md` and `systems/NN-<slug>.diagram.json` come in pairs and share the stem. The JSON `id` must equal the stem, and the md H1 must contain the JSON `title`.
- `schema/diagram.schema.ts` is the single definition of the diagram shape. The validator and the site both import it. Change it there only.
- **C4 model.** Every node has a `c4` role: `person` and `external-system` sit outside the system, `container` is a runnable or deployable unit or data store, `component` lives inside a container (set `parent` to the container id), and `note` is an annotation such as an alternative approach. `technology` is optional and only for technologies the node text already states. The site derives three views from this: **Context** (the system as one box), **Containers** (the system boundary) and **Components** (one container's internals). Relationships are written once, at the finest level, and rolled up to the parent at higher levels. To get a Components view, add a wrapper container for nodes the sources group together and point its components at it.
- A diagram flow step names an **edge id**, so renaming an edge means updating its flows. The validator catches dangling references.
- Required md headings are listed in `REQUIRED_SECTIONS` in `scripts/validate.ts`. They follow the template in [`neokim-post/CLAUDE.md`](https://github.com/allmonty/study/blob/main/architecture/neokim-post/CLAUDE.md) of the study repository, including the 🏛️ Architecture lens (cites the chapter summaries in [`fundamentals-of-software-architecture/summaries/`](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/)) and a `✅ Verification log` at the end.
- **Confidence tags** (`CONFIRMED` / `INDUSTRY PATTERN` / `SPECULATIVE`) appear on every diagram node and on non-trivial prose claims. A node takes the tag of its weakest claim. Non-speculative nodes need at least one source URL.
- `kind: "reference-design"` marks standard interview designs with no public architecture (notification system, payments, matchmaking, reservations). They are not claims about how a named company builds it.

## Adding or changing a system

1. Read the primary sources first (see Sourcing rules), then write `systems/NN-<slug>.md` and `.diagram.json` together. Use an existing note as the template (e.g. `systems/13-netflix.md`).
2. Note structure: title, a one-line kind, **At a glance** (60-second summary, key numbers, decisions and trade-offs, common mistakes), then the body, then **Interview practice** (45-minute walkthrough, 10× growth, collapsible answer outlines, all labelled as our reasoning), **Further reading**, **Sources and provenance** (the sources-read header and tags) and the **Verification log**. The validator requires these headings.
3. Every note has a **Kind** line (`real-system` or `reference-design`), a **Sources read on <date>** line, and a **Verification log** that lists what was checked **and what was not**.
4. `npm run validate` must pass, then update `README.md` (index, learning path, matrix) and, if the learning order changes, `site/src/stages.json` (the one source of the order), the README learning path and the `atlas` track in `site/src/tracks.json`; `test/stages.test.ts` fails when they disagree.
5. Commit the pair as one commit. Notes that upgrade a `neokim-post/` note re-check its key claims and say what was not re-checked.
6. Before finishing, run `npm run verify -- --write <NN>` (PDFs need `PYTHON=` pointing at Python with pypdf). Every phrase in double quotes should be confirmed in its ledger (`systems/NN-*.claims.json`). Reword paraphrases without quotation marks. The verifier checks double-quoted strings of 15 to 320 characters, in any section except interview questions, architecture lens, reviewer notes, further reading and the verification log; it accepts a quote found in *any* URL the note cites (so check attribution yourself), ignores case and punctuation, and does not check anything shorter or inside backticks or bold. Quotes that cannot be fetched are recorded as `manual` (with a dated note) or `ignored` (with a reason), never silently dropped. Each confirmed entry also records `sourceClass`: `primary` or `secondary`, judged by domain in `schema/trust.ts` (Wikipedia, explainer newsletters and aggregators are secondary; so is any Medium page except a named company engineering blog). When several cited pages contain a quote, a primary one wins. A quote confirmed only by a secondary source is shown as such on the site; either find the primary source or say plainly that the claim rests on a secondary one. Extend the list in `schema/trust.ts` when you cite a new kind of secondary site.

Extra tag used in upgraded notes: `[EARLIER PASS]` means verified in the earlier neokim-post fact-check but not re-read here.

## Toolkit (`toolkit/`)

Pages without diagrams: casebook `C01-slug.md` (real incidents), primers `P01-slug.md` (cross-cutting topics) and workbook `W01-slug.md` (our exercises with answer keys). `toolkit/README.md` is the index. Rules: same sourcing and tagging as systems; each page needs **Sources and provenance** and **Verification log** headings (`validateToolkit` in `scripts/validate.ts`); relative links must resolve; `npm run verify -- P03` checks one page; workbook pages are skipped by `verify` because their quotation marks are exercise wording. Casebook pages retell an incident from the operator's own account, keep a clearly labelled "Our analysis" section, and avoid quotation marks on paraphrases. The site renders these pages under `#toolkit/<id>`.

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

### Extra rules for AI notes (22 to 28; the dated-source and primary-source rules also apply to 29 to 31)

- AI facts age fast. State the **date of each source** and quote vendor or benchmark numbers only from the primary paper or post, never from secondary coverage. Say which models, hardware and datasets a number was measured on.
- Do not describe a vendor's internals (how a named chatbot is served, how a named company trains) unless it published them. Name the system type, cite the open papers, and label the rest a reference design.
- Keep three things apart: **model facts** (from papers), **system design reasoning** (ours) and **cost figures** (illustrative unless sourced).
- Every AI note covers **evaluation, safety limits and cost control**, tagged `[INDUSTRY PATTERN]` unless a source states them.
- PDF text can carry ligatures, hyphenated line breaks and stray spaces. `npm run verify` normalises most of them; if a correct quote still fails, quote a shorter phrase or paraphrase without quotation marks. The verifier caches normalised text in `.cache/sources/`; delete a stale entry after changing the normaliser.

## Git

This repository was split out of `architecture/system-design` of the `study` repository (history kept). The earlier `neokim-post/` case studies and the book summaries in `fundamentals-of-software-architecture/` stay in that repository, and notes link to them by GitHub URL, so those links are not checked by `npm run validate`. One commit per system (`.md` + `.diagram.json`, with `npm run validate` green), and keep scaffolding, site and docs changes in separate commits.
