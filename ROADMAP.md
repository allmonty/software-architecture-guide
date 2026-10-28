# Roadmap

What is left after the 35 systems, the toolkit and the site. Each item says what is missing and why it was not done. Status is as of 2026-10-27.

| # | Item | Status |
|---|---|---|
| 1 | Browser testing beyond headless Chrome | Partly done: `npm run sweep` (see below), plus hand checks of the study checkboxes, progress, PNG export and print styles. A real phone, a screen reader and a real print dialog are still untested. |
| 2 | Check the whole site in the new design | Done: `npm run sweep` opens every page (478 checks: every page in 3 themes at 2 widths, with the text and graph views in light at 1280px) with 0 console errors and 0 failures; it also checks the sticky top bar (brand, coffee link, settings) on every page. |
| 3 | Fresh independent source review of all the content | Done on 2026-10-27 by four fresh read-only reviewers (notes 01-12, 13-23, 24-35, and the toolkit with the workbook and site data). About 25 findings were verified and fixed; the rest are listed under "Review follow-ups" below. |
| 4 | Find a primary source for "dispatch optimization" in note 15 | Resolved: no primary source gives the expansion (Uber's InfoQ page and slides use the name DISCO only), so note 15 attributes it to HighScalability's summary. |
| 5 | Confidence tags on diagram edges | Deferred. Needs a schema change and hand-tagging a few hundred edges. |
| 6 | Per-element alias for clickable names in the note | Deferred. Names are matched by text, so an ambiguous name can occasionally link to the wrong element. |
| 7 | One source for the learning order | Done: `site/src/stages.json` is the order; a test checks it against the atlas track and the README. |
| 9 | Switch Pages to GitHub Actions and delete `docs/` | Open, needs you: set Settings → Pages → Source to GitHub Actions and push; once the first run is green, delete the old `docs/` folder (it is a stale build from before the review fixes and the sticky top bar). |
| 8 | Content not yet written | Partly done: primers P11 to P14 (monolith vs microservices, event sourcing and CQRS, disaster recovery, multi-tenancy) are written. The rest is below. |

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
- Authorization at scale (Zanzibar) and identity
- Privacy by design

Sources that could not be fetched so far: the Count-Min Sketch paper (note 34) and the Instagram engineering post on IDs (note 35, read from an Internet Archive copy only where noted).

## Review follow-ups (2026-10-27)

Fixed after being checked against the sources: Twitch Create Clip timeout (60 s, note 29); Llama 3 table inconsistency and the GPU share (27); S-LoRA 4x condition (28); Dropbox streaming sync (06); Stripe 429/503 (02); Argos (12); S3 shards and zones (05); Dynamo example (03); peak rate (08); Spotify loudness and codec lines (14); expired holds vs the exclusion constraint (16); crawler connections (20), TP2 (18), multipart URLs (07), WhatsApp group limit tag (08); 26 diagram nodes retagged INDUSTRY PATTERN because they mixed sourced facts with our design; composite diagrams 26 and 27 name each part's source; toolkit wording (P11 to P14, C02, W02, W03, matrix row).

Still open (low priority, from the reviewers' reports, not yet verified one by one):

- Diagrams: note 31 batch reconciliation reads the joined log, not the raw log, so a click lost before the joined log cannot be found (add a raw-log edge); note 21 omits the Open Match backend (FetchMatches and the evaluator return route through it); note 11's read flow ranks before hydrating while the note hydrates first, and the 2017 timeline service and 2023 Home Mixer are one node; several edge labels do not match their flow captions (notes 25, 28, 33, 34, 08 server-crash, 18 gw-bob); note 13's `c-ix` edge and note 21's `no-server` wording; failure flags on `chat-rejected`, `duplicate` and `late` are debatable.
- Notes: note 01 (Squid collapsed forwarding, the RFC 9110 section cited for 302, an unsourced "1 unused" bit and 100:1 read ratio); note 02 (the Envoy recommendation wording, the Redis pattern blend, the IETF draft status); note 04 (edge direction, KIP-848 source); note 05 (a table figure from an image); note 09 (the Semaphore node, an unlabelled order of publish and store); note 10 (APNs 30-day storage, queue edges); note 15 (O(1) parent lookup attribution); note 17 (cancel in the processing state for some payment methods); note 19 ("exactly-once" wording, snapshot fallback in gap recovery); note 20 (RFC 9309 30-day and cached-copy rules); note 21 (the 1.7M figure reference); note 22 (binary units in one calculation); note 23 (permission pre-filter trade-off); note 24 (the effect of ef on memory); note 26 (Table 3 unit wording); note 29 (IVS latency wording, the 6 s draft attribution); note 30 (Gorilla and Prometheus blend); note 33 (inference tagged CONFIRMED, an unsourced etcd/Consul line); note 12 (YouTube resumable upload documented for the Data API).
- Toolkit: P11 to P14 small attribution items (the P14 stamps pattern page was not read); C01 "approved playbook" (the post says established); C05 two details not in the SEC order; casebook logs have no "Not ..." bullets so the trust card shows only the "Not read" line; tracks (the W02 step omits C06, the W05 step says primers but has no P11 to P14 cards, the architect track summary order); README wording on what `npm test` covers.

Each of these needs the source re-read before changing the note; none changes a headline number.
