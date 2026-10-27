# 34 — Top-K, Heavy Hitters and Leaderboards

*Reference design built on two published building blocks: Redis sorted sets for exact ranking and the Space-Saving algorithm for approximate heavy hitters in streams. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Two questions look alike but need different designs. A **leaderboard** (*who are the top 100 players, and what is my rank?*) needs exact, ordered scores that change constantly. A **heavy-hitters / top-K** question (*which 10 search queries or videos are most popular in the last hour?*) runs over an event stream whose set of distinct items is too large to count exactly. For the first, use an ordered structure (a skip list in a sorted set, O(log N) per update) and shard it when it outgrows a node. For the second, keep a bounded set of counters (Space-Saving) per window and merge partial results. Windows, partitioning and the accuracy you promise are the interview.

**Key numbers** (as published)
- Redis sorted set operations are mostly O(log n); a ZADD on an existing member updates its score and position in O(log n), and `ZRANGE` is O(log n + m) for m results returned `[CONFIRMED]`.
- Space-Saving monitors only a fixed number m of elements and, for realistic Zipfian data, needs far less space as the skew grows `[CONFIRMED]`; it was motivated by Internet advertising click streams `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Exact ordered set (sorted set) for leaderboards | Rank and range queries are cheap and exact | All data in memory on one node until sharded |
| Approximate counters (Space-Saving) for streams | Bounded memory regardless of distinct items | Counts have bounded error; ranks near the cut-off may be wrong |
| Tumbling windows with merged buckets | Simple expiry of old data | Windows are coarse; merging adds error |
| Shard by item (key) | Each item's count lives in one place | Hot items; top-K needs a final merge |
| Cache the top-K result | Reads are very frequent | Staleness |

**Common mistakes**
- Sorting all items for every query.
- Merging per-shard top-K lists when items are split across shards by *event* rather than by key: an item that is in no shard's top K can still be globally top K.
- Promising exact counts from an approximate structure.
- Forgetting expiry: "top in the last hour" needs windows or decay.

---

## 🧒 Non-technical explanation

A **leaderboard** is a scoreboard in a bowling alley: every score is written down, the board stays sorted, and anyone can ask "what is my rank?" Heavy hitters are different: imagine counting the most popular items passing on a conveyor belt at a factory where there are far too many different items to keep a tally for each. You keep a small notepad with a fixed number of lines. When an unknown item arrives and the pad is full, you cross out the item with the lowest tally and reuse its line, remembering that the new item's count could be overstated by at most that tally. At the end the biggest tallies on your pad are the popular items, and you know how far off each might be.

---

## TL;DR for engineers

- **Exact leaderboard:** sorted set (skip list + hash table), O(log N) update and rank `[CONFIRMED]` (Redis documentation).
- **Approximate top-K over a stream:** Space-Saving with a fixed number of counters `[CONFIRMED]` (Metwally et al.).
- **Windows:** tumbling or sliding time buckets, merged on query `[INDUSTRY PATTERN]`.
- **Scale-out:** partition by key, compute local summaries, merge `[INDUSTRY PATTERN]`.
- **Serving:** cache the result with a short TTL `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** update a score or count · get the top K · get a member's rank (leaderboard) · scope by time window (last hour, today, all time) · scope by category or region.

**Non-functional:** **low update latency** at high rates · **fast reads** of the top K · **bounded memory** · **accuracy target** (exact for a leaderboard, bounded error for streams) · **availability**.

**Clarifying questions:** exact or approximate? Window length? Number of distinct items, and the update rate? Is the top K per category? How fresh must results be? Are ties broken, and how?

---

## 2. Exact ranking: the sorted set `[CONFIRMED]` (Redis documentation)

Redis sorted sets hold unique members with a numeric score and keep them ordered; the documentation says the implementation uses "a skip list and a hash table", so each add costs O(log N) and "when we ask for sorted elements, Redis does not have to do any work at all, it's already sorted". Calling ZADD on an existing member updates its score and position in O(log N), so "sorted sets are suitable when there are tons of updates", and leaderboards are named as the common use case: take users sorted by high score, plus get-rank (`ZRANK`/`ZREVRANK`), to show the top N and a user's own rank. Most operations are O(log n); `ZRANGE` is O(log n + m) for m returned results, so avoid asking for tens of thousands at once. Redis also lists sliding-window rate limiters as a use of sorted sets (compare [02 Rate limiter](02-rate-limiter.md)).

**Limits (our reasoning `[INDUSTRY PATTERN]`):** a sorted set lives in one node's memory and is updated by one thread, so a leaderboard with hundreds of millions of members or a very high update rate needs sharding (below).

---

## 3. Approximate heavy hitters: Space-Saving `[CONFIRMED]` (Metwally, Agrawal, El Abbadi, ICDT 2005)

