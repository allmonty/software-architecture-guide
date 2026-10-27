# 20 — Web Crawler + Search

*A documented real system. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A crawler is a URL frontier, asynchronous fetchers and two dedup tests (URL seen, content seen), constrained by politeness and robots.txt. A search engine turns the stored pages into an inverted index, sorted from per-document hits, and ranks with text match plus link signals like PageRank. The numbers in the sources are from 1998 and 2001.

**Key numbers**
- Mercator waits 10× the download time before revisiting a host `[CONFIRMED]`.
- 1998 Google: ~300 connections per crawler, 100+ pages/s at peak `[CONFIRMED]`.
- RFC 9309: 5xx on robots.txt means assume complete disallow; cache at most 24 hours `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Per-host politeness queues | Never overload a site | Less global ordering of URLs |
| Fingerprint set for URL-seen | Bounded memory | A tiny collision probability |
| Disk-backed frontier | Scales past memory | Slower scheduling |

**Common mistakes**
- Saying 4xx on robots.txt means disallow: it means the crawler MAY access anything.
- Citing `Crawl-delay` from RFC 9309: it is not in it.
- Presenting a Bloom filter as what Mercator used.


---

## 🧒 Non-technical explanation

A web crawler is a **librarian's assistant with a to-do list of addresses**. They visit an address, copy the page, note every address mentioned on it, and add the **new** ones to the list. They must:
- **Not visit the same place twice** (a huge memory problem when the list holds billions of entries),
- **Not annoy the neighbours** (never hammer one website, and always check the "no entry" sign, `robots.txt`),
- **Keep going for weeks** without losing the list.

The search engine is the **index at the back of a book**, but for the whole web: for each word it keeps a list of the pages that contain it, so you never read every page to answer a question.

---

## TL;DR for engineers

- **Crawler = frontier + fetchers + dedup.** A **URL frontier** hands out URLs. Many fetchers download them asynchronously. Extracted links pass a **"URL seen?" test** and a **"content seen?" test** before being queued `[CONFIRMED]` (Mercator).
- **Politeness is a first-class design constraint.** Mercator waits **10× the time a download took** before contacting the same host again, and the standard says to obey `robots.txt` `[CONFIRMED]`.
- **robots.txt rules (RFC 9309):** fetch before content, cache at most **24 hours** (unless unreachable), 4xx means "unavailable" so the crawler **MAY access anything**, 5xx or network errors mean **assume complete disallow**, the most specific match wins, parse at least **500 KiB**. It is "not a form of access authorization" `[CONFIRMED]`.
- **Search index = inverted index:** the indexer turns fetched pages into **hits** per word, distributes them into **barrels**, and a sorter inverts them so each word points to its documents. **PageRank** from the link graph feeds ranking `[CONFIRMED]` (Brin & Page).
- **Index freshness is a trade-off:** Elasticsearch refreshes so new documents are searchable "within 1 second" (near real-time), not instantly `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Functional (crawler):** start from seed URLs · fetch HTML (and other types) · extract links · avoid duplicates · respect `robots.txt` and rate limits · refetch to stay fresh · store pages for indexing.

**Functional (search):** build an index from pages · answer keyword queries with ranked results in milliseconds · support filters and snippets.

**Non-functional:** **scale** (billions of URLs) · **politeness** · **robustness** (the web is hostile: spider traps, huge pages, slow servers) · **freshness** vs cost · **extensibility** (new content types) · bounded memory.

**Estimation approach** `[SPECULATIVE]` (illustrative): crawling 1 billion pages in 30 days is 1e9 / (30 × 86,400) ≈ 386 pages per second. At an average 100 KB per page, that is ≈ 39 MB/s ≈ 3.3 TB/day of raw HTML, before compression. State your own assumptions in an interview.

---

## 2. Crawler architecture

### Mercator's design `[CONFIRMED]` (Najork & Heydon, 2001)

The crawl loop (from the report): "select a URL from the set of URLs to download, determine the IP address of its host name, download the corresponding document, and extract any links contained in it. For each of the extracted links, ensure that it is an absolute URL (derelativizing it if necessary), and add it to the list of URLs to download, provided it has not been encountered before."

