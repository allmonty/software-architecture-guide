# Roadmap

What is left after the 35 systems, the toolkit and the site. Each item says what is missing and why it was not done. Status is as of 2026-10-27.

| # | Item | Status |
|---|---|---|
| 1 | Browser testing beyond headless Chrome | Partly done: `npm run sweep` (see below), plus hand checks of the study checkboxes, progress, PNG export and print styles. A real phone, a screen reader and a real print dialog are still untested. |
| 2 | Check the whole site in the new design | Done: `npm run sweep` opens every page (454 checks across 3 themes and 2 widths) with 0 console errors and 0 failures after the fixes below. |
| 3 | Fresh independent source review of notes 01-31 and workbook answer keys W01-W04 | Deferred. The last review covered 32-35, the toolkit and the site code. |
| 4 | Find a primary source for "dispatch optimization" in note 15 | Deferred. It rests on a summary of Uber's talk. |
| 5 | Confidence tags on diagram edges | Deferred. Needs a schema change and hand-tagging a few hundred edges. |
| 6 | Per-element alias for clickable names in the note | Deferred. Names are matched by text, so an ambiguous name can occasionally link to the wrong element. |
| 7 | One source for the learning order | Done: `site/src/stages.json` is the order; a test checks it against the atlas track and the README. |
| 8 | Content not yet written | Deferred (below). |

## 1 and 2: what the browser sweep covers and what it cannot

`npm run sweep` (`scripts/browser-sweep.mjs`, start instructions in its header) drives headless Chrome over its DevTools protocol. For every system, toolkit page, track, the concept index and the home page it checks console errors, sideways scroll, clipped cards, empty pages, a missing trust card or diagram, one h1 per page, and text contrast (WCAG AA) across light, warm and dark at 1280px and 500px.

It found, and the commits fixed: two h1 headings on every system page (the note's own title is now a second-level heading) and a favicon 404 on every load. The dark-theme "lighter = component" legend chip is flagged by the contrast check but is a false positive (gradient background), and is excluded.

It cannot replace a real phone, a screen reader or the print dialog; those stay open. Print was checked only with print-media emulation, and the PNG export, study checkboxes and progress saved across reloads were checked by hand in headless Chrome.

## 8. Content not yet written

Each of these needs primary sources read in full first (see `CLAUDE.md`, "Sourcing rules").

- Typeahead / autocomplete
- Distributed job scheduler (cron at scale)
- A standalone CDN
- Maps, routing and ETA
- Video conferencing
- Content moderation and fraud detection with ML
- Multi-region disaster recovery (a primer)
- Monolith vs microservices (a primer)
- Event sourcing and CQRS (a primer)
- Authorization at scale (Zanzibar) and identity
- Multi-tenancy
- Privacy by design

Sources that could not be fetched so far: the Count-Min Sketch paper (note 34) and the Instagram engineering post on IDs (note 35, read from an Internet Archive copy only where noted).
