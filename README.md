# System Design Atlas: 35 systems, explained and drawn

Thirty-five systems chosen to teach system design for **interviews and beyond**, including AI systems, live streaming, observability, stream processing, caching, coordination, ranking and ID generation. Each has a deep note (`systems/NN-*.md`) and an **interactive diagram** (`systems/NN-*.diagram.json`) that the site in [`site/`](site/) renders: click a component for details and sources, and step through request flows. A companion [toolkit](toolkit/README.md) adds a casebook of real incidents, cross-cutting primers (estimation, storage engines, transactions, load balancing, APIs, security, SLOs, cost, decisions, migrations) and a practice workbook (mock interviews, flaw drills, estimation drills, decision exercises, flashcards).

**Trust first.** Every note says what is a **verified fact from a primary source** (company engineering post, paper, standard or official docs), what is a **standard design pattern**, and what is our own reasoning. Each ends with a **Verification log** listing what was checked and what was **not**.

---

## How to read the notes

| Tag | Meaning |
|---|---|
| `[CONFIRMED]` | Stated by a primary source we read in full text (the source is linked) |
| `[INDUSTRY PATTERN]` | Standard practice. Not stated by a source for the named company |
| `[SPECULATIVE]` | Plausible, or an illustrative number or policy |
| `[EARLIER PASS]` | Verified in the earlier neokim-post fact-check but not re-read in this folder |

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
2. **Storage and data infrastructure:** 05 Object storage → 04 Message queue → 07 Photo storage → 06 File sync.
3. **Real-time communication:** 08 Chat → 09 Discord → 18 Google Docs → 21 Game matchmaking + chat.
4. **Media delivery:** 14 Spotify → 12 YouTube → 13 Netflix → 29 Live streaming.
5. **Feeds, notifications and ranking:** 11 News feed → 10 Notification system.
6. **Correctness under contention:** 16 Reservations → 17 Payments → 19 Stock exchange.
7. **Location and discovery:** 15 Uber → 20 Web crawler + search.
   **Building blocks:** 35 Unique IDs → 32 Distributed cache → 33 Coordination and locks → 34 Top-K and leaderboards (read these early or alongside the others; they recur everywhere).
8. **Data pipelines and observability:** 30 Metrics monitoring → 31 Ad click aggregation.
9. **AI systems:** 22 LLM inference serving → 24 Vector search → 23 RAG assistant → 25 AI agents → 28 Fine-tuning and evaluation → 26 Recommendations → 27 Training infrastructure.

For interviews, practise each note's **Interview questions**, and walk the **flows** in the diagram out loud.

## Concept → systems matrix

| Concept | Where to study it |
|---|---|
| Caching and request coalescing | 01, 09, 11, 12, 13, 14, 29, 32 |
| CDN and edge delivery | 07, 12, 13, 14, 29 |
| Sharding / partitioning / consistent hashing | 01, 03, 04, 09, 11, 13, 15, 16, 20, 24, 30, 31 |
| Replication, quorums, erasure coding | 03, 04, 05, 06, 07, 30, 31 |
| Consistency models and trade-offs | 03, 04, 05, 06, 16, 18, 30 |
| Queues, logs and event-driven design | 04, 08, 10, 17, 19, 31 |
| Consensus, leader election and fencing | 33, 04 |
| Approximate counting and top-K | 34, 31 |
| Cache consistency, stampede protection | 32 |
| Idempotency and retries | 01, 10, 16, 17, 25, 31, 32 |
| Event sourcing and immutable logs | 04, 17, 19 |
| Concurrency control (constraints, locks, OT, single writer) | 16, 18, 19, 33 |
| Real-time push and WebSockets | 08, 09, 18, 21, 29 |
| Rate limiting and back-pressure | 02, 10, 17, 20, 22, 25, 29, 30 |
| Fail-open and failure handling | 02, 10, 17, 19, 27, 30 |
| Pre-signed URLs and blob storage | 05, 06, 07, 12, 14 |
| Control plane vs data plane, steering | 13, 09, 21, 29 |
| ID generation | 01, 11, 35 |
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

```sh
npm install && (cd site && npm install)   # once
npm run dev      # from system-design/ or site/, http://localhost:5173
npm run build    # static output in site/dist
```

Each diagram follows the **C4 model**: switch between **1 · Context**, **2 · Containers** and **3 · Components** (the last only where the notes describe a container's internals). Higher levels roll relationships up from the lower ones. In a diagram: **click an element or a line** for its summary, confidence badge and sources. Pick a **flow** and use **← / →** (or the buttons) to step through it. Dashed borders mark `INDUSTRY PATTERN` components and dotted ones `SPECULATIVE`. Colours follow the C4 palette (person, external system, container, component) and each box shows a `[Type: technology]` line. Drag boxes to untangle lines (kept per view, with a Reset button). The **Notes** tab renders the full note.

## Checking the content

```sh
npm install
npm run validate   # schema, references, required sections, relative links, sources on every non-speculative node
npm test           # tests for the validator
npm run verify     # re-check every quotation against the sources recorded in systems/*.claims.json
npm run links      # external link check (separates bot-blocked pages from broken ones)
npm run freshness  # notes by the age of their last source read
```

`npm run verify -- --write` fetches each note's cited sources (with an Internet Archive fallback) and updates the claims ledgers. PDFs need Python with `pypdf`: `PYTHON=/path/to/python npm run verify -- --write`.

## References and relationship to other folders

- **Related:** [`../neokim-post/`](../neokim-post/README.md) is the earlier set of 15 case studies this one upgrades (systems 01, 04, 05, 08, 12, 14, 15, 16, 18, 19) and extends. Systems 22 to 35 are new to this folder. It also holds the shared glossary [`00-fundamentals.md`](../neokim-post/00-fundamentals.md). The architecture-lens sections use vocabulary from [`../fundamentals-of-software-architecture/`](../fundamentals-of-software-architecture/summaries/README.md).
- **Study resources used as leads (never as proof):** [System Design Primer](https://github.com/donnemartin/system-design-primer) (the interview-questions list was used as a coverage cross-check: Pastebin/Bit.ly, Twitter timeline, web crawler and key-value store are all covered here) and [awesome-software-architecture](https://github.com/mehdihadeli/awesome-software-architecture) (its case-study list confirmed the choice of systems and pointed to primary sources such as Discord's and Instagram's engineering posts).
- **Sourcing rules and conventions:** see [`CLAUDE.md`](CLAUDE.md).

## Limits to keep in mind

- Some primary sources could not be read (blocked or paywalled pages, PDFs that would not decode). The Verification log in each note lists them, and the affected claims are labelled or removed.
- A reference design shows a defensible way to build the system. It does not say how the company builds it.
- Figures age. Treat any number as "as of its source's date".
