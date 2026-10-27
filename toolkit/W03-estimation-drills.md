# W03 — Estimation drills with worked solutions

*Eight capacity problems drawn from the atlas systems. The arithmetic was computed by script; the assumptions are ours.*

## How to use this page

Try each problem on paper before opening the solution. Assumptions are part of the answer: if you choose different ones, your numbers will differ and that is fine; check that your method is the same. All figures are **illustrative** (our assumptions and arithmetic) except where a published number is named. Use the method in [P01 Estimation](P01-estimation.md).

## 1. URL shortener at 500 million new URLs per month

**Problem.** Assume reads are 100 times writes, a record is 500 bytes, and records are kept 5 years. Estimate average writes and reads per second and total storage before replication.

<details><summary>Worked solution</summary>

- Writes: 500,000,000 / (30 x 86,400) = about 193 per second.
- Reads: 100 x writes = about 19,290 per second on average; assume peak is 3 times, so about 57,870 per second.
- Storage: 500,000,000 x 12 x 5 = 30 billion records x 500 B = 15 TB, about 45 TB with three replicas.
- Implication: reads are cacheable and storage is modest; the design effort goes to key generation and cache hit rate ([01 URL shortener](../systems/01-url-shortener.md)).

</details>

## 2. Chat messages for 50 million daily users

**Problem.** Each user sends 40 messages a day of 100 bytes. Estimate messages per second, daily storage, and how many concurrent connections a service would hold if 20% of users are online at peak.

<details><summary>Worked solution</summary>

- Messages per day: 50,000,000 x 40 = 2 billion; per second: 2,000,000,000 / 86,400 = about 23,148 on average; assume a peak of 3 times, about 69,444 per second.
- Storage: 2,000,000,000 x 100 B = 200 GB per day, about 73 TB per year before replication and indexes.
- Connections: 20% of 50,000,000 = 10 million concurrent connections.
- Implication: write volume is easy; holding 10 million connections and fanning out to them is the hard part ([08 Chat](../systems/08-chat-whatsapp.md), [09 Discord](../systems/09-discord.md)).

</details>

## 3. Photo uploads: 2 million a day at 4 MB

**Problem.** Thumbnails add 10% to storage; keep 3 replicas. Each photo is viewed 20 times a day on average at 0.5 MB per view (served from thumbnails and previews). Estimate daily storage growth, upload bandwidth and view bandwidth.

<details><summary>Worked solution</summary>

- Daily storage: 2,000,000 x 4 MB = 8 TB; plus 10% = 8.8 TB; with 3 replicas about 26.4 TB per day, about 9.6 PB per year.
- Upload bandwidth: 8 TB / 86,400 s = about 93 MB/s, about 741 Mbit/s average.
- Views: assume the stored library is much larger than a day's uploads; take 2,000,000 x 20 = 40 million views a day x 0.5 MB = 20 TB per day, about 1.9 Gbit/s average, several times that at peak.
- Implication: delivery bandwidth and storage cost dominate, so a CDN and storage tiering matter more than request rate ([07 Photo storage](../systems/07-photo-upload-storage.md)).

</details>

## 4. Streaming egress for 5 million concurrent viewers

**Problem.** Average delivered bitrate is 3 Mbit/s. How much bandwidth is that, and how many servers are needed if each serves 40 Gbit/s at 70% utilisation?

<details><summary>Worked solution</summary>

- Total: 5,000,000 x 3 Mbit/s = 15 Tbit/s = 15,000 Gbit/s.
- Per server: 40 x 0.7 = 28 Gbit/s, so 536 servers, before redundancy and uneven geography.
- Implication: no single origin can serve this; the design is a CDN or ISP-embedded caches with steering ([13 Netflix](../systems/13-netflix.md), [12 YouTube](../systems/12-youtube.md)).

</details>

## 5. Metrics: 2 million series every 10 seconds