**Components** (Figure 1 of the report): **protocol modules** (HTTP, FTP, Gopher), **processing modules** (link extractor, GIF stats, tag counter), a **DNS resolver**, a **URL filter**, the **URL frontier**, a **"content seen?" test** with stored document fingerprints, a **Duplicate URL Eliminator (DUE)**, and a **re-readable input stream (RIS)** abstraction that lets several modules read the same downloaded bytes.

Characteristics the authors list: **distributed** (symmetric across machines), **scalable** (bounded main memory regardless of web size, with most data on disk), **high performance**, **polite**, **continuous** (re-fetching with a priority mechanism), **extensible**.

| Component | How Mercator does it |
|---|---|
| **URL-seen test (DUE)** | One implementation keeps an in-memory hash table of 8-byte checksums of URLs (not the URLs), computed with **Rabin's fingerprinting algorithm**, which "gives exponentially small probabilistic bounds on the likelihood of a collision". The high-order 3 bytes index the table spine |
| **Content-seen test** | After a document is written to the RIS, a test checks whether a document **with the same content but a different URL** has been seen. If so, it is dropped |
| **robots.txt** | The HTTP module keeps a fixed-size cache of robots rules per host: by default **2^18 entries with LRU eviction** |
| **Politeness** | Never download multiple pages from the same server at once. The best frontier uses per-host queues and waits "**10 times as long as it took us to download a URL from a host before contacting that host again**", values that "keep all threads busy and ... the rate of complaints to a bare minimum" |
| **Frontier at scale** | "The URL frontier soon outgrows the available memory of even the largest machines", so most URLs live on disk, and the best implementation is a "polite, dynamic, prioritizing" frontier: priority-level FIFO queues feeding back-end FIFO queues (many more than worker threads) with a priority queue (e.g. a heap) deciding when each host is next eligible |
| **Throughput** | A crawl on **four Compaq DS20E 666 MHz Alpha servers** that "saturated our 160 Mbit/sec Internet connection" downloaded **about 50 million documents per day over 17 days** |

### Google's 1998 crawler `[CONFIRMED]` (Brin & Page)
- "Web crawling (downloading of web pages) is done by several distributed crawlers." A **URLserver** sends lists of URLs to the crawlers, which send fetched pages to a **storeserver** that compresses them into a **repository**. Every page gets a **docID** when its URL is parsed out of a page.
- "A single URLserver serves lists of URLs to a number of crawlers (we typically ran about 3)." Each crawler "keeps roughly **300 connections** open at once", and at peak the system "can crawl over **100 web pages per second** using four crawlers" (≈600 KB/s). Both were written in **Python** in the paper's version.
- **DNS is "a major performance stress"**, so each crawler keeps its **own DNS cache**. The crawler uses **asynchronous I/O** with a number of queues to move fetches between states (look up DNS, connect, send request, receive response).
- Operational reality: crawling "is the most fragile application since it involves interacting with hundreds of thousands of web servers and various name servers which are all beyond the control of the system". Disks filled, name servers crashed, and people complained about the crawler or did not know about `robots.txt`. It took "roughly 9 days to download the 26 million pages (including errors)", and once running smoothly it averaged "just over 4 million pages per day or 48.5 pages per second".

### robots.txt, per RFC 9309 `[CONFIRMED]`
- **Fetch it before crawling content** from a site. It applies per origin.
- **Unavailable** (HTTP 4xx): the crawler "MAY access any resources on the server".
- **Unreachable** (HTTP 5xx or network errors): "the crawler MUST assume complete disallow". (The RFC continues with what to do if this lasts a long time. We did not read that part.)
- **Redirects:** crawlers "SHOULD follow at least five consecutive redirects, even across authorities". If robots.txt is reached within five, it MUST be fetched, parsed and applied to the initial authority. After more than five, crawlers MAY assume it is unavailable.
- **Matching:** "The most specific match found MUST be used", meaning the match with the most octets. Allow beats disallow when they are equivalent. If nothing matches, the URI is allowed.
- **Caching:** crawlers MAY cache, SHOULD NOT use a cached copy for more than **24 hours** unless it is unreachable. **Parsing limit** must be at least **500 KiB**.
- **Security note:** "not a form of access authorization", and listing paths in robots.txt makes them discoverable.

