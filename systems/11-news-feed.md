# 11 — News Feed (Twitter / Instagram)

*A reference design built on verified building blocks. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A news feed has two jobs: finding candidate posts and ranking them. Candidate generation is a fan-out problem: pushing each post into followers' timeline caches (fan-out on write) makes reads fast but amplifies writes for large accounts, so real systems mix it with pull-on-read. Twitter's published pipeline then hydrates features, scores, filters and mixes. IDs must sort by time and encode the shard.

**Key numbers**
- Twitter timeline cache (Haplo) on Redis: 40M–100M commands/s aggregate (2017) `[CONFIRMED]`.
- About 50% of For You posts come from the in-network search-index source; ~6,000 features are hydrated `[CONFIRMED]` (2023 code).
- Instagram IDs: 41 bits time + 13 bits shard + 10 bits sequence `[CONFIRMED]` (2012).

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Fan-out on write | Very fast reads | Write amplification for large accounts |
| Hybrid for very large accounts | Bounds both costs | Two code paths and a tuned threshold |
| Store post IDs in timelines | Edits and deletes need no fan-out | Hydration on every read |

**Common mistakes**
- Stating a follower threshold for Twitter's hybrid: the sources we read do not give one.
- Using offset pagination on a feed that changes constantly.
- Treating the ranking model as the only 'feed' problem and ignoring candidate retrieval.


---

## 🧒 Non-technical explanation

A news feed is a **personalised newspaper** assembled for each reader. There are two ways to run the print shop:

- **Print on write:** when someone you follow publishes, the shop immediately drops a copy into **your** mailbox. Reading is instant, but a person with ten million followers means ten million copies get printed the moment they speak.
- **Gather on read:** nothing is pre-printed. When you open the paper, an assistant runs around collecting the latest from everyone you follow. Writing is cheap, reading is slow.

Real services mix the two, and then add an **editor** who picks, ranks and mixes in recommendations from people you don't follow.

---

## TL;DR for engineers

