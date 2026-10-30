# System Design Atlas

**35 system-design case studies with interactive diagrams, an incident casebook, primers and a practice workbook, for senior engineers preparing for interviews or an architect role. Available in English and Brazilian Portuguese (pt-BR). Every claim says how well it is sourced.**

[☕ Buy me a coffee](https://buymeacoffee.com/allmonty) · [Roadmap](ROADMAP.md) · [Report an error](https://github.com/allmonty/system-design-atlas/issues/new) · [**Live site**](https://allmonty.github.io/system-design-atlas/) (or run it locally, see [publishing](#publishing-on-github-pages))

Each system has a deep note (`systems/NN-*.md`) and a structured diagram (`systems/NN-*.diagram.json`) that the site in [`site/`](site/) draws in the C4 model: click a component for its summary and sources, and step through request flows, including the ones where something fails. The systems cover storage, messaging, feeds, real-time, media, payments and exchanges, and also AI serving, retrieval, agents, training, live streaming, observability, stream processing, caching, coordination, ranking and ID generation.

## Start here

| If you have | Do this |
|---|---|
| **An interview in a couple of weeks** | Follow the *Interview in two weeks* track on the site's home page: the mock-interview protocol, estimation, then 01, 35, 02, 03, 32, 08, 11, 10, 04, 12, 15, 17, 16 with the primers and drills between. |
| **Time to build foundations** | Read the [learning path](#suggested-learning-path) top to bottom, and the [estimation primer](toolkit/P01-estimation.md) first. |
| **An architect role in view** | Read the [toolkit](toolkit/README.md): the [incident casebook](toolkit/README.md#casebook-learning-from-real-incidents-c) (what went wrong, and the questions a design review could have asked) and the primers on decisions, security, SLOs, cost, migrations, deployment shape, event sourcing, disaster recovery and multi-tenancy. |
| **One topic** | Use the [concept matrix](#concept--systems-matrix) to find every system that covers it, or search the site. |

## What is inside

| Path | What it holds |
|---|---|
| [`systems/`](systems/) | The 35 notes, one diagram (`.diagram.json`) and one quote ledger (`.claims.json`) each |
| [`toolkit/`](toolkit/README.md) | Casebook of 6 real incidents (`C`), 16 cross-cutting primers (`P`), a workbook of 6 practice pages (`W`) |
| [`locales/`](locales/pt-BR/) | Brazilian Portuguese (`pt-BR`) translations (systems 01–30, 34, 35 and four toolkit pages mirrored, remainder in progress) |
| [`site/`](site/) | The React + React Flow site: home page study tracks, diagrams, search, reading settings |
| [`.github/workflows/`](.github/workflows/pages.yml) | The workflow that builds and deploys the site |
| [`schema/`](schema/), [`scripts/`](scripts/), [`test/`](test/) | The diagram schema, the validator, the quote verifier, the freshness and link checks, and their tests |
| [`CLAUDE.md`](CLAUDE.md) | Conventions and sourcing rules, for contributors and for Claude Code |
| [`ROADMAP.md`](ROADMAP.md) | What is not done yet, and why |

## Why you can trust it, and where not to

- **Primary sources only.** Facts come from company engineering posts, papers, standards and official documentation, read in full. Tutorials, newsletters and the System Design Primer are leads, never proof.
- **Every claim is tagged** `[CONFIRMED]`, `[INDUSTRY PATTERN]` or `[SPECULATIVE]` (see the next section), and our own reasoning is labelled as ours.
- **Quotations are machine-checked.** `npm run verify` looks up every quoted phrase in the pages the note cites and records where it found it, and whether that source is primary or secondary, in the note's ledger. A found quotation proves the words are on the page, not that the claim built on them is right.
- **Each note ends with a verification log** that says what was checked and what was not.
- **Independent review.** The notes were re-checked by separate read-only reviewers against the sources; findings were verified before anything was changed.
- **How it was made.** The notes, diagrams and site were written with Claude Code under these rules, with the sources fetched and read during the work. Read the verification logs, not this sentence, to decide how far to rely on a claim.

Known limits are at the end of this file and in the [roadmap](ROADMAP.md).

## How to read the notes

| Tag | Meaning |
|---|---|
| `[CONFIRMED]` | Stated by a primary source we read in full text (the source is linked) |
| `[INDUSTRY PATTERN]` | Standard practice. Not stated by a source for the named company |
| `[SPECULATIVE]` | Plausible, or an illustrative number or policy |
| `[EARLIER PASS]` | Verified in the earlier neokim-post fact-check but not re-read in this repository |

- **Kind: real-system** means the company publishes enough to describe how it works. **Kind: reference-design** means the architecture is the standard interview design, built on verified building blocks. A reference design is **not** a claim about how the named company builds it.
- **Dates matter.** Many sources are years old (a 2007 paper, a 2010 blog post). Each note says which.
- **Reading order of a note:** analogy → TL;DR → requirements → architecture and deep dives → reviewer notes (corrections to popular claims) → architecture lens → interview questions → further reading → verification log.

## Index (in learning order)

| # | System | Kind | Core lessons | Built on |
|---|---|---|---|---|
| 01 | [URL shortener](systems/01-url-shortener.md) | reference | key generation, caching, 301 vs 302, Bloom filters | RFC 9110/9111, Snowflake source, upgraded from neokim-post/05 |
| 02 | [Rate limiter](systems/02-rate-limiter.md) | real | token bucket, sliding window, atomic counters, fail-open | Stripe, Cloudflare, Envoy, Redis docs, IETF draft |
| 03 | [Distributed key-value store](systems/03-distributed-kv-store.md) | real | consistent hashing, quorums, hinted handoff, vector clocks | Dynamo paper (2007), Cassandra docs |
| 04 | [Message queue / log (Kafka)](systems/04-message-queue-kafka.md) | real | partitions, ISR, consumer groups, KRaft, tiered storage | Apache Kafka docs and release notes |
| 05 | [Object storage (S3)](systems/05-object-storage-s3.md) | real | metadata/data split, erasure coding, strong consistency | Warfield (2023), ShardStore paper, AWS docs |
| 06 | [File sync (Dropbox)](systems/06-file-sync-dropbox.md) | real | blocks and blocklists, Magic Pocket, three-tree sync engine | Seven Dropbox Tech Blog posts |
| 07 | [Photo upload & storage](systems/07-photo-upload-storage.md) | real + pattern | direct upload, Haystack, f4 warm storage, cooling | Haystack (2010) and f4 (2014) papers, AWS presigned URLs |
| 08 | [Chat (WhatsApp)](systems/08-chat-whatsapp.md) | reference | store-and-forward, ACKs, E2EE, multi-device | WhatsApp whitepaper v9, Meta Engineering |
| 09 | [Discord](systems/09-discord.md) | real | Elixir fan-out, Rust hot spots, Cassandra→ScyllaDB, voice | Five Discord engineering posts |
| 10 | [Notification system](systems/10-notification-system.md) | reference | priority queues, dedup, APNs/FCM behaviour, retries | Apple, Firebase and SQS docs |
| 11 | [News feed (Twitter/Instagram)](systems/11-news-feed.md) | reference | fan-out on write vs read, ranking pipeline, sharded IDs | Twitter 2017 infra post, the-algorithm repo, Instagram 2012 |
| 12 | [YouTube](systems/12-youtube.md) | reference | upload, transcoding DAG, adaptive bitrate, CDN | YouTube Help/API/blog, Vitess, RFC 8216 |
| 13 | [Netflix (delivery)](systems/13-netflix.md) | real | control vs data plane, Open Connect, steering, fill | Open Connect Overview, two Netflix TechBlog posts |
| 14 | [Spotify](systems/14-spotify.md) | reference | audio delivery, signed URLs, 2010 P2P, loudness | P2P paper (2010), Spotify support pages |
| 15 | [Uber (proximity + dispatch)](systems/15-uber-proximity-dispatch.md) | reference | H3 geospatial index, batched matching, sharding by cell | H3 docs, Uber H3 blog, Uber matching page |
| 16 | [Reservation scheduler (hotel + parking)](systems/16-reservation-scheduler.md) | reference | exclusion constraints, holds, overbooking, idempotent payment | PostgreSQL docs, Stripe idempotency docs |
| 17 | [Payment system](systems/17-payment-system.md) | reference | idempotency, payment state machine, webhooks, double-entry ledger | Stripe docs, Square Books post |
| 18 | [Google Docs](systems/18-google-docs.md) | reference | operational transformation, OT vs CRDT, differential sync | Fraser, Figma, Kleppmann et al.; earlier pass for Google 2010 |
| 19 | [Stock exchange](systems/19-stock-exchange.md) | reference | sequencer, deterministic matching, event sourcing, multicast | LMAX (Fowler, Disruptor paper), MoldUDP64 |
| 20 | [Web crawler + search](systems/20-web-crawler-search.md) | real (dated) | frontier, politeness, dedup, inverted index, PageRank | Brin & Page (1998), Mercator (2001), RFC 9309 |
| 21 | [Online game matchmaking + lobby chat](systems/21-game-matchmaking-lobby-chat.md) | reference | tickets and match functions, server fleets, rating, chat shards | Open Match, Agones, TrueSkill abstract, Riot posts |
| 22 | [LLM inference serving](systems/22-llm-inference-serving.md) | reference + real parts | KV cache paging, continuous batching, prefill/decode split, token-based limits | vLLM/PagedAttention (SOSP 2023), Orca (OSDI 2022), DistServe (OSDI 2024) |
| 23 | [RAG knowledge assistant](systems/23-rag-knowledge-assistant.md) | reference | chunking, hybrid search, reranking, permissions, evaluation | RAG paper (2020), Anthropic Contextual Retrieval (2024) |
| 24 | [Vector / semantic search](systems/24-vector-semantic-search.md) | reference + real parts | HNSW, IVF + PQ, SSD-resident graphs, filtering, re-indexing | HNSW, Faiss and DiskANN papers |
| 25 | [AI agent platform](systems/25-ai-agent-platform.md) | reference + real parts | workflows vs agents, tool use, MCP, sandboxing, budgets, approvals | Anthropic "Building effective agents", MCP spec (2025-06-18), ReAct (ICLR 2023) |
| 26 | [Recommendation system](systems/26-recommendation-system.md) | real + pattern | two-stage retrieval and ranking, watch-time objective, online learning, cold start | YouTube DNN (RecSys 2016), ByteDance Monolith (2022) |
| 27 | [LLM training infrastructure](systems/27-llm-training-infrastructure.md) | real | 4D parallelism, ZeRO, topology, checkpointing, failures at 16K GPUs | Llama 3 report (2024), MegaScale (2024), ZeRO (2020) |
| 28 | [LLM fine-tuning, evaluation and deployment](systems/28-llm-finetuning-evaluation.md) | reference + real parts | LoRA, preference tuning, data quality, eval gates, canary, adapter serving | LoRA, InstructGPT, DPO, S-LoRA, MT-Bench, Llama 3 post-training |
| 29 | [Live streaming (Twitch)](systems/29-live-streaming-twitch.md) | real + pattern | ingest and origin routing, transcoding cost, HLS and low-latency HLS, chat fan-out | Four Twitch engineering posts, chat docs, RFC 8216, HLS 2nd-edition draft |
| 30 | [Metrics monitoring and alerting](systems/30-metrics-monitoring-alerting.md) | reference + real parts | time series compression, availability over consistency, cardinality, alert pipeline | Gorilla (2015), Monarch (2020), Prometheus docs |
| 31 | [Ad click aggregation](systems/31-ad-click-aggregation.md) | reference + real parts | dedup by id, event time and watermarks, checkpoints, exactly-once meanings, reconciliation | Photon (2013), Dataflow Model (2015), Flink and Kafka docs |
| 32 | [Distributed cache (Memcache at Facebook)](systems/32-distributed-cache.md) | real + pattern | look-aside cache, leases, thundering herds, gutter pool, invalidation pipeline | Scaling Memcache at Facebook (NSDI 2013) |
| 33 | [Coordination, locks and leader election](systems/33-distributed-coordination-locks.md) | real + pattern | consensus-backed lock service, sessions and leases, fencing tokens, herd-free locks | Chubby (OSDI 2006), ZooKeeper (ATC 2010), Raft (2014) |
| 34 | [Top-K, heavy hitters and leaderboards](systems/34-top-k-leaderboard.md) | reference | sorted sets, Space-Saving counters, windows, merge correctness, sharded ranks | Redis docs, Space-Saving (ICDT 2005) |
| 35 | [Unique ID generation](systems/35-unique-id-generation.md) | real + pattern | Snowflake bit layout, ticket servers, UUIDv7, clock safety, machine ids | Snowflake post and README, Flickr ticket servers, RFC 9562 |

## How to answer a system-design question

Each note's **Interview practice** section follows this outline, so you can rehearse the same steps on every system:

1. **Clarify** the requirements and what is out of scope. Ask about scale, consistency, latency and failure expectations.
2. **Estimate** with round numbers: requests per second, storage, bandwidth. State your assumptions.
3. **Define the interface**: the main API calls and the core data model.
4. **Sketch the design** at container level (the C4 Containers view in the site), then walk the main flow.
5. **Go deep** on the one or two hard problems (the note's At a glance lists them) and name the trade-offs.
6. **Test it**: failure scenarios (every diagram has one or more flows), then what changes at 10× scale.

The answer outlines in each note are our own reasoning and are labelled as such.

## Suggested learning path

1. **Foundations:** 01 URL shortener → 02 Rate limiter → 03 Key-value store.
2. **Building blocks:** 35 Unique IDs → 32 Distributed cache → 33 Coordination and locks → 34 Top-K and leaderboards (they recur inside every large design, so read them early or alongside the others).
3. **Storage and data infrastructure:** 05 Object storage → 04 Message queue → 07 Photo storage → 06 File sync.
4. **Real-time communication:** 08 Chat → 09 Discord → 18 Google Docs → 21 Game matchmaking + chat.
5. **Media delivery:** 14 Spotify → 12 YouTube → 13 Netflix → 29 Live streaming.
6. **Feeds, notifications and ranking:** 11 News feed → 10 Notification system.
7. **Correctness under contention:** 16 Reservations → 17 Payments → 19 Stock exchange.
8. **Location and discovery:** 15 Uber → 20 Web crawler + search.
9. **Data pipelines and observability:** 30 Metrics monitoring → 31 Ad click aggregation.
10. **AI systems:** 22 LLM inference serving → 24 Vector search → 23 RAG assistant → 25 AI agents → 28 Fine-tuning and evaluation → 26 Recommendations → 27 Training infrastructure.

For interviews, practise each note's **Interview questions**, and walk the **flows** in the diagram out loud.

## Concept → systems matrix

| Concept | Where to study it |
|---|---|
| Caching and request coalescing | 01, 09, 11, 12, 13, 14, 29, 32 |
| CDN and edge delivery | 07, 12, 13, 14, 29 |
| Sharding / partitioning / consistent hashing | 01, 03, 04, 05, 09, 11, 13, 15, 16, 20, 24, 30, 31, 34 |
| Replication, quorums, erasure coding | 03, 04, 05, 06, 07, 30, 31 |
| Consistency models and trade-offs | 03, 04, 05, 06, 16, 18, 30, 33 |
| Queues, logs and event-driven design | 04, 08, 10, 17, 19, 31 |
| Consensus, leader election and fencing | 33, 04, 19, 31 |
| Approximate counting and top-K | 34 |
| Cache consistency, stampede protection | 32 |
| Idempotency and retries | 01, 04, 10, 16, 17, 25, 31, 32 |
| Event sourcing and immutable logs | 04, 17, 19 |
| Concurrency control (constraints, locks, OT, single writer) | 16, 18, 19, 33 |
| Real-time push and WebSockets | 08, 09, 18, 21, 29 |
| Rate limiting and back-pressure | 02, 10, 17, 20, 22, 25, 29, 30 |
| Failure handling (fail open, failover, recovery) | 02, 10, 17, 19, 27, 30 |
| Pre-signed URLs and blob storage | 05, 07, 08, 12, 14 |
| Control plane vs data plane, steering | 13, 29 |
| ID generation | 01, 09, 11, 35 |
| Geospatial and time-range indexing | 15, 16 |
| Search and inverted indexes | 20, 23, 24 |
| Ranking and recommendation pipelines | 11, 20, 23, 26 |
| End-to-end encryption and privacy | 08 |
| Matching and scheduling | 15, 16, 19, 21, 27 |
| LLM serving: KV cache, continuous batching, prefill/decode | 22, 28 |
| Retrieval and reranking, hybrid search | 23, 24, 26 |
| Approximate nearest-neighbour indexes | 24, 23, 26 |
| Tool use, sandboxing and agent safety | 25 |
| Two-stage ranking, feature freshness, online learning | 26 |
| Training parallelism, checkpointing, fault recovery at scale | 27 |
| Fine-tuning, adapters, evaluation gates, canary rollout | 28 |
| Low-latency live delivery (HLS, LL-HLS) | 29 |
| Time series storage, compression and alerting | 30 |
| Stream processing, event time, exactly-once | 31, 04 |
| Evaluation, safety and cost control for AI systems | 22, 23, 25, 28 |

## The site

The home page is a study guide: pick a goal (interview, building blocks, architect, AI, or the whole atlas in order) and follow an ordered track with a reason for each step; tick pages as you finish them (saved only in your browser); or browse by stage and search. Tracks live in `site/src/tracks.json`, and `npm run validate` checks that every step points at a real page.

The top-bar gear menu sets theme, font, reading text size, and language (**English** or **Português do Brasil**). Translated notes mirror under `locales/pt-BR/` (currently systems 01 to 30, 34 and 35, and toolkit pages P02, P11, P14 and W04) and fall back to English with a notice when an individual translation is not yet ready. The UI text, study tracks and stages automatically adapt to the chosen language.

```sh
npm install && (cd site && npm install)   # once
npm run dev      # from the repository root or site/, http://localhost:5173
npm run build    # static output in site/dist (see Publishing on GitHub Pages)
```

Each diagram follows the **C4 model**: switch between **1 · Context**, **2 · Containers** and **3 · Components** (the last only where the notes describe a container's internals). Higher levels roll relationships up from the lower ones. In a diagram: **click an element or a line** for its summary, confidence badge and sources. Pick a **flow** and use **← / →** (or the buttons) to step through it. Dashed borders mark `INDUSTRY PATTERN` components and dotted ones `SPECULATIVE`. Colours follow the C4 palette (person, external system, container, component) and each box shows a `[Type: technology]` line. Drag boxes to untangle lines (kept per view, with a Reset button). The views are **Graph**, **Split** (diagram and note side by side) and **Text**, and every page opens with a trust summary.

## Publishing on GitHub Pages

A GitHub Actions workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) builds the site and deploys it on every push to `main`: it installs, runs `npm run validate` and `npm test` (a failing check stops the deploy), then `npm run build`, which writes the static site to `site/dist`. Nothing generated is committed.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**. The site then appears at `https://allmonty.github.io/system-design-atlas/`. Links use a hash (`#13-netflix?view=split`) and relative asset paths, so it works from any subpath. The workflow can also be started by hand from the Actions tab.

`npm run verify` is not part of the workflow, because it fetches every cited page; run it locally before pushing content changes. The build embeds each note's recent commit history, so the workflow checks out the full history.

## Checking the content

```sh
npm install
npm run validate   # schema, references, required sections, relative links, sources on every non-speculative node, pt-BR translations against glossary and original
npm test           # unit tests: validator, quote and trust helpers, text search, settings, design tokens, learning order, translation overlays and glossary rules
npm run verify     # re-check every quotation against the sources recorded in systems/*.claims.json
npm run links      # external link check (separates bot-blocked pages from broken ones)
npm run freshness  # notes by the age of their last source read
npm run sweep      # browser check of every page (needs vite preview on :5188 and headless Chrome on :9333, see scripts/browser-sweep.mjs)
```

`npm run verify -- --write` fetches each note's cited sources (with an Internet Archive fallback) and updates the claims ledgers. PDFs need Python with `pypdf`: `PYTHON=/path/to/python npm run verify -- --write`.

## References and related material

- **Related:** [`neokim-post/`](https://github.com/allmonty/study/blob/main/architecture/neokim-post/README.md) is the earlier set of 15 case studies this one upgrades (systems 01, 04, 05, 08, 12, 14, 15, 16, 18, 19) and extends. Systems 22 to 35 are new to this repository. It also holds the shared glossary [`00-fundamentals.md`](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md). The architecture-lens sections use vocabulary from [`../fundamentals-of-software-architecture/`](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/README.md).
- **Study resources used as leads (never as proof):** [System Design Primer](https://github.com/donnemartin/system-design-primer) (the interview-questions list was used as a coverage cross-check: Pastebin/Bit.ly, Twitter timeline, web crawler and key-value store are all covered here) and [awesome-software-architecture](https://github.com/mehdihadeli/awesome-software-architecture) (its case-study list confirmed the choice of systems and pointed to primary sources such as Discord's and Instagram's engineering posts).
- **Sourcing rules and conventions:** see [`CLAUDE.md`](CLAUDE.md).

## Limits to keep in mind

- Some primary sources could not be read (blocked or paywalled pages, PDFs that would not decode). The Verification log in each note lists them, and the affected claims are labelled or removed.
- A reference design shows a defensible way to build the system. It does not say how the company builds it.
- Figures age. Treat any number as "as of its source's date".

## Support

This is a free, unpaid project. If it helped you prepare, [buying me a coffee](https://buymeacoffee.com/allmonty) is appreciated and never expected. Corrections matter more: if a claim is wrong or out of date, [open an issue](https://github.com/allmonty/system-design-atlas/issues/new) with the page and the source that says otherwise.

## License

Code (`scripts/`, `schema/`, `test/`, `site/`) is under the [MIT License](LICENSE). The written content (notes, toolkit, translations, diagram JSON) is under [CC BY 4.0](LICENSE-CONTENT): reuse it with credit to Allan Monteiro.