---

## 3. Indexing and search

### Google 1998: from pages to an inverted index `[CONFIRMED]`
1. The **indexer** reads the repository, uncompresses documents and parses them, recording each word with its position, an approximation of font size and capitalisation (a **hit**).
2. It distributes hits into a set of **barrels**, "creating a partially sorted forward index" keyed by docID. It also extracts **links** and anchor text, turns relative URLs into docIDs, and writes the anchor text into the index associated with the docID it points to. It generates a **links database** (pairs of docIDs) used to compute **PageRank**.
3. The **sorter** takes the barrels (sorted by docID) and re-sorts them **by wordID** to generate the **inverted index**, in place so little temporary space is needed. A program, **DumpLexicon**, combines the sorter's list with the lexicon to produce a new lexicon for the searcher.
4. The **searcher** runs as a web server and uses the lexicon, the inverted index and the PageRanks to answer queries.
- **PageRank** is "a probability distribution over web pages" (ranks sum to one), computed by a simple iterative algorithm over the link graph, with a damping factor. The paper says "a PageRank for 26 million web pages can be computed in a few hours on a medium size workstation".
- **Scale in 1998:** 24 million pages in the demonstration index. The indexer ran at roughly 54 pages per second, and sorting on four machines took about 24 hours.

### A modern search tier `[INDUSTRY PATTERN]` plus one documented fact
- **Shard the index** by document (each shard holds an inverted index for its slice of documents) and **fan out** each query to all shards, then merge top-K. Replicate shards for availability and throughput.
- **Segments:** Elasticsearch's docs say "a segment is similar to an inverted index" and that new documents are searchable "in near real-time -- within 1 second", because a **refresh** "makes all operations performed on an index since the last refresh available for search". So search freshness has a built-in lag, a trade-off you can tune `[CONFIRMED]`. (The page we read says Elasticsearch refreshes every second only for indices searched within the last 30 seconds. It did not cover segment immutability or merging, so we do not state those.)
- **Ranking** is more than text match: link-based authority (PageRank-style), anchor text, freshness, and learned signals. Brin and Page already combined text hits with PageRank and anchor text `[CONFIRMED]`.
- **Query path:** parse → look up each term's posting list → intersect/union → score → top-K → fetch snippets. Cache popular queries.

---

## 4. Putting it together `[INDUSTRY PATTERN]` unless tagged

```
seeds ─► URL frontier (priority + per-host queues, on disk) ─► fetchers (async, DNS cache)
              ▲                                                   │ robots.txt cache (≤24 h)
              │  URL-seen? (8-byte fingerprints)                   ▼
        link extractor ◄── content-seen? (doc fingerprints) ◄── downloaded page
                                      │
                                      ▼
                         repository (compressed pages) ─► indexer ─► barrels ─► sorter ─► inverted index shards
                                                                  └► link graph ─► PageRank ───────────────────┘
Query ─► front end ─► fan-out to shards ─► merge + rank ─► results
```

- **Partition the frontier by host** so one worker owns each host's politeness state, and so robots rules and per-host rate limits stay local. Hash of the host selects the worker.
- **Spider traps** (infinite calendars, session IDs in URLs) need caps on depth, URL length and per-host page count, plus URL normalisation `[INDUSTRY PATTERN]`.
- **Recrawl policy:** prioritise by change rate and importance. Re-fetch with conditional requests (`If-Modified-Since`, `ETag`) to save bandwidth `[INDUSTRY PATTERN]`.
- **Dedup near-duplicates** (not just exact copies) with similarity hashing. Mercator's content-seen test finds *identical* content `[CONFIRMED]`, and near-duplicate detection is a separate technique.
- **Crawl as a pipeline of queues** so a slow stage (DNS, a huge page) cannot stall the rest, consistent with Google's note that the crawler uses queues to move page fetches between states `[CONFIRMED]`.

---

## ⚠️ Reviewer notes