- **Two jobs:** (1) **candidate generation**, find posts that could appear, and (2) **ranking and mixing**, decide order. The first is a storage/fan-out problem and the second is an ML/serving problem.
- **Fan-out on write** pushes each new post into followers' timeline caches. Twitter's 2017 post names a **Fanout Service** that writes to **Haplo**, the primary cache for Tweet timelines, backed by customised Redis (the **HybridList**), and read by the **Timeline Service** `[CONFIRMED]`.
- **Fan-out on read** computes the timeline at request time from the follow graph. The mix of the two (a hybrid, with high-follower accounts handled on read) is the standard answer `[INDUSTRY PATTERN]`. The posts we read do not describe Twitter's exact hybrid rule.
- **Ranking pipeline (Twitter 2023):** candidate generation → feature hydration (~6,000 features) → ML scoring → filters and heuristics → mixing with ads and modules → serving `[CONFIRMED]` (Home Mixer README).
- **IDs must be sortable by time and shard-aware.** Instagram: **41 bits time + 13 bits logical shard + 10 bits sequence = 64 bits**, generated inside Postgres `[CONFIRMED]`.
- **Caching is the load-bearing layer:** at Twitter cache is "~3% of our infrastructure" yet "critical" `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Functional:** post · follow/unfollow · home feed (infinite scroll, new items at top) · likes/replies · notifications of new posts (see [10 Notification system](10-notification-system.md)).

**Non-functional:** **read latency** for the feed (reads dominate) · availability · eventual consistency is fine (a post may appear a few seconds late) · handle **skew**: a few accounts have millions of followers · cost of storing per-user timelines.

**Estimation approach** `[SPECULATIVE]` (illustrative, state your own assumptions): with 100M daily users each posting about one item per day, that is 100M posts/day ≈ 1,157 posts/s. If the average account has ~200 followers, fan-out on write is ≈ 1,157 × 200 ≈ 231k timeline inserts per second on average, but one account with 10M followers causes a 10M-write burst from a single post, which is the skew problem.

---

## 2. Fan-out strategies

| | **Fan-out on write (push)** | **Fan-out on read (pull)** | **Hybrid** |
|---|---|---|---|
| On post | Insert the post ID into every follower's timeline cache | Store the post once | Push for normal accounts, skip push for very-high-follower accounts |
| On read | Read one precomputed list | Look up the follow list, fetch recent posts of each followee, merge and sort | Read the precomputed list, then merge in recent posts from high-follower accounts you follow |
| Strength | Very fast reads | Cheap writes, no wasted work for inactive users | Bounds both |
| Weakness | **Write amplification** for celebrities, wasted work for inactive followers | Slow, expensive reads, thundering herd on popular accounts | Two code paths and a threshold to tune |
| Evidence | Twitter has a **Fanout Service** writing to the **Haplo** timeline cache `[CONFIRMED]` (2017) | General design `[INDUSTRY PATTERN]` | General design `[INDUSTRY PATTERN]`. Exact Twitter threshold not in the sources we read |

Details worth saying in an interview `[INDUSTRY PATTERN]`:
- Store **post IDs** in timeline caches, not full posts. Hydrate them from a post cache at read time, so edits and deletes need no fan-out.
- Skip fan-out for **inactive** users (not seen in N days) and build their timelines on demand.
- Keep a **bounded** list per user (hundreds of entries). Older items come from the pull path.
- Fan-out is **asynchronous**: the post call returns quickly and a queue feeds fan-out workers.

### What Twitter's published infrastructure shows `[CONFIRMED]` (2017 post)
- **Haplo** is "the primary cache for Tweet timelines and is backed by a customized version of Redis (implementing the HybridList). Haplo is read-only from Timeline Service and written to by Timeline Service and Fanout Service." Its stats at the time: aggregate commands of 40M–100M per second and about 800K service requests per second.
- Caches overall: hundreds of clusters, **320M packets/s**, over **120 GB/s** delivered, latency targets at the 99.9th and 99.99th percentiles, clusters handling **10M–50M QPS** each. The post stresses that cache "protects our backing stores from heavy read traffic and allows for storing objects which have heavy hydration costs".
- **Storage:** **Manhattan** (real-time multi-tenant distributed database, launched April 2014) for Tweets, DMs and accounts. **Flock** social graph on Gizzard/MySQL, "peaks over tens of million QPS" averaging 30k–45k QPS per MySQL server. **Blobstore** for media ("hundreds of billions objects", introduced December 2012 for native photo uploads). **Snowflake** ID service since June 2010.
- **Ops lessons:** thousands of connections per cache instance meant restarts could cause "DDoS-esque connect attacks", so they throttle connections to each cache.

---

## 3. Ranking and mixing: Twitter's open-sourced pipeline `[CONFIRMED]` (2023)

**Home Mixer** is "the main service used to construct and serve Twitter's Home Timelines", built on **Product Mixer**, a Scala framework for building feeds. It powers three timelines:
- **For You:** "best Tweets from people you follow + recommended out-of-network content".
- **Following:** reverse-chronological posts from accounts you follow.
- **Lists:** reverse-chronological posts from List members.

**For You pipeline stages** (Home Mixer README):
1. **Candidate generation**: fetch Tweets from candidate sources.
2. **Feature hydration**: fetch about **6,000 features** used for ranking.
3. **Scoring and ranking** with an ML model.
4. **Filters and heuristics**: author diversity, in-network vs out-of-network balance, feedback fatigue, deduplication, visibility filtering.
5. **Mixing** with ads, who-to-follow modules and prompts.
6. **Serving**: conversation modules, pagination, client instructions.

**Candidate sources named:** the **Earlybird search index** ("Find and rank In-Network posts. ~50% of posts come from this candidate source"), **Tweet-mixer / Cr Mixer** (out-of-network candidates), **UTEG** (an in-memory user–post interaction graph traversed for candidates) and the **Follow Recommendation Service**. Models named in the main README: **Light Ranker** (inside the search index), **Heavy Ranker** (neural net), **SimClusters**, **TwHIN**, **RealGraph**, **Tweepcred**, plus Trust and Safety models and visibility filters.

**Take-away:** the modern home feed is not "a list of followees' posts". Most of the work is **retrieval from several sources, then ranking**. The README does not state the out-of-network share, and it does not say which backend For You uses for in-network candidates, so we state neither.

---

## 4. IDs and sharding: Instagram `[CONFIRMED]` (2012 post)

Instagram sharded Postgres and needed IDs that are **sortable by time**, **64 bits**, and cheap to generate with few moving parts. It considered Twitter's Snowflake and judged it "came the closest", but chose to avoid running a separate ID service.

- **Logical shards:** "several thousand 'logical' shards that are mapped in code to far fewer physical shards", each logical shard a **Postgres schema**. Moving a set of logical shards to another database needs **no re-bucketing**.
- **ID layout:** **41 bits** time in milliseconds (41 years from a custom epoch) + **13 bits** logical shard ID + **10 bits** per-table auto-increment sequence mod 1024 (so up to **1024 IDs per shard per millisecond**).
- **Generated in Postgres** with a PL/pgSQL function per schema, using the table's own sequence.
- **Example in the post:** sharding by user ID with 2000 logical shards, user 31341 → shard 31341 % 2000 = 1341.
- **Why it matters for a feed:** sorting IDs sorts by time, so a "latest posts" list needs no extra sort key, and the shard ID is embedded, so you can find the shard from the ID alone.

Compare with Twitter's Snowflake layout (41 time + 10 worker + 12 sequence, see [01 URL shortener](01-url-shortener.md)).

---

## 5. A reference architecture `[INDUSTRY PATTERN]`

```
Post API ─► post store (sharded) ─► fan-out queue ─► fan-out workers ─► timeline cache (per user, post IDs)
                                         ▲                    │
                follow graph store ──────┘ (who are the followers?)
