# 32 — Distributed Cache (Memcache at Facebook)

*Real-system note from Facebook's "Scaling Memcache" paper (NSDI 2013), plus a reference design for the general problem. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A distributed cache sits between application servers and a slower datastore to absorb reads. Facebook's design is a **demand-filled look-aside cache**: the application checks the cache, on a miss reads the database and fills the cache, and on a write updates the database and **deletes** the cached entry. The hard problems are consistency (stale values from racing writes), load spikes on hot keys (thundering herds), server failure (a failed cache server sends all its traffic to the database), and keeping caches in many clusters and regions consistent with the database. Facebook added **leases**, a **gutter** pool, a **regional pool**, and an invalidation pipeline driven by the database commit log.

**Key numbers** (as published, 2013)
- The system handles over a billion requests per second and stores trillions of items `[CONFIRMED]`.
- Leases cut the peak database query rate for keys prone to thundering herds from 17K/s to 1.3K/s over a week `[CONFIRMED]`.
- The gutter pool is about 1% of the memcached servers in a cluster; it reduced client-visible failures by 99% and converted 10% to 25% of failures into hits each day `[CONFIRMED]`.
- Only 4% of the deletes issued by the invalidation pipeline actually invalidated cached data `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Look-aside cache, delete on write | Deletes are idempotent; the cache stays a disposable copy | A race can still leave stale data without leases |
| Leases (64-bit tokens) | Prevent stale sets and throttle herds | More protocol and client logic |
| Gutter pool for failed servers | Avoid rehashing hot keys onto live servers and avoid a database surge | Slightly stale data from quickly expiring entries |
| Regional pool for rarely used keys | Avoids over-replicating cold data in every cluster | Higher latency for those keys |
| Invalidate from the database commit log | Reliable and ordered with the writes | Extra pipeline to run |

**Common mistakes**
- Updating the cache on write instead of deleting, which makes ordering races worse.
- Treating the cache as the source of truth.
- Ignoring what happens when a cache server dies: the database sees its traffic at once.
- Rehashing keys onto remaining servers after a failure, which can overload the server that inherits a hot key.

---

## 🧒 Non-technical explanation

Imagine a **library with a popular-books shelf near the door**. Most visitors take a book from the shelf; if it is not there, a clerk fetches it from the stacks and puts a copy on the shelf. When a book is revised in the stacks, the clerk removes the old copy from the shelf rather than editing it. If a hundred people ask for a missing book at once, the clerk gives **one** of them a ticket to fetch it and tells the rest to wait a moment, so the stacks are not stormed. If a whole shelf collapses, a small emergency shelf takes over for a short time so the stacks are not flooded.

---

## TL;DR for engineers

- **Pattern:** demand-filled look-aside cache; write path updates the database then deletes the key `[CONFIRMED]`.
- **Leases** arbitrate concurrent fills and limit herds `[CONFIRMED]`.
- **Gutter** absorbs traffic of failed cache servers `[CONFIRMED]`.
- **Invalidation** is driven from the database commit log by a daemon that batches deletes `[CONFIRMED]`.
- **Regions:** one master region; non-master regions are kept up to date from a data stream `[CONFIRMED]`.
- **Eviction policy, TTLs, sizing, hit-rate monitoring:** general practice `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** `get`, `set`, `delete` of small values by key · very low latency · tolerate being wrong occasionally but converge quickly.

**Non-functional:** **throughput** (millions of requests per second) · **latency** (sub-millisecond on a hit) · **availability** (the database must survive cache failures) · **consistency** bounded staleness after writes · **cost** (memory).

**Clarifying questions:** read/write ratio? Hot-key skew? Acceptable staleness? What happens if the cache is cold or down? Single region or many? What is the source of truth?

---

## 2. The base pattern `[CONFIRMED]` (Nishtala et al., NSDI 2013)

Facebook "use[s] memcache as a demand-filled look-aside cache". When a web server needs data it first asks memcache for the key; on a miss "the web server retrieves the data from the database or other backend service and populates the cache with the key-value pair". For writes, the web server updates the database and then "sends a delete request to memcache that invalidates any stale data". They choose to delete rather than update "because deletes are idempotent", and memcache "is not the authoritative source of the data and is therefore allowed to evict cached data".

**Fan-out and incast.** Web servers talk to many memcached servers; clients use UDP for gets to cut latency and overhead, route sets and deletes over TCP through a proxy called mcrouter, and use a sliding window to limit the number of outstanding requests and avoid incast congestion.

---

## 3. Stale sets and thundering herds: leases `[CONFIRMED]`