1. **The numbers are from 1998 and 2001.** Brin & Page's 24 million pages and Mercator's 50 million documents per day are historical. Do not present them as current. They are useful for the *shape* of the problem and the ratios (DNS, politeness, disk-based frontier).
2. **Bloom filters are not in the sources we read.** Many interview answers use a Bloom filter for "URL seen?". Mercator used a **hash table of 8-byte fingerprints** and a disk-backed set. A Bloom filter is a valid design choice (it saves memory, at the cost of false positives meaning some new pages are skipped) `[INDUSTRY PATTERN]`, but it is not what the cited paper describes.
3. **A 4xx on robots.txt means "go ahead", and a 5xx means "stop".** People often reverse this. RFC 9309 says a crawler MAY access anything when robots.txt is unavailable (4xx), and MUST assume complete disallow when it is unreachable (5xx or network error).
4. **`Crawl-delay` is not in RFC 9309.** Our grep found no mention of it, so do not cite the RFC for it. Politeness delays are crawler policy.
5. **robots.txt is not security.** It asks crawlers to behave, and it is not access control.
6. **We could not verify any current search-engine internals.** Segment immutability, merge policy and the translog were not in the Elastic page we read, so we omit them.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **scalability**, **performance** (fetch throughput, query latency), **fault tolerance** (the web is unreliable), **politeness/ethics** (an unusual non-functional requirement), **extensibility**, **freshness**.
- **Style (Ch 11, 14):** the crawler is a **pipeline architecture** (fetch → parse → filter → store) over queues, and the whole system is **event-driven** with a batch indexing backend and an online serving tier.
- **Quanta (Ch 7):** crawl, index build and query serving are three separate quanta with different characteristics: long-running and fault-tolerant, batch-oriented, and latency-critical respectively. Query serving must stay up while indexing lags.
- **Trade-off (First Law, Ch 1):** **freshness vs cost and politeness.** Refetching more often gives newer results and more load on other people's servers.
- **ADR sketch (Ch 19):** *"We will partition the URL frontier by host and enforce per-host delays in the owning worker. We accept less global ordering of URLs in exchange for simple, local politeness."*
- Plain English: give each assistant a few neighbourhoods and let them keep the notes about who to be careful with.

---

## Interview questions to practice

1. Design a crawler for 1 billion pages in a month. Where are the bottlenecks (DNS, disk, politeness)?
2. How do you avoid fetching the same URL twice at this scale, and what does it cost? Compare a hash set of fingerprints and a Bloom filter.
3. A site returns `503` for `/robots.txt`. What do you do? What about `404`?
4. How do you stay polite while keeping thousands of threads busy?
5. How would you detect duplicate pages with different URLs? Near-duplicates?
6. Sketch the inverted index and the query path. How do you shard it, and what happens to a query that spans all shards?
7. How fresh should the index be, and what does refreshing more often cost?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: scale, freshness, content types, politeness.
2. Estimate: pages/s and storage.
3. API: seeds in, ranked results out.
4. Design: frontier, fetchers, dedup, repository, indexer, shards.
5. Deep dive: politeness, robots, inverted index, PageRank.
6. Failure and scale: spider traps, DNS cost, shard fan-out.

**If it grows 10×**
- Frontier size: partition by host and keep it on disk.
- Index size: shard by document and replicate.
- Freshness: prioritise recrawls by change rate.

**Answer outlines** (try the questions above first)

<details><summary>1 billion pages in a month: bottlenecks?</summary>

About 386 pages/s: DNS lookups, politeness limits and disk-backed URL state dominate, not CPU.

</details>

<details><summary>How do you avoid fetching the same URL twice?</summary>

Check a fingerprint set before enqueueing. A Bloom filter saves memory but admits false positives that skip new pages.

</details>

<details><summary>A site returns 503 for robots.txt. What do you do?</summary>

Treat it as unreachable and assume complete disallow, per RFC 9309. A 404 means unavailable, which allows crawling.

</details>

## 📚 Further reading