Feed read: Feed API ─► timeline cache ─► hydrate posts + authors (cache) ─► rank/mix ─► page + cursor
                          └─► merge pull-path posts from high-follower accounts
```

Choices to state: **cursor pagination** (not offset) since new posts arrive constantly · **idempotent fan-out** (a retried worker must not duplicate entries) · **graceful degradation** (serve a stale cached timeline if ranking is down) · **deletes and blocks** applied at read time through hydration.

---

## ⚠️ Reviewer notes

1. **"Twitter uses fan-out on write" is half the story.** The 2017 post confirms a Fanout Service and a timeline cache, but the hybrid rule for very-high-follower accounts is common knowledge from older talks, and we could not verify it from a primary source in this session. Do not state a follower threshold.
2. **Instagram's feed architecture is not described in what we read.** Only its ID and sharding scheme (2012) are. The popular claim that Instagram runs "fan-out on write" in a particular way was not in the sources we read.
3. **The 2023 code release is a snapshot of ranking, not of storage.** It tells you how candidates are generated and scored. It does not describe the timeline cache design, so we do not mix the two.
4. **Numbers age.** The 2017 cache and QPS figures describe that year. The 2012 Instagram figures (25 photos and 90 likes per second) describe Instagram at launch scale.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (feed read latency), **scalability**, **elasticity** around events, **availability**, and **cost** (timeline storage and fan-out compute). Consistency is deliberately relaxed.
- **Style (Ch 14/17):** an **event-driven** write path (post → queue → fan-out workers) and a **service-based / microservices** read path (Timeline Service, hydrators, ranking mixers). Product Mixer's pipeline of sources, scorers and filters is itself a small pipeline architecture (Ch 11).
- **Quanta (Ch 7):** write-side fan-out and read-side serving are separate quanta. If fan-out lags, reads still work, only staler.
- **Trade-off (First Law, Ch 1):** **write amplification vs read latency.** The hybrid exists because neither pure strategy fits skewed follower counts.
- **ADR sketch (Ch 19):** *"We will fan out post IDs on write for accounts below a follower threshold and merge high-follower accounts at read time. We accept two code paths to bound write amplification."*
- Plain English: print a copy for each reader when the author is small, and for superstars, let the reader's assistant fetch the latest page on demand.

---

## Interview questions to practice

1. Design a home feed for 100M daily users. Push, pull or hybrid, and why?
2. A user with 20M followers posts. What happens to your fan-out queue? How do you avoid hurting everyone else's latency?
3. How do you page an infinite-scroll feed while new posts arrive? Why not offset pagination?
4. How do you generate IDs that sort by time across 4,000 shards? Compare Instagram's layout with a central ID service.
5. Where does ranking fit? What are candidate sources, and why more than one?
6. A user deletes a post. How does it disappear from followers' cached timelines?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: follow graph, ranking, freshness, media.
2. Estimate: posts/s × average followers.
3. API: post, home feed with a cursor.
4. Design: post store, fan-out service, timeline cache, hydration.
5. Deep dive: push vs pull vs hybrid, ranking pipeline.
6. Failure and scale: celebrity posts, cache loss, inactive users.

**If it grows 10×**
- Celebrity accounts: skip fan-out and merge at read time.
- Cache memory: bound timeline length and skip inactive users.
- Ranking cost: use a light ranker before the heavy one.

**Answer outlines** (try the questions above first)

<details><summary>A user with 20M followers posts. What happens?</summary>

Do not fan out to all followers. Mark the account as pull-on-read and merge its recent posts into each reader's feed at read time, so one post does not create a 20M-write burst.

</details>

<details><summary>Why cursor pagination?</summary>

New posts arrive while scrolling, so offsets shift and duplicate or skip items. A cursor anchors on an item or ID.

</details>

<details><summary>How does a delete disappear from cached timelines?</summary>

Timelines hold IDs only. Hydration checks the post store, so a deleted post drops out at read time without fan-out.

</details>

## 📚 Further reading

- The three sources listed at the top.
- [Facebook TAO paper](https://www.usenix.org/conference/atc13/technical-sessions/presentation/bronson) and Raffi Krikorian's *Timelines at Scale* (not read in this session).
- [System Design Primer: Twitter timeline and search](https://github.com/donnemartin/system-design-primer) (secondary; interview framing).
- Related in this repo: [`neokim-post/10` Twitter timeline (front-end)](../../neokim-post/10-how-twitter-timeline-works.md) (client side of the same product), [01 URL shortener](01-url-shortener.md) (Snowflake IDs), [03 Distributed KV store](03-distributed-kv-store.md) (consistent hashing, replication).

## Sources and provenance

> **Kind:** reference design anchored by real-system facts. Neither Twitter/X nor Instagram publishes one complete "how the feed works" document. This note combines what each *did* publish and verify: Twitter's infrastructure post (2017) and its open-sourced recommendation code (2023), and Instagram's sharding-and-IDs post (2012). The fan-out strategies are the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:**
> · Twitter Engineering, *The Infrastructure Behind Twitter: Scale* (2017-01-19; [original URL](https://blog.x.com/engineering/en_us/topics/infrastructure/2017/the-infrastructure-behind-twitter-scale) returned 403, so we read the Internet Archive copy of the same page)
> · [twitter/the-algorithm README](https://github.com/twitter/the-algorithm) and [Home Mixer README](https://github.com/twitter/the-algorithm/tree/main/home-mixer) (2023 open-source release)
> · Instagram Engineering, [*Sharding & IDs at Instagram*](https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c) (2012-12-30; the live site refused our connection, so we read the Internet Archive copy)
> **Not read:** Instagram's *Thundering Herds & Promises* post (blocked with 403), Raffi Krikorian's *Timelines at Scale* talk (the InfoQ page had a summary, no transcript), Facebook's TAO paper. Claims that depend on them are `[INDUSTRY PATTERN]`.
> **Dated material:** 2012 Instagram, 2017 Twitter infrastructure, 2023 Twitter ranking code. All have since changed.
> **Tags:** `[CONFIRMED]` stated by the primary source · `[INDUSTRY PATTERN]` standard practice, not stated by the source · `[SPECULATIVE]` plausible.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Twitter infrastructure post and Instagram post read from Internet Archive copies of the original pages. Twitter code READMEs read from GitHub.
- Verified (Twitter 2017): date; Haplo as primary Tweet-timeline cache on customised Redis with HybridList, read-only for Timeline Service and written by Timeline Service and Fanout Service, plus its stats; cache is ~3% of infrastructure; cache aggregate figures (320M packets/s, 120 GB/s, 10M–50M QPS per cluster, 99.9th/99.99th latency goals); Manhattan (April 2014), Flock peaks and per-server QPS, Blobstore (December 2012) and Snowflake (June 2010); connection-throttling lesson.
- Verified (the-algorithm READMEs): Home Mixer role, Product Mixer, For You / Following / Lists; six pipeline stages; ~6,000 features; filters list; mixing with ads and modules; candidate sources and the "~50% of posts come from this candidate source" statement; Light Ranker, Heavy Ranker and supporting models.
- Verified (Instagram 2012): date, "25 photos and 90 likes every second", Django + PostgreSQL, thousands of logical shards on few physical ones, Postgres schemas as logical shards, 41/13/10 bit layout, 1024 IDs per shard per millisecond, PL/pgSQL generation, Snowflake judged closest but avoided, the 31341 % 2000 = 1341 example (re-derived by hand).
- Removed: Twitter's follower threshold for hybrid fan-out, the claim that Instagram's feed uses a particular fan-out strategy, and the Thundering Herds post's contents. None was available from a source we could read.
- Scoped: the estimation figures are illustrative (`[SPECULATIVE]`), and the reference architecture and fan-out table rows other than Twitter's Fanout Service are `[INDUSTRY PATTERN]`.
- Method note: the Twitter and Instagram posts were read through the Internet Archive (the originals were blocked from this environment). We did not compare them against the originals.
- Quote audit (2026-10-27): the Instagram "logical shards" quote now matches the post verbatim ("that are mapped in code").