**Problem.** How many points per second and per day? How much memory for 26 hours of data raw (16 bytes per point) versus compressed at 1.37 bytes per point (Gorilla's reported average)?

<details><summary>Worked solution</summary>

- Points per second: 2,000,000 / 10 = 200,000; per day: 200,000 x 86,400 = 17.3 billion.
- 26 hours: 18.7 billion points; raw at 16 B = 300 GB; compressed at 1.37 B = 26 GB.
- The 1.37-byte figure is Gorilla's average on Facebook's data; yours will differ.
- Implication: compression turns a multi-machine memory problem into one that fits on a few machines ([30 Monitoring](../systems/30-metrics-monitoring-alerting.md)).

</details>

## 6. LLM serving at 100 requests per second

**Problem.** Each request has a 500-token prompt and a 300-token reply. Assume one GPU can generate 2,500 output tokens per second across a batch (an assumption; real values depend on model, hardware and batching). How many GPUs for decoding, and how much KV cache per concurrent request for a model with 80 layers, 8 KV heads of dimension 128 in 16-bit precision?

<details><summary>Worked solution</summary>

- Output tokens needed: 100 x 300 = 30,000 per second, so 12 GPUs for decoding alone at the assumed rate, plus capacity for prompt processing and headroom.
- KV per token: 2 x 80 x 8 x 128 x 2 bytes = 327,680 B; a 800-token request (500 + 300) holds about 262 MB at its end.
- If 12 GPUs each have about 20 GB free for KV cache (an assumption), concurrent requests that fit: 20 GB / 262 MB = about 76 per GPU, so about 900 in total, versus the number actually in flight (Little's law below).
- Concurrency by Little's law: if a request takes about 6 seconds end to end (assumption), in flight = 100 x 6 = 600. So memory fits, but with thin margin.
- Implication: both compute and KV memory must be checked; see [22 LLM inference serving](../systems/22-llm-inference-serving.md).

</details>

## 7. Memory for a rate limiter

**Problem.** 10 million active API keys; each needs a key (16 bytes), a token count (8 bytes) and a last-refill timestamp (8 bytes), plus about 50 bytes of hash-table overhead per entry. How much memory? Is one machine enough?

<details><summary>Worked solution</summary>

- Per entry: 16 + 8 + 8 + 50 = 82 bytes; 10,000,000 x 82 = 820 MB.
- That fits easily in one machine's memory; the limit is request rate and availability, not memory.
- Implication: shard or replicate for throughput and availability, and choose a failure mode ([02 Rate limiter](../systems/02-rate-limiter.md)).

</details>

## 8. Notification burst

**Problem.** 100 million users receive 5 notifications a day on average. A marketing campaign sends 20 million notifications within 10 minutes. How does the campaign rate compare with the average rate?

<details><summary>Worked solution</summary>

- Average: 100,000,000 x 5 / 86,400 = about 5,787 per second.
- Campaign: 20,000,000 / 600 s = about 33,333 per second, roughly 5.8 times the average.
- Implication: size for bursts with queues, priorities and rate-limited fan-out, not for the average ([10 Notification system](../systems/10-notification-system.md)).

</details>

## Habits to build

- Write the assumptions first, then compute.
- Round to one or two significant figures.
- End every estimate with what it implies for the design.
- Ask which assumption, if wrong by 10 times, would change your conclusion.

**Related:** [P01 Estimation](P01-estimation.md), [W01 Mock interview protocol](W01-mock-interview-protocol.md), [22 LLM inference serving](../systems/22-llm-inference-serving.md).

## Sources and provenance

> **Kind:** practice material. The exercises, answer keys and rubrics are **our reasoning** `[INDUSTRY PATTERN]`. Where a fact is sourced it is linked to the atlas note or primer that cites the primary source.
> **Sources:** Exercises and rubrics are our own. Facts they rely on are sourced in the linked atlas notes and primers; each exercise links its evidence.
> **Not read:** Published interview-rubric research and company-specific hiring rubrics.

---
## ✅ Verification log

*Checked 2026-10-27.*
- All arithmetic generated by script from the stated assumptions and re-read.
- The published numbers used are Gorilla's 1.37 bytes per point (note 30) and Llama 3 70B's shape (note 22 and W02); all others are assumptions.