- The four sources listed at the top. The original 1998 web version is at infolab.stanford.edu/~backrub/google.html (unreachable from our network, so we read an Internet Archive copy).
- [System Design Primer: Design a web crawler](https://github.com/donnemartin/system-design-primer) (secondary; interview framing).
- Related in this repo: [11 News feed](11-news-feed.md) (caches and fan-out), [03 Distributed KV store](03-distributed-kv-store.md) (partitioning), [02 Rate limiter](02-rate-limiter.md) (per-host politeness is a rate limit), [01 URL shortener](01-url-shortener.md) (Bloom filters).

## Sources and provenance

> **Kind:** real-system for the *design ideas*, with 1990s and early-2000s evidence. The two foundational public descriptions are Google's original paper (Brin & Page, 1998) and the Mercator crawler report (Najork & Heydon, 2001). Neither describes today's Google or Bing. The robots.txt behaviour is from the current IETF standard (RFC 9309). Search-index specifics for a modern engine come from Elasticsearch's docs (only a small part was readable). So this note explains *how a crawler and a search index fit together*, with dated numbers, and it does not claim how any current search engine works.
> **Sources read on 2026-10-27:** Brin & Page, [*The Anatomy of a Large-Scale Hypertextual Web Search Engine*](https://snap.stanford.edu/class/cs224w-readings/Brin98Anatomy.pdf) (WWW7, 1998; read from an Internet Archive copy of the web version, plus the paper PDF extracted locally) · Najork & Heydon, [*High-Performance Web Crawling*](https://www.cs.cornell.edu/courses/cs685/2002fa/mercator.pdf) (Compaq SRC Research Report 173, 2001-09-26; PDF extracted locally) · IETF [RFC 9309: Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309) (text) · Elastic docs: [Near real-time search](https://www.elastic.co/docs/manage-data/data-store/near-real-time-search).
> **Not read:** current Google/Bing documentation, Lucene's file-format docs, Common Crawl, Scrapy, or any crawl-budget guidance. We make no claims about those.
> **Tags:** `[CONFIRMED]` stated by a primary source read now · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible, or an illustrative estimate.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Both papers were extracted or read from local copies and grepped. RFC 9309 was downloaded and read as text.
- Verified in Brin & Page: URLserver, storeserver, repository and docID; ~3 crawlers (four at peak), ~300 connections each, 100+ pages per second at peak (≈600 KB/s); DNS as a major stress with per-crawler caches; asynchronous I/O and queues; Python implementation; the fragility paragraph; 9 days for 26 million pages and then 4 million+ pages per day (48.5 per second); indexer at ~54 pages per second; sorting ~24 hours on four machines; hits, barrels, forward index, links database, sorter, DumpLexicon, searcher; PageRank definition and "26 million pages in a few hours".
- Verified in the Mercator report: the crawl loop, component list and Figure 1, the six characteristics, the 8-byte Rabin-fingerprint URL set, content-seen test, robots cache of 2^18 entries with LRU, the 10× politeness delay, disk-based frontier and the four-Alpha-server crawl at about 50 million documents per day over 17 days.
- Verified in RFC 9309: robots.txt before crawling, "unavailable" (4xx) allows access, "unreachable" (5xx or network) means complete disallow, redirect rule (SHOULD follow at least five, MAY treat it as unavailable after more), most-specific-match and allow-wins-ties, 24-hour cache guidance, 500 KiB minimum parse limit, "not a form of access authorization". We found no mention of `Crawl-delay`.
- Verified in Elastic's docs: near real-time "within 1 second", refresh semantics, the 30-second search-activity condition, "a segment is similar to an inverted index".
- Not covered by the sources we read, so not stated: segment immutability and merging, the translog, BM25 as a default, any claim about how current search engines rank or crawl.
- Labelled industry pattern: partitioning by host, spider-trap caps, recrawl policy, near-duplicate detection, Bloom-filter alternative, the modern sharded query path, and the estimation arithmetic (checked by hand: 1e9/2.592e6 ≈ 386/s; 386 × 100 KB ≈ 38.6 MB/s ≈ 3.3 TB/day).
- Method note: the Brin & Page web version and PDF were both read. Mercator is the 2001 SRC report, not the 1999 Mercator paper, and dates and figures are from that report.
- Quote audit (2026-10-27): the PageRank sentence is now quoted in full ("a PageRank for 26 million web pages can be computed in a few hours on a medium size workstation") instead of an elided version.
