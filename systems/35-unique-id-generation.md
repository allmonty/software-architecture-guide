# 35 — Unique ID Generation

*Real-system note from Twitter's Snowflake, Flickr's ticket servers and the UUID standard (RFC 9562), plus a reference design for choosing between them. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Distributed systems need identifiers that are **unique** without a single database sequence, and often **roughly time-ordered** (so that indexes stay efficient and "newer than id X" queries work) and **compact**. There are three families: (1) **coordinated counters** such as Flickr's ticket servers, (2) **uncoordinated time-based IDs** such as Snowflake (timestamp + machine id + sequence in 64 bits), and (3) **random or time-ordered UUIDs** (128 bits, now including UUIDv7). The design questions are uniqueness guarantees, ordering, size, clock behaviour (what if time goes backwards?) and who assigns machine ids.

**Key numbers** (as published)
- Snowflake IDs: 41 bits of milliseconds since a custom epoch (about 69 years), 10 bits of machine id (up to 1,024 machines) and 12 bits of sequence (4,096 per millisecond per machine) `[CONFIRMED]`.
- Snowflake's requirements: at least 10,000 IDs per second per process, a response in about 2 ms, k-sorted within 1 second (aiming for tens of milliseconds) `[CONFIRMED]`.
- Flickr ticket servers: two servers, one issuing odd IDs and one even, in production since January 2006 `[CONFIRMED]`.
- UUIDv7: 48-bit Unix millisecond timestamp, the rest random or a counter, in 128 bits `[CONFIRMED]`.

**Decisions and trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Single database sequence | Simple, strictly increasing | One writer; a bottleneck and single point of failure |
| Ticket servers (odd/even) | Simple, sequential per server, small keys | Not strictly ordered across servers; the servers must be run and are on the write path |
| Snowflake-style | No coordination per ID, compact 64-bit, roughly sortable | Depends on clocks; needs unique machine ids |
| Random UUIDv4 | No coordination at all | 128 bits, poor index locality |
| UUIDv7 | No coordination, time-ordered, standard | 128 bits; clock dependence for ordering |

**Common mistakes**
- Assuming timestamps from different machines give a strict global order.
- Ignoring what happens when a machine's clock moves backwards.
- Reusing a machine id after a restart without checking it is free.
- Choosing random UUIDs as clustered primary keys for a write-heavy table and then wondering why inserts are slow.

---

## 🧒 Non-technical explanation

Imagine many ticket booths issuing numbered tickets with **no phone line between them**. If each booth just counted up from 1 there would be duplicates. Instead each ticket is stamped *time, booth number, and a counter for tickets in that same moment*. Two booths can never produce the same stamp because their booth numbers differ, and tickets are in nearly the right time order. The only way it breaks is if a booth clock jumps backwards, so a careful booth refuses to issue tickets until its clock catches up.

---

## TL;DR for engineers

