# P01 — Back-of-the-envelope estimation

*A primer, not a case study. Numbers come from one published source and are dated; the method and examples are our reasoning and are labelled.*

## At a glance

Estimation is how you decide whether a design is plausible before you build it. Jeff Dean calls the ability to estimate the performance of a system design without building it an important skill, and gives a table of latency numbers to do it with `[CONFIRMED]`. The table is from 2009: **the ratios still teach, the absolute values have moved** (SSDs and fast networks are not in it).

**In 60 seconds:** write down the load (requests per second, peak versus average), multiply by item size for bandwidth and storage, divide by what one machine can do, then check the result against the latency numbers. State every assumption out loud, round to one significant figure, and say what would change the answer.

---

## 1. The numbers `[CONFIRMED]` (Jeff Dean, LADIS 2009 keynote)

| Operation | Time |
|---|---|
| L1 cache reference | 0.5 ns |
| Branch mispredict | 5 ns |
| L2 cache reference | 7 ns |
| Mutex lock/unlock | 25 ns |
| Main memory reference | 100 ns |
| Compress 1K bytes with Zippy | 3,000 ns |
| Send 2K bytes over 1 Gbps network | 20,000 ns |
| Read 1 MB sequentially from memory | 250,000 ns |
| Round trip within same datacenter | 500,000 ns |
| Disk seek | 10,000,000 ns |
| Read 1 MB sequentially from disk | 20,000,000 ns |
| Send packet CA->Netherlands->CA | 150,000,000 ns |

**What the table teaches (our reading).** Memory is about 100,000 times faster than a disk seek; a datacenter round trip costs about 5,000 main-memory references; a cross-continent round trip is about 300 datacenter round trips. So: avoid disk seeks, batch network calls, and keep chatty work in one datacenter. **What it lacks:** SSD or NVMe latencies, networks faster than 1 Gbps, and cloud storage services. Look those up for your platform, and say you are doing so.

## 2. A worked example from the same talk `[CONFIRMED]`

The talk's example: how long to generate an image results page of 30 thumbnails? **Design 1**, reading serially and thumbnailing 256 KB images on the fly, is `30 seeks * 10 ms/seek + 30 * 256K / 30 MB/s = 560 ms`. **Design 2**, issuing the reads in parallel, is `10 ms/seek + 256K read / 30 MB/s = 18 ms`, which the speaker says ignores variance, "so really more like 30-60 ms, probably". The lesson is the shape of the argument: take each design, add the dominant latencies, compare, then discuss caching and other variations.

## 3. A method `[INDUSTRY PATTERN]`

1. **Clarify scale:** daily active users, actions per user per day, read/write ratio. Ask; do not guess silently.
2. **Convert to rates:** requests per day ÷ 86,400 gives the average per second. Peaks are a multiple of the average (state your multiple, for example 2 to 10; it depends on the product).
3. **Size the data:** items × bytes per item × retention; then multiply by replication.
4. **Bandwidth:** requests per second × bytes per response, in and out.
5. **Machines:** divide by what one machine can do. State the per-machine figure as an assumption (for example thousands of simple requests per second, far fewer for heavy work).
6. **Check latency:** add the dominant latencies from the table for the critical path and compare with the target.
7. **Sanity check and sensitivity:** which assumption, if wrong by 10×, changes the design?

## 4. Worked examples (our arithmetic, illustrative assumptions)

- **URL shortener, 100 million new URLs per month.** 100,000,000 ÷ (30 × 86,400) ≈ 39 writes per second on average. If reads are 100 times writes, that is about 3,900 reads per second. At 500 bytes per record, 100 million records is about 50 GB per month, or about 3 TB over five years before replication. Verdict: storage is modest, reads are cacheable; the interesting problems are key generation and cache hit rate (see [01 URL shortener](../systems/01-url-shortener.md)).
- **Chat service, 10 million daily users sending 40 messages each.** 400 million messages per day ÷ 86,400 ≈ 4,600 messages per second on average. At 100 bytes each that is about 40 GB per day. Verdict: write volume is easy; the hard part is holding millions of open connections and fan-out (see [08 Chat](../systems/08-chat-whatsapp.md)).
- **Photo sharing, 1 million uploads per day at 3 MB.** About 3 TB per day, 1.1 PB per year before replication or thumbnails. Upload bandwidth averages 3 TB ÷ 86,400 s ≈ 35 MB/s, so about 280 Mbit/s average. Verdict: storage cost and a CDN dominate, not request rate (see [07 Photo storage](../systems/07-photo-upload-storage.md)).

## 5. Common mistakes `[INDUSTRY PATTERN]`

- Using the average as if it were the peak.
- Forgetting replication, indexes, thumbnails or logs when sizing storage.
- Mixing bits and bytes in bandwidth.
- False precision. Round, and show you know the error bars.
- Stopping at the number. Say what it implies for the design.

---

## Questions to practise

1. Estimate the storage needed for a year of a service that stores 200 million 2 KB records per day, with three replicas.
2. Why is a cross-region synchronous write expensive? Use the table.
3. If a request does one disk seek and ten datacenter round trips, which dominates?
4. Which of your assumptions would, if wrong by 10×, change your design?

## Practice

Pick any three systems from the atlas, redo the estimates for them with your own assumptions, and compare with the numbers in their 'At a glance' sections.

**Related:** [01 URL shortener](../systems/01-url-shortener.md), [07 Photo storage](../systems/07-photo-upload-storage.md), [08 Chat](../systems/08-chat-whatsapp.md), [22 LLM inference serving](../systems/22-llm-inference-serving.md) (capacity arithmetic for GPUs).

## Sources and provenance

> **Sources read on 2026-10-27:** Jeff Dean, [*Designs, Lessons and Advice from Building Large Distributed Systems*](https://www.cs.cornell.edu/projects/ladis2009/talks/dean-keynote-ladis2009.pdf) (LADIS 2009 keynote; PDF text extracted locally).
> **Dated material:** The latency table is from 2009. Absolute values for SSDs, networks and cloud services have changed a great deal.
> **Not read:** Newer latency tables, vendor figures for SSD, NVMe and cloud networks, and capacity-planning literature.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the keynote slides: the table values, the thumbnail example arithmetic (560 ms, 18 ms, 30-60 ms) and the quoted remark about variance.
- Not sourced (our reasoning): the interpretation of the table, the method, the worked examples and all their assumptions.
