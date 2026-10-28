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
| 8 | Content not yet written | Partly done: primers P11 to P14 (monolith vs microservices, event sourcing and CQRS, disaster recovery, multi-tenancy) are written. The rest is below. |
| 9 | Switch Pages to GitHub Actions and delete `docs/` | Open, needs you: set Settings → Pages → Source to GitHub Actions and push; once the first run is green, delete the old `docs/` folder (it is a stale build from before the review fixes and the sticky top bar). |
| 10 | Portuguese (pt-BR) translation of notes, toolkit and diagrams | In progress: UI text, track/stage overlays and notes 01 to 30 are done and verified against the glossary; notes 31 to 35, the entire toolkit (25 pages) and diagram JSON remain. |

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

## 10. Missing translations (pt-BR)

The site supports English and Brazilian Portuguese (`pt-BR`). UI strings (`site/src/i18n.tsx`), study tracks and stage overlays (`site/src/locales/pt-BR/{tracks,stages}.json`), and 30 of the 35 systems (`locales/pt-BR/systems/01-url-shortener.md` through `30-metrics-monitoring-alerting.md`) are translated, verified against `schema/glossary.json`, and tested by `scripts/validate.ts` and `test/i18n.test.ts`.

The following items remain to be translated:

### Systems (5 notes)

- `systems/31-ad-click-aggregation.md` (Ad click aggregation)
- `systems/32-distributed-cache.md` (Distributed cache / Memcache at Facebook)
- `systems/33-distributed-coordination-locks.md` (Coordination, locks and leader election)
- `systems/34-top-k-leaderboard.md` (Top-K, heavy hitters and leaderboards)
- `systems/35-unique-id-generation.md` (Unique ID generation)

### Toolkit: Primers (14 notes)

- `toolkit/P01-estimation.md` (Back-of-the-envelope estimation)
- `toolkit/P02-storage-engines.md` (Choosing a storage engine)
- `toolkit/P03-distributed-transactions.md` (Distributed transactions: 2PC, sagas, outbox)
- `toolkit/P04-load-balancing.md` (Load balancing)
- `toolkit/P05-api-design.md` (API design: pagination, idempotency, evolution)
- `toolkit/P06-security-threat-modeling.md` (Security for architects)
- `toolkit/P07-slos-and-incidents.md` (SLOs, error budgets, cascading failures, postmortems)
- `toolkit/P08-cost-as-a-design-input.md` (Cost as a design input)
- `toolkit/P09-decisions-and-design-docs.md` (Decisions: ADRs, design docs, boring technology)
- `toolkit/P10-changing-systems-safely.md` (Changing systems safely)
- `toolkit/P11-monolith-vs-microservices.md` (Monolith or microservices)
- `toolkit/P12-event-sourcing-cqrs.md` (Event sourcing and CQRS)
- `toolkit/P13-multi-region-disaster-recovery.md` (Disaster recovery and multi-region design)
- `toolkit/P14-multi-tenancy.md` (Multi-tenancy)

### Toolkit: Casebook (6 notes)

- `toolkit/C01-aws-s3-2017.md` (Amazon S3, February 2017)
- `toolkit/C02-cloudflare-2019.md` (Cloudflare, July 2019)
- `toolkit/C03-github-2018.md` (GitHub, October 2018)
- `toolkit/C04-facebook-2021.md` (Facebook, October 2021)
- `toolkit/C05-knight-capital-2012.md` (Knight Capital, August 2012)
- `toolkit/C06-aws-kinesis-2020.md` (AWS Kinesis, November 2020)

### Toolkit: Practice Workbook (5 notes)

- `toolkit/W01-mock-interview-protocol.md` (Mock interview protocol and rubric)
- `toolkit/W02-find-the-flaw.md` (Find the flaw)
- `toolkit/W03-estimation-drills.md` (Estimation drills)
- `toolkit/W04-decision-exercises.md` (Decision exercises)
- `toolkit/W05-flashcards.md` (Flashcards)

### Diagram JSON (35 diagrams)

- Diagram nodes, labels, and flow step text in `systems/*.diagram.json` currently remain in English. Localizing diagrams will require schema support or localized JSON files so node labels, descriptions, and flow step text can be presented in Portuguese.

## Review follow-ups (2026-10-27)

Fixed after being checked against the sources: Twitch Create Clip timeout (60 s, note 29); Llama 3 table inconsistency and the GPU share (27); S-LoRA 4x condition (28); Dropbox streaming sync (06); Stripe 429/503 (02); Argos (12); S3 shards and zones (05); Dynamo example (03); peak rate (08); Spotify loudness and codec lines (14); expired holds vs the exclusion constraint (16); crawler connections (20), TP2 (18), multipart URLs (07), WhatsApp group limit tag (08); 26 diagram nodes retagged INDUSTRY PATTERN because they mixed sourced facts with our design; composite diagrams 26 and 27 name each part's source; toolkit wording (P11 to P14, C02, W02, W03, matrix row).

Still open (low priority, from the reviewers' reports, not yet verified one by one):

- Diagrams: note 31 batch reconciliation reads the joined log, not the raw log, so a click lost before the joined log cannot be found (add a raw-log edge); note 21 omits the Open Match backend (FetchMatches and the evaluator return route through it); note 11's read flow ranks before hydrating while the note hydrates first, and the 2017 timeline service and 2023 Home Mixer are one node; several edge labels do not match their flow captions (notes 25, 28, 33, 34, 08 server-crash, 18 gw-bob); note 13's `c-ix` edge and note 21's `no-server` wording; failure flags on `chat-rejected`, `duplicate` and `late` are debatable.
- Notes: note 01 (Squid collapsed forwarding, the RFC 9110 section cited for 302, an unsourced "1 unused" bit and 100:1 read ratio); note 02 (the Envoy recommendation wording, the Redis pattern blend, the IETF draft status); note 04 (edge direction, KIP-848 source); note 05 (a table figure from an image); note 09 (the Semaphore node, an unlabelled order of publish and store); note 10 (APNs 30-day storage, queue edges); note 15 (O(1) parent lookup attribution); note 17 (cancel in the processing state for some payment methods); note 19 ("exactly-once" wording, snapshot fallback in gap recovery); note 20 (RFC 9309 30-day and cached-copy rules); note 21 (the 1.7M figure reference); note 22 (binary units in one calculation); note 23 (permission pre-filter trade-off); note 24 (the effect of ef on memory); note 26 (Table 3 unit wording); note 29 (IVS latency wording, the 6 s draft attribution); note 30 (Gorilla and Prometheus blend); note 33 (inference tagged CONFIRMED, an unsourced etcd/Consul line); note 12 (YouTube resumable upload documented for the Data API).
- Toolkit: P11 to P14 small attribution items (the P14 stamps pattern page was not read); C01 "approved playbook" (the post says established); C05 two details not in the SEC order; casebook logs have no "Not ..." bullets so the trust card shows only the "Not read" line; tracks (the W02 step omits C06, the W05 step says primers but has no P11 to P14 cards, the architect track summary order); README wording on what `npm test` covers.

Each of these needs the source re-read before changing the note; none changes a headline number.