The paper addresses finding the most popular k elements and the frequent elements in a data stream. It states the technique is efficient and exact if the alphabet is small, and for the practical large-alphabet case is space-efficient and "reports both top-k and frequent elements with tight guarantees on errors". The idea: monitor only **m** elements at a time, maintain counters so as to accurately estimate the frequencies of the significant elements, and use a lightweight structure (Stream-Summary) that keeps the elements sorted by estimated frequency. For general distributions its top-k answer can be a set of k' ≈ k elements guaranteed to be the top-k'; for realistic Zipfian data the space needed drops dramatically as the skew increases, and top-k queries return only the top-k elements in the correct order. The authors were motivated by Internet advertising commissioners, who see streams of ad renderings, clicks, sales and leads, and who need summaries of such streams quickly; see [31 Ad click aggregation](31-ad-click-aggregation.md).

**How it works (the standard description; not quoted):** keep m (item, count) pairs. If an arriving item is monitored, increment its count. If not, replace the item with the smallest count by the new item, set its count to that minimum plus one, and remember the minimum as the possible over-count. Counts are therefore upper bounds, and the recorded error tells how far off each is.

The Count-Min Sketch (Cormode and Muthukrishnan) is another widely used structure for approximate frequencies; we could not retrieve its paper and make no claims about it.

---

## 4. Reference design `[INDUSTRY PATTERN]`

```
events ─► partition by item id ─► per-partition counters (exact map or Space-Saving) per time bucket
                                         │ periodic local top-K (with error bounds)
                                         ▼
                          merge service ─► global top-K per window ─► cache ─► API
leaderboard: score updates ─► sharded sorted sets ─► top-N via merge, rank via counts above
```

- **Windows.** For "last hour", keep one bucket per minute and drop buckets older than 60; the answer is the merge of the 60 buckets. For "all time" keep a running structure. For smooth decay, use exponentially weighted counts.
- **Partition by item, not by event.** If events for the same item go to the same shard, each shard's top-K is exact for its items and the global top-K is the top-K of the union of the shards' lists. If events are spread randomly, you must merge counts per item before ranking, because an item can fall below every shard's cut-off yet exceed them in total.
- **Merge.** Collect each shard's top (K + margin) with counts, sum counts for the same item, sort. With approximate counters, carry the error bounds.
- **Leaderboard sharding.** Partition by score range (rank = count of members in higher ranges plus rank inside the range) or by member hash (top-N via merging each shard's top N; a member's global rank needs counts from all shards or an approximation). Combine with a periodic snapshot for "my rank" at huge scale.
- **Ties and fairness.** Define the tie-break (earlier timestamp first), and encode it in the sort key.
- **Serving.** Cache the top-K for each scope with a TTL of seconds; compute on a schedule rather than per request.
- **Durability.** Persist scores in a database; rebuild the in-memory structure on restart; log events for recomputation.
- **Abuse.** Leaderboards invite cheating: validate score updates server-side (see [21 Game matchmaking](21-game-matchmaking-lobby-chat.md), [P06](../toolkit/P06-security-threat-modeling.md)).

---

## 5. Failure scenarios

- **A shard fails.** Its items are missing from the top-K until failover; serve the cached result and mark it stale `[INDUSTRY PATTERN]`.
- **A hot item.** One key receives most events; split the counter across sub-keys and sum on read `[INDUSTRY PATTERN]`.
- **Skewed windows.** Late events change old buckets; define a lateness policy (see [31](31-ad-click-aggregation.md)) `[INDUSTRY PATTERN]`.
- **Approximate error at the cut-off.** Items close to rank K may be misordered; expose that, or verify candidates exactly `[CONFIRMED]` in principle (the algorithm gives bounds), the policy is ours.
- **Thundering reads.** Cache the result and refresh in the background (see [32 Distributed cache](32-distributed-cache.md)) `[INDUSTRY PATTERN]`.

---

## 6. Capacity reasoning (illustrative)

- **Exact counting memory** ≈ distinct items × (key + count). 1 billion distinct queries × 40 bytes ≈ 40 GB per window, too much to keep for 60 one-minute buckets; Space-Saving with, say, 100,000 counters per bucket per shard is a few megabytes. Both numbers are our assumptions.
- **Leaderboard memory** in a sorted set ≈ members × (member id + score + skip-list overhead); with 100 million members at roughly 100 bytes each that is about 10 GB, which fits one large node but not comfortably, so plan shards.
- **Update rate:** 50,000 score updates per second is within reach of one in-memory node for simple updates; plan sharding and replicas beyond that (assumption).

---

## ⚠️ Reviewer notes

