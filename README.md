# System Design Atlas: 21 systems, explained and drawn

Twenty-one systems chosen to teach system design for **interviews and beyond**. Each has a deep note (`systems/NN-*.md`) and an **interactive diagram** (`systems/NN-*.diagram.json`) that the site in [`site/`](site/) renders: click a component for details and sources, and step through request flows.

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

## Suggested learning path

1. **Foundations:** 01 URL shortener → 02 Rate limiter → 03 Key-value store.
2. **Storage and data infrastructure:** 05 Object storage → 04 Message queue → 07 Photo storage → 06 File sync.
3. **Real-time communication:** 08 Chat → 09 Discord → 18 Google Docs → 21 Game matchmaking + chat.
4. **Media delivery:** 14 Spotify → 12 YouTube → 13 Netflix.
5. **Feeds, notifications and ranking:** 11 News feed → 10 Notification system.
6. **Correctness under contention:** 16 Reservations → 17 Payments → 19 Stock exchange.
7. **Location and discovery:** 15 Uber → 20 Web crawler + search.

For interviews, practise each note's **Interview questions**, and walk the **flows** in the diagram out loud.

## Concept → systems matrix

| Concept | Where to study it |
|---|---|
| Caching and request coalescing | 01, 09, 11, 12, 13, 14 |
| CDN and edge delivery | 07, 12, 13, 14 |
| Sharding / partitioning / consistent hashing | 01, 03, 09, 11, 13, 16, 20 |
| Replication, quorums, erasure coding | 03, 05, 06, 07 |
| Consistency models and trade-offs | 03, 05, 06, 16, 18 |
| Queues, logs and event-driven design | 04, 08, 10, 17, 19 |
| Idempotency and retries | 01, 10, 16, 17 |
| Event sourcing and immutable logs | 04, 17, 19 |
| Concurrency control (constraints, locks, OT, single writer) | 16, 18, 19 |
| Real-time push and WebSockets | 08, 09, 18, 21 |
| Rate limiting and back-pressure | 02, 10, 17, 20 |
| Fail-open and failure handling | 02, 10, 17, 19 |
| Pre-signed URLs and blob storage | 05, 06, 07, 12, 14 |
| Control plane vs data plane, steering | 13, 09, 21 |
| ID generation | 01, 11 |
| Geospatial and time-range indexing | 15, 16 |
| Search and inverted indexes | 20 |
| Ranking and recommendation pipelines | 11, 20, 21 |
| End-to-end encryption and privacy | 08 |
| Matching and scheduling | 15, 16, 19, 21 |

## The site

```sh
npm install && (cd site && npm install)   # once
npm run dev      # from system-design/ or site/, http://localhost:5173
npm run build    # static output in site/dist
```

In a diagram: **click a component** for its summary, confidence badge and sources. Pick a **flow** and use **← / →** (or the buttons) to step through it. Dashed borders mark `INDUSTRY PATTERN` components and dotted ones `SPECULATIVE`. Node colour shows the kind (client, edge, service, datastore, queue, external). The **Notes** tab renders the full note.

## Checking the content

```sh
npm install
npm run validate   # schema, references, required sections, relative links, sources on every non-speculative node
npm test           # tests for the validator
```

## References and relationship to other folders

- **Related:** [`../neokim-post/`](../neokim-post/README.md) is the earlier set of 15 case studies this one upgrades (systems 01, 04, 05, 08, 12, 14, 15, 16, 18, 19) and extends. It also holds the shared glossary [`00-fundamentals.md`](../neokim-post/00-fundamentals.md). The architecture-lens sections use vocabulary from [`../fundamentals-of-software-architecture/`](../fundamentals-of-software-architecture/summaries/README.md).
- **Study resources used as leads (never as proof):** [System Design Primer](https://github.com/donnemartin/system-design-primer) (the interview-questions list was used as a coverage cross-check: Pastebin/Bit.ly, Twitter timeline, web crawler and key-value store are all covered here) and [awesome-software-architecture](https://github.com/mehdihadeli/awesome-software-architecture) (its case-study list confirmed the choice of systems and pointed to primary sources such as Discord's and Instagram's engineering posts).
- **Sourcing rules and conventions:** see [`CLAUDE.md`](CLAUDE.md).

## Limits to keep in mind

- Some primary sources could not be read (blocked or paywalled pages, PDFs that would not decode). The Verification log in each note lists them, and the affected claims are labelled or removed.
- A reference design shows a defensible way to build the system. It does not say how the company builds it.
- Figures age. Treat any number as "as of its source's date".