- **Snowflake:** uncoordinated generation of 64-bit, roughly time-sorted ids from timestamp, worker number and per-thread sequence; worker numbers assigned at startup via ZooKeeper `[CONFIRMED]`.
- **Ticket servers:** `REPLACE INTO` on a one-row table gives an atomic auto-increment; two servers split odd and even `[CONFIRMED]`.
- **UUIDs:** 128-bit identifiers; RFC 9562 recommends UUIDv7 for new systems that do not need legacy UUIDv1 `[CONFIRMED]`.
- **Clock safety, id exhaustion, shard-encoding ids:** reference guidance `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** generate a unique id on demand · (often) sortable by creation time · usable as a primary key · usable across shards and data centers.

**Non-functional:** **throughput** (thousands to millions per second) · **latency** (a local call, ideally) · **availability** (id generation must not be a single point of failure) · **size** (fits in 64 bits for compact indexes, or accept 128) · **ordering** guarantee (none, k-sorted, strict) · **security** (should ids be guessable?).

**Clarifying questions:** is ordering required, and how strict? What is the id's size limit? How many writers? Are ids exposed to users (enumeration risk)? Can generation depend on a service?

---

## 2. Snowflake (Twitter, 2010) `[CONFIRMED]`

Twitter was moving from MySQL to Cassandra or sharded MySQL, neither of which has a built-in way of generating unique ids, and needed to generate "tens of thousands of ids per second in a highly available manner", which led them to "an uncoordinated approach". The requirements in the project README: at least 10,000 ids per second per process; a response in 2 ms plus network latency; **uncoordinated** generation across machines, for availability within and across data centers; **roughly time ordered**, with ids k-sorted within a promised bound of 1 second (shooting for tens of milliseconds), because API resources assume an ordering; **directly sortable**; **compact** (under 64 bits; 128-bit schemes were rejected, partly because growing the bits used for tweet ids had been painful before); and **highly available**.

**Options they considered:** MySQL ticket servers "like flickr uses", which did not give the ordering guarantees they needed without a re-syncing routine; UUIDs, where "all the schemes we could find required 128 bits"; and ZooKeeper sequential nodes, which they could not get to perform well enough, and they "feared that the coordinated approach would lower our availability for no real payoff".

**Layout:** a Thrift server written in Scala; each id is composed of **time, 41 bits** (millisecond precision with a custom epoch, "69 years"), **configured machine id, 10 bits** (up to 1,024 machines), and **sequence number, 12 bits** (rolls over every 4,096 per machine, with protection to avoid rollover within the same millisecond). Sequence numbers are per thread; worker numbers are chosen at startup via ZooKeeper (overridable in configuration).

**Clock dependency:** the README says to use NTP and notes that Snowflake protects against non-monotonic clocks: if the clock runs backwards, Snowflake "will refuse to generate ids until a time that is after the last time we generated an id". It also suggests running NTP in a mode that never moves the clock backwards.

Our arithmetic: 2^41 ms ≈ 2.2 × 10^12 ms ≈ 69.7 years, and 4,096 ids per ms per machine is about 4.1 million ids per second per machine at most, far above the 10,000 per second requirement.

## 3. Flickr ticket servers (2010) `[CONFIRMED]`

Flickr needed globally unique integers as primary keys across sharded MySQL databases built as master-master pairs; MySQL auto-increment cannot guarantee uniqueness across databases. They rejected GUIDs "mostly because GUIDs are big, and they index badly in MySQL", and rejected consistent hashing as better suited to write-cheap environments such as LSM-trees. Their solution: a dedicated database server with a table per sequence (for example `Tickets64`) containing a single row; `REPLACE INTO Tickets64 (stub) VALUES ('a'); SELECT LAST_INSERT_ID();` atomically produces a new auto-incremented id. To avoid a single point of failure they run **two ticket servers**, one with auto-increment-increment 2 and offset 1, the other with offset 2 (odd and even ids), and round-robin between them; the two drift slightly out of sync (a few hundred thousand more odd than even ids at the time), "but this hurts no one". They keep separate sequences for photos, accounts, offline tasks and groups. The design had been in production since 13 January 2006 and the author describes it as a great example of the Flickr engineering "dumbest possible thing that will work" design principle.

## 4. UUIDs (RFC 9562) `[CONFIRMED]`

UUIDs are 128-bit identifiers. The RFC says UUIDv6 is a field-compatible reordering of UUIDv1 for better database locality, and that systems that do not involve legacy UUIDv1 "SHOULD use UUIDv7". UUIDv7 "features a time-ordered value field derived from the widely implemented and well-known Unix Epoch timestamp source", with a Unix timestamp in milliseconds in the most significant 48 bits and the remaining 74 bits (excluding version and variant bits) filled with random bits, or alternatively with sub-fields such as a counter to guarantee monotonicity. Time-ordering is what addresses the index-locality complaint Flickr made about GUIDs.

---

## 5. Choosing and operating `[INDUSTRY PATTERN]`

| Need | Reasonable choice |
|---|---|
| Low volume, one writer | Database sequence |
| Compact 64-bit keys, many writers, rough ordering | Snowflake-style |
| Standard format, no coordination, 128 bits acceptable | UUIDv7 |
| Ids that must not be guessable | Random (UUIDv4) or an opaque mapping; do not expose sequential ids |
| Shard-aware ids | Reserve bits for the shard, as Instagram did (41 bits time, 13 bits shard, 10 bits sequence; see [11 News feed](11-news-feed.md)) so a record's shard is derivable from its id |

**Operating a Snowflake-style service.**
- **Machine ids:** assign uniquely and verify at startup (a coordination service, a lease table or a configuration system; see [33 Coordination](33-distributed-coordination-locks.md)). Reusing an id while the old process lives gives duplicates.
- **Clocks:** use NTP; on a backward step refuse to issue ids or wait, as Snowflake does; alert on clock skew. Leap-second smearing keeps time monotonic.
- **Exhaustion:** the sequence part limits ids per millisecond per machine; when exhausted, wait for the next millisecond. The time part has a fixed horizon (about 69 years from the epoch).
- **Local libraries versus a service:** embedding the generator in each application avoids a network hop but spreads machine-id assignment; a small service centralises it.
- **Ordering expectations:** ids are only roughly ordered across machines; do not use them to infer exact causality.

---

## 6. Failure scenarios

- **Clock goes backwards.** Refuse to issue ids until time passes the last timestamp used `[CONFIRMED]` (Snowflake).
- **Two workers share a machine id.** Duplicates are possible; assignment must be exclusive `[INDUSTRY PATTERN]`.
- **A ticket server is down.** The other one continues and ids keep coming from its parity; clients round-robin around it `[CONFIRMED]` (Flickr).
- **Sequence overflow within a millisecond.** Block until the next millisecond `[CONFIRMED]` (Snowflake's protection) / `[INDUSTRY PATTERN]` for the general rule.
- **ID service unreachable.** Clients with an embedded generator keep working; clients depending on a service need buffering of pre-allocated blocks `[INDUSTRY PATTERN]`.

---

## 7. Capacity reasoning (illustrative)

- A Snowflake worker can issue up to 4,096 ids per millisecond, about 4.1 million per second; a fleet needs few workers for any realistic workload.
- Index size: 8-byte ids versus 16-byte UUIDs. For a table with 1 billion rows the key column alone is 8 GB versus 16 GB, and every secondary index repeats the key (our arithmetic).
- Collision risk for random 122-bit UUIDs is negligible at practical scales (a standard property of random UUIDs; not computed here).

---

## ⚠️ Reviewer notes

1. **The Snowflake blog post and README are from 2010** and describe alpha-quality software that Twitter said it was not yet running in production at that time; the layout is widely copied but later Twitter details were not read.
2. **Flickr's ticket-server numbers** (60+ photos a second, a few hundred thousand drift) are from 2010.
3. **Instagram's 41/13/10 layout** is cited from note 11; the original post could not be fetched in this session.
4. **Not read:** RFC 9562's guidance on clock rollback and monotonicity in full, ULID and KSUID specifications, database-native sequences in distributed SQL systems.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **availability**, **performance**, **scalability**, **data locality** (index friendliness).
- **Style (Ch 13):** an **embedded library or tiny stateless service**; the only shared state is machine-id assignment.
- **Quanta (Ch 7):** each worker is independent once it has its id.
- **Trade-off (First Law, Ch 1):** **coordination vs ordering and size.** Removing coordination costs strict ordering and ties correctness to clocks.
- **ADR sketch (Ch 19):** *"We will generate 64-bit time-based ids in each service instance with a machine id leased at startup, and refuse to issue ids when the clock moves backwards. We accept rough ordering and clock dependence in exchange for no per-id coordination."*
- Plain English: stamp every ticket with time, booth and counter.

---

## Interview questions to practice

1. Design a unique ID generator for a distributed system.
2. Why not use a database auto-increment? Why not UUIDv4?
3. What are the parts of a Snowflake id and what does each limit?
4. What happens if the system clock moves backwards?
5. How do you assign machine ids safely?
6. Are Snowflake ids strictly ordered? What do you promise?
7. How would you generate ids that encode the shard?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: ordering, size, exposure, volume, availability.
2. Estimate: ids per second, peak per machine, key size and index size ([P01](../toolkit/P01-estimation.md)).
3. API: `nextId()` (local call or service), optional batch.
4. Design: layout of bits, machine-id assignment, clock handling, sequence handling.
5. Deep dive: time going backwards, machine-id uniqueness, ordering promise.
6. Failure and scale: duplicate worker ids, service down, 10× rate, epoch horizon.

**If it grows 10×**
- The 12-bit sequence limits per-machine rate; add workers or shift bits from the machine part.
- Reevaluate the bit split if the fleet exceeds 1,024 workers.
- Keep ids opaque to clients so the layout can change.

**Answer outlines** (try the questions above first)

<details><summary>What if the clock moves backwards?</summary>

The generator could repeat a timestamp and, with the same machine id and sequence, repeat an id. Remember the last timestamp used; if the clock is behind it, wait until it passes (or fail the request), and alert on the skew. Prefer NTP configurations that do not step backwards.

</details>

<details><summary>How do you assign machine ids safely?</summary>

Use a lease from a coordination service or a database row with a conditional update, held for the process lifetime, and refuse to start without one. Never rely on hostnames or IPs alone, because they can be reused while an old instance still runs.

</details>

<details><summary>Snowflake or UUIDv7?</summary>

If keys must be 64 bits and you can operate machine-id assignment, Snowflake-style. If you want a standard format, no assignment step and can afford 128 bits, UUIDv7, which has the same time-ordering benefit for indexes.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [01 URL shortener](01-url-shortener.md) (key generation), [11 News feed](11-news-feed.md) (ids with shard bits), [33 Coordination](33-distributed-coordination-locks.md), [03 Distributed key-value store](03-distributed-kv-store.md), [P02 Storage engines](../toolkit/P02-storage-engines.md).

## Sources and provenance

> **Kind:** real systems (Snowflake, Flickr) and a standard (UUID), with a reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Twitter Engineering, [*Announcing Snowflake*](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake) (1 June 2010; Internet Archive copy) · Twitter, [Snowflake README](https://raw.githubusercontent.com/twitter-archive/snowflake/snowflake-2010/README.mkd) (2010 branch) · Flickr, [*Ticket Servers: Distributed Unique Primary Keys on the Cheap*](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/) (8 February 2010) · IETF, [RFC 9562, Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562.txt).
> **Dated material:** 2010 engineering posts; the RFC is recent.
> **Not read:** the Instagram sharding and IDs post (blocked), later Snowflake descendants, ULID and KSUID, and RFC 9562's full guidance.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Snowflake post and README: the motivation, requirements, options considered, the 41/10/12 layout, ZooKeeper machine ids, and the clock-backwards behaviour.
- Verified in the Flickr post: the reasons against GUIDs and consistent hashing, the `REPLACE INTO` mechanism, the odd/even pair, drift, separate sequences and the 2006 start.
- Verified in RFC 9562: UUIDv7's definition and layout, the UUIDv6 statement and the SHOULD recommendation.
- Not sourced (our reasoning): the choice table, operating guidance, capacity arithmetic and interview outlines.
- Not claimed: Twitter's or Instagram's current id generation.