1. **The Space-Saving description of the algorithm in section 3** ("how it works") is the standard textbook description; the paper's PDF text lost its word spacing when extracted, so we quote only its abstract-level claims.
2. **Redis documentation describes Redis,** not leaderboards in general; sharding strategies are ours.
3. **Count-Min Sketch is not covered:** we could not retrieve its paper.
4. **Not read:** Redis Cluster documentation, the Frequent/Lossy Counting papers, time-decay literature, and production leaderboard postmortems.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance**, **scalability**, **accuracy (bounded)**, **cost** (memory).
- **Style (Ch 13):** a **pipeline** of partitioned summarisers feeding a merge service and a read cache.
- **Quanta (Ch 7):** summarisers scale independently of the read tier; the merge point is the coordination cost.
- **Trade-off (First Law, Ch 1):** **accuracy vs memory.** Exact counts cost memory proportional to distinct items; bounded-error summaries give constant memory.
- **ADR sketch (Ch 19):** *"We will use per-minute Space-Saving summaries partitioned by item, merged into hourly top-K, and cache the result for ten seconds. We accept bounded error near the cut-off in exchange for constant memory."*
- Plain English: a notepad with a fixed number of lines, merged every minute.

---

## Interview questions to practice

1. Design a system that shows the top 10 trending searches in the last hour.
2. Design a leaderboard for a game with 100 million players, including each player's rank.
3. How do you keep memory bounded when there are billions of distinct items?
4. Why can merging per-shard top-K lists be wrong, and how do you avoid it?
5. How would you handle a window that slides continuously?
6. What accuracy can you promise with an approximate counter?
7. How do you handle ties and cheating?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the sources.

**A 45-minute walkthrough**

1. Clarify: exact or approximate, window, scopes, update rate, distinct items.
2. Estimate: events per second, distinct items, memory per approach ([P01](../toolkit/P01-estimation.md)).
3. API: record event or score, get top K, get rank.
4. Design: partition by item, per-bucket summaries, merge service, cache; or sharded sorted sets for leaderboards.
5. Deep dive: Space-Saving and error, window handling, merge correctness, hot keys.
6. Failure and scale: shard loss, late events, 10× event rate, cheating.

**If it grows 10×**
- More partitions and a two-level merge; keep K small and push filtering down.
- Replace exact maps with approximate summaries; shorten windows.
- Rank queries move to approximate (percentile) ranks for most players.

**Answer outlines** (try the questions above first)

<details><summary>Why can per-shard top-K merging be wrong?</summary>

If an item's events are split across shards, its count in each shard may be too small to appear in that shard's top-K even though the total is large. Partition by item so all of an item's events meet in one shard, or ask each shard for more than K candidates and merge exact counts per item, and state the remaining error.

</details>

<details><summary>How do you keep memory bounded with billions of distinct items?</summary>

Keep a fixed number of counters per window with a stream-summary algorithm such as Space-Saving: monitor only the heavy items, replace the smallest counter when a new item arrives, and keep an error bound per item. Memory depends on the number of counters, not on distinct items.

</details>

<details><summary>How do you give a player their rank in a sharded leaderboard?</summary>

With score-range shards, rank is the number of members in higher ranges plus the rank inside the player's shard. With hash shards, sum the count of members with a higher score from every shard (a count query per shard), or give an approximate percentile from periodic snapshots.

</details>

## 📚 Further reading

- The sources listed under Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [31 Ad click aggregation](31-ad-click-aggregation.md), [30 Metrics monitoring](30-metrics-monitoring-alerting.md), [21 Game matchmaking and lobby chat](21-game-matchmaking-lobby-chat.md), [32 Distributed cache](32-distributed-cache.md), [20 Web crawler and search](20-web-crawler-search.md).

## Sources and provenance

> **Kind:** reference design built on published building blocks `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Redis documentation, [Sorted sets](https://redis.io/docs/latest/develop/data-types/sorted-sets/) · Metwally, Agrawal and El Abbadi, [*Efficient Computation of Frequent and Top-k Elements in Data Streams*](https://www.cse.ust.hk/~raywong/comp5331/References/EfficientComputationOfFrequentAndTop-kElementsInDataStreams.pdf) (ICDT 2005; PDF text extracted locally, with word spacing lost in places).
> **Dated material:** the paper is from 2005; the Redis page as of 2026-10-27.
> **Not read:** the Count-Min Sketch paper, Redis Cluster documentation, other streaming-summary papers and production postmortems.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Redis page: skip list plus hash table, O(log N) adds and score updates, pre-sorted retrieval, leaderboard use case and rank commands, ZRANGE complexity, the sliding-window rate limiter mention.
- Verified in the Space-Saving paper (abstract and introduction): exactness for small alphabets, space efficiency and error guarantees for large alphabets, monitoring of m elements, the k' ≈ k property, Zipfian space reduction, the advertising motivation.
- Not sourced (our reasoning): the algorithm walkthrough, the reference design, sharding strategies and capacity arithmetic.
- Not claimed: behaviour of Redis Cluster or any production leaderboard.