A **stale set** occurs when a web server sets a value that does not reflect the latest value, which can happen when concurrent updates to memcache are reordered. A **thundering herd** occurs when a key with heavy read and write activity is repeatedly invalidated, so many reads fall through to the database. Leases address both:
- On a miss, the memcached server gives the client a **lease**, a 64-bit token bound to the key. The client presents the token when it sets the value; the server can refuse the set if it has invalidated the token because it received a delete for the key. The paper compares this to how load-link/store-conditional operates.
- To limit herds, each server returns a token only once every 10 seconds per key by default; other requests in that window receive a notification telling the client to wait briefly, and typically find the data present when they retry.

Measured effect over a week on keys prone to herds: peak database query rate 17K/s without leases and 1.3K/s with them.

---

## 4. When cache servers fail: gutter `[CONFIRMED]`

Replacing failed servers takes up to a few minutes, long enough for cascading failures. Facebook dedicates a small set of machines, **Gutter**, about 1% of the cluster, to take over for a few failed servers. If a client gets no response to a get, it assumes the server failed and retries against the Gutter pool; on a miss there it queries the database and inserts the result into Gutter, where entries expire quickly to avoid needing invalidations (at the cost of slightly stale data). The paper contrasts this with rehashing keys onto remaining servers, which risks cascading failure because key popularity is uneven (a single key can account for 20% of a server's requests): "by shunting load to idle servers we limit that risk." Reported effect: client-visible failures down 99%, and 10% to 25% of failures converted into hits each day.

---

## 5. Many clusters and regions `[CONFIRMED]`

- **Replication within pools:** the paper replicates a category of keys within a pool when the application routinely fetches many keys at once, the whole data set fits in one or two memcached servers, and the request rate is much higher than one server can manage; it favours replication over further dividing the key space in that case.
- **Invalidation pipeline:** SQL statements that modify state are amended with the memcache keys to invalidate after commit; an invalidation daemon (**mcsqueal**) runs on every database, reads the committed statements, extracts the deletes and broadcasts them to memcache in every frontend cluster in the region, batching them into fewer packets through dedicated servers. Only 4% of deletes issued actually invalidate cached data.
- **Regional pools:** over-replicating data in every frontend cluster is memory-inefficient, especially for large, rarely accessed items, so several frontend clusters can share a regional pool; crossing cluster boundaries costs latency and the paper notes 40% less average bandwidth across cluster boundaries than within one.
- **Geographic regions:** clusters are grouped into regions, with a master region providing a data stream to keep non-master regions up to date.

---

## 6. Reference design for any distributed cache `[INDUSTRY PATTERN]`

```
app ─► cache client / proxy ─► cache servers (consistent hashing, replicas for hot keys) ─► database
          │                          │ miss: lease/lock → load → fill
          └─ fallback pool on failure └─ invalidation stream from the database log
```

- **Partitioning:** consistent hashing over cache servers so adding or removing a server moves few keys (see [03 Key-value store](03-distributed-kv-store.md)).
- **Eviction:** LRU or a variant with a memory limit; choose TTLs from the staleness the product accepts.
- **Hot keys:** replicate hot keys, add a small in-process cache, coalesce concurrent misses (request coalescing or leases).
- **Stampede protection:** leases, locks or probabilistic early refresh so that one request refills a key.
- **Negative caching:** cache "not found" briefly so misses on absent keys do not hit the database repeatedly.
- **Write strategies:** look-aside with delete (above), write-through (write cache and database together), write-behind (asynchronous; risks loss); the choice follows from consistency and durability needs.
- **Cold start:** warm a new cache cluster from an existing one or from the database gradually; do not point full traffic at an empty cache.
- **Monitoring:** hit rate, eviction rate, latency percentiles per tier, database load behind the cache.

---

## 7. Failure scenarios

- **A cache server dies.** Gutter or a replica takes over; the database is protected from a sudden surge `[CONFIRMED]`.
- **Racing read and write.** Without leases a stale value is set after a delete; with leases the set is rejected `[CONFIRMED]`.
- **Hot key expires or is invalidated.** Leases make one client refill it `[CONFIRMED]`.
- **The invalidation stream lags.** Reads see stale data until it catches up; monitor lag and bound TTLs `[INDUSTRY PATTERN]`.
- **Whole cache cluster cold.** The database receives full traffic; warm gradually and rate limit `[INDUSTRY PATTERN]`.

---

## 8. Capacity reasoning (illustrative)

- Cache memory ≈ working set size, not total data size. If 20% of 10 TB of records gets 80% of reads, a 2 TB cache serves most reads (assumed skew).
- Database load behind the cache ≈ request rate × miss rate. At 1 million reads per second and a 99% hit rate, the database sees 10,000 reads per second; at 95% it sees 50,000, five times more. Small changes in hit rate matter a lot.
- Server count ≈ working set ÷ memory per server, with spare capacity for failures.

---

## ⚠️ Reviewer notes

1. **The paper is from 2013** and describes Facebook's deployment; its details (UDP gets, mcrouter, mcsqueal) are not a general recipe.
2. **"Delete instead of update" is a trade-off,** not a law: it reduces ordering problems but makes the next read pay the miss.
3. **Numbers are the authors' measurements** on their workload.
4. **Not read:** Facebook's TAO paper (a cache with a graph data model), Redis documentation, and other cache designs; their behaviour is not claimed.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the paper. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance**, **scalability**, **availability** (of the database behind it), **consistency** (bounded).
- **Style (Ch 13):** a **service-based** caching tier with stateless proxies and partitioned stateful servers.
- **Quanta (Ch 7):** each cache cluster is a quantum; the database invalidation stream couples them.
- **Trade-off (First Law, Ch 1):** **freshness vs load.** Longer TTLs and leases reduce database load and increase staleness.
- **ADR sketch (Ch 19):** *"We will use a look-aside cache with delete-on-write, leases for fills, and a gutter pool for failures. We accept short windows of stale data in exchange for protecting the database."*
- Plain English: a front shelf that is cheap to rebuild, with a ticket system and a spare shelf.

---

## Interview questions to practice

1. Design a distributed cache for a read-heavy service. Where does it sit and how does data get in?
2. Look-aside, write-through or write-behind? What goes wrong with each?
3. How do you prevent a cache stampede on a hot key?
4. How can a cache hold stale data after a write, and how do you stop it?
5. A cache server fails. What happens to the database and what do you do about it?
6. How would you keep caches in several regions consistent with the database?
7. How do you decide the size of the cache and the TTL?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the paper.

**A 45-minute walkthrough**

1. Clarify: read/write ratio, skew, staleness tolerance, durability, regions.
2. Estimate: requests per second, working set, hit rate and resulting database load ([P01](../toolkit/P01-estimation.md)).
3. API: get, set with TTL, delete; the application owns the fill logic.
4. Design: client or proxy, partitioned cache servers, database, fallback pool, invalidation stream.
5. Deep dive: stale sets and stampedes (leases), hot keys, failure handling.
6. Failure and scale: server loss, cold start, cross-region invalidation, 10× load.

**If it grows 10×**
- Hit rate and hot keys dominate: replicate hot keys and add client-side caches.
- Cross-region invalidation lag grows; batch, order and monitor it.
- Memory cost grows: tier hot and warm data, compress values.

**Answer outlines** (try the questions above first)

<details><summary>How can a look-aside cache hold stale data?</summary>

A reader misses, reads the old value from the database and is delayed; a writer updates the database and deletes the key; the reader then writes the old value into the cache. Fix with leases (the delete invalidates the reader's token so its set is refused), versioned values, or short TTLs.

</details>

<details><summary>What happens when a cache server fails?</summary>

Its keys miss and the database absorbs the load. Protect it with a small standby pool that serves misses for failed servers with short TTLs, replicas for hot keys, and rate limits to the database. Avoid rehashing onto live servers if hot keys could overload one of them.

</details>

<details><summary>How do you prevent a stampede on a hot key?</summary>

Let one request refill the key and make others wait briefly or serve slightly stale data: leases or locks, request coalescing in the proxy, or refreshing before expiry with jitter.

</details>

## 📚 Further reading

- The paper listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [03 Distributed key-value store](03-distributed-kv-store.md), [01 URL shortener](01-url-shortener.md) (caching), [11 News feed](11-news-feed.md) (timeline caches), [P02 Storage engines](../toolkit/P02-storage-engines.md).

## Sources and provenance

> **Kind:** real system (Facebook, 2013) with a reference design for the general problem `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Nishtala et al., [*Scaling Memcache at Facebook*](https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf) (NSDI 2013).
> **Dated material:** the paper is from 2013; Facebook's deployment has certainly changed.
> **Not read:** Facebook's TAO paper, Redis and other cache documentation, cache-eviction research, and the paper's sections on cold-cluster warmup and cross-region consistency in detail.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting the paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the paper: the abstract's scale claims, the look-aside pattern and delete rationale, UDP gets and mcrouter, leases (stale sets, herds, 64-bit token, 10-second rate), the 17K/s to 1.3K/s result, Gutter (about 1%, 99% and 10% to 25% figures, contrast with rehashing, the 20% example), the mcsqueal pipeline and the 4% figure, regional pools, and the master-region description.
- Labelled industry pattern, not sourced: the reference design, write-strategy comparison, negative caching, and the capacity arithmetic.
- Not claimed: how any current Facebook or Meta cache works.
