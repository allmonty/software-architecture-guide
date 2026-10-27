# W05 — Flashcards

*58 cards for the facts that interviewers and colleagues ask about most, taken only from claims already sourced in the atlas notes, primers and casebook.*

## How to use this page

Cover the answer, say it aloud, then check. Mark cards you miss and repeat them after 1 day, 3 days and 1 week (spaced repetition). Each card names the note or primer where its source is cited; if you doubt a card, open that page.

## AI systems

**1. How much KV cache does one token of OPT-13B need, and what does a 2,048-token request need?**

<details><summary>Answer</summary>

About 800 KB per token and up to 1.6 GB per request (2 x 5,120 hidden x 40 layers x 2 bytes). *Source: [22](../systems/22-llm-inference-serving.md).*

</details>

**2. What share of KV-cache memory did earlier serving systems use for actual token states?**

<details><summary>Answer</summary>

Only 20.4% to 38.2%, according to the vLLM paper's profiling. *Source: [22](../systems/22-llm-inference-serving.md).*

</details>

**3. What does PagedAttention borrow from operating systems, and what is its default block size?**

<details><summary>Answer</summary>

Paging: KV cache lives in non-contiguous blocks mapped by a block table; default block size 16 tokens. *Source: [22](../systems/22-llm-inference-serving.md).*

</details>

**4. What did Orca change about batching?**

<details><summary>Answer</summary>

It schedules at iteration level instead of request level, so finished requests leave and new ones join between iterations. *Source: [22](../systems/22-llm-inference-serving.md).*

</details>

**5. What do TTFT and TPOT measure, and what is goodput?**

<details><summary>Answer</summary>

TTFT is time to first token (prefill); TPOT is average time per later token; goodput is the maximum request rate served within the latency targets per GPU. *Source: [22](../systems/22-llm-inference-serving.md).*

</details>

**6. Why can the multi-head KV-size formula overestimate a modern model?**

<details><summary>Answer</summary>

Grouped-query attention shares key/value heads; Llama 3 uses 8 KV heads, so its cache is much smaller (for 70B, 8 times smaller than the multi-head figure). *Source: [22](../systems/22-llm-inference-serving.md).*

</details>

**7. Below what knowledge-base size does Anthropic say you can skip RAG?**

<details><summary>Answer</summary>

About 200,000 tokens (roughly 500 pages): put it in the prompt. *Source: [23](../systems/23-rag-knowledge-assistant.md).*

</details>

**8. By how much did Contextual Retrieval cut top-20 retrieval failures, step by step?**

<details><summary>Answer</summary>

35% with contextual embeddings, 49% adding contextual BM25, 67% adding a reranker (5.7% to 1.9%), on Anthropic's datasets. *Source: [23](../systems/23-rag-knowledge-assistant.md).*

</details>

**9. How does RAG update a model's knowledge?**

<details><summary>Answer</summary>

By replacing the index (non-parametric memory); the RAG paper's 2016 versus 2018 index test showed 70% and 68% correct when matched, 12% and 4% mismatched. *Source: [23](../systems/23-rag-knowledge-assistant.md).*

</details>

**10. What does HNSW's layered structure give you?**

<details><summary>Answer</summary>

Logarithmic search scaling: sparse upper layers (random layer with exponentially decaying probability) for long hops, a dense bottom layer; M in 5 to 48 trades recall and memory. *Source: [24](../systems/24-vector-semantic-search.md).*

</details>

**11. What did DiskANN show about a billion vectors?**

<details><summary>Answer</summary>

One machine with 64 GB of RAM and an SSD served over 5,000 queries a second under 3 ms with 95%+ 1-recall@1 on SIFT1B. *Source: [24](../systems/24-vector-semantic-search.md).*

</details>

**12. Why does filtering hurt approximate vector search in pgvector?**

<details><summary>Answer</summary>

Filtering is applied after the index scan: with a condition matching 10% of rows and ef_search 40, only about 4 rows match on average; iterative scans fix it. *Source: [24](../systems/24-vector-semantic-search.md).*

</details>

**13. Workflow versus agent, per Anthropic?**

<details><summary>Answer</summary>

Workflows orchestrate LLMs and tools through predefined code paths; agents let the LLM dynamically direct its own process and tool use. *Source: [25](../systems/25-ai-agent-platform.md).*

</details>

**14. What did ReAct show and what failure did it expose?**

<details><summary>Answer</summary>

Interleaving reasoning and acting beat RL and imitation baselines by 34% and 10% on ALFWorld and WebShop; a frequent failure is repeating earlier thoughts and actions. *Source: [25](../systems/25-ai-agent-platform.md).*

</details>

**15. What does MCP say about humans and tool calls?**

<details><summary>Answer</summary>

There SHOULD always be a human in the loop with the ability to deny tool invocations; clients must treat tool annotations as untrusted unless from trusted servers. *Source: [25](../systems/25-ai-agent-platform.md).*

</details>

**16. Firecracker's headline numbers?**

<details><summary>Answer</summary>

Under 5 MB memory overhead per micro-VM, boot to application code in under 125 ms, up to 150 micro-VMs created per second per host. *Source: [25](../systems/25-ai-agent-platform.md).*

</details>

**17. Token cost of agents per Anthropic?**

<details><summary>Answer</summary>

About 4 times a chat interaction for agents and about 15 times for multi-agent systems. *Source: [25](../systems/25-ai-agent-platform.md).*

</details>

**18. Funnel in a two-stage recommender?**

<details><summary>Answer</summary>

Millions of items to hundreds of candidates (retrieval) to dozens shown (ranking); YouTube ranked by expected watch time, not clicks. *Source: [26](../systems/26-recommendation-system.md).*

</details>

**19. Why feed 'example age' to a recommender?**

<details><summary>Answer</summary>

Models are biased toward the past; training with age and setting it to zero at serving corrects the bias toward old popular items. *Source: [26](../systems/26-recommendation-system.md).*

</details>

**20. What did Monolith sync, how often, and what did it accept?**

<details><summary>Answer</summary>

Changed sparse parameters about every minute, dense about daily; training servers snapshotted daily, accepting up to a day of lost updates. *Source: [26](../systems/26-recommendation-system.md).*

</details>

**21. Online, nearline and offline computation (Netflix)?**

<details><summary>Answer</summary>

Online answers requests within an SLA (needs a fast fallback); offline is batch with relaxed latency but stale; nearline computes in response to events and stores results. *Source: [26](../systems/26-recommendation-system.md).*

</details>

**22. How many bytes per parameter does mixed-precision Adam need for model states, per ZeRO?**

<details><summary>Answer</summary>

16 bytes (2 + 2 for fp16 parameters and gradients, plus 12 for fp32 optimizer state). *Source: [27](../systems/27-llm-training-infrastructure.md).*

</details>

**23. Llama 3 405B's cluster and reliability headline?**

<details><summary>Answer</summary>

Up to 16K H100 GPUs; 466 interruptions in 54 days (419 unexpected, about 78% hardware); over 90% effective training time. *Source: [27](../systems/27-llm-training-infrastructure.md).*

</details>

**24. Order of Llama 3's parallelism dimensions and why?**

<details><summary>Answer</summary>

[TP, CP, PP, DP], innermost needs the most bandwidth (inside a server); data parallelism is outermost and tolerates latency by prefetching and async reduction. *Source: [27](../systems/27-llm-training-infrastructure.md).*

</details>

**25. What does LoRA change?**

<details><summary>Answer</summary>

Freezes the base weights and trains small low-rank matrices: 10,000 times fewer trainable parameters and 3 times less GPU memory for GPT-3 175B, no added inference latency. *Source: [28](../systems/28-llm-finetuning-evaluation.md).*

</details>

**26. DPO versus PPO in the Llama 3 report?**

<details><summary>Answer</summary>

DPO required less compute for large-scale models and performed better, especially on instruction-following benchmarks; six rounds of SFT plus DPO. *Source: [28](../systems/28-llm-finetuning-evaluation.md).*

</details>

**27. Biases of LLM judges?**

<details><summary>Answer</summary>

Position, verbosity and self-enhancement bias, plus limited reasoning; strong judges still reached over 80% agreement with humans. *Source: [28](../systems/28-llm-finetuning-evaluation.md).*

</details>

**28. What does S-LoRA do?**

<details><summary>Answer</summary>

Keeps adapters in main memory and fetches those needed to the GPU (Unified Paging); up to 4 times vLLM and up to 30 times HuggingFace PEFT throughput. *Source: [28](../systems/28-llm-finetuning-evaluation.md).*

</details>

## Media, observability and streaming

**29. Path of a Twitch live stream?**

<details><summary>Answer</summary>

Streamer RTMP to a PoP media proxy, over the backbone to an origin chosen by the routing service (IRS), transcoded to HLS, distributed down a replication tree to viewers. *Source: [29](../systems/29-live-streaming-twitch.md).*

</details>

**30. What does HLS's typical target duration look like?**

<details><summary>Answer</summary>

RFC 8216 says 10 seconds is typical; the later second-edition draft says 6 seconds. *Source: [29](../systems/29-live-streaming-twitch.md).*

</details>

**31. Components of Twitch chat?**

<details><summary>Answer</summary>

Edge (IRC over TCP and WebSockets), Clue (rules and moderation), Pubsub (fan-out between edges), Room (who is connected). *Source: [29](../systems/29-live-streaming-twitch.md).*

</details>

**32. Gorilla's compression and availability choices?**

<details><summary>Answer</summary>

Delta-of-delta timestamps and XOR values: 16 bytes to 1.37 bytes per point (12 times); drops small amounts of write data to stay available; 26 hours in memory. *Source: [30](../systems/30-metrics-monitoring-alerting.md).*

</details>

**33. Why does Monarch evaluate most alerts in-zone?**

<details><summary>Answer</summary>

Up to 95% of standing queries run entirely at zone level, which tolerates network partitions better and lowers latency. *Source: [30](../systems/30-metrics-monitoring-alerting.md).*

</details>

**34. Photon's three guarantees?**

<details><summary>Answer</summary>

At-most-once at any time, near-exact in real time, and exactly-once eventually; deduplication via a replicated IdRegistry. *Source: [31](../systems/31-ad-click-aggregation.md).*

</details>

**35. How did Mesa handle fraudulent clicks found later?**

<details><summary>Answer</summary>

Negative facts in a later version offset the earlier positive ones; strict version ordering ensures a negative fact cannot be applied before its positive counterpart. *Source: [31](../systems/31-ad-click-aggregation.md).*

</details>

**36. Flink's end-to-end exactly-once needs what?**

<details><summary>Answer</summary>

Replayable sources, checkpoints of state plus source positions, and sinks that take part in checkpointing (transactional) or idempotent writes. *Source: [31](../systems/31-ad-click-aggregation.md).*

</details>

## Primers

**37. Latency numbers worth remembering (Dean, 2009)?**

<details><summary>Answer</summary>

Main memory 100 ns; datacenter round trip 500 microseconds; disk seek 10 ms; cross-continent round trip 150 ms. *Source: [P01](P01-estimation.md).*

</details>

**38. What are write, read and space amplification?**

<details><summary>Answer</summary>

Write: bytes written to storage per byte written to the database; read: disk reads per query; space: file size versus data size. *Source: [P02](P02-storage-engines.md).*

</details>

**39. Leveled versus tiered compaction?**

<details><summary>Answer</summary>

Leveled minimizes space amplification at the cost of read and write amplification; tiered minimizes write amplification at the cost of read and space amplification. *Source: [P02](P02-storage-engines.md).*

</details>

**40. Saga step types?**

<details><summary>Answer</summary>

Compensable (can be undone), pivot (point of no return), retryable (idempotent steps after the pivot). *Source: [P03](P03-distributed-transactions.md).*

</details>

**41. What does the transactional outbox solve?**

<details><summary>Answer</summary>

The gap between saving data and publishing an event: write the event in the same local transaction, publish it afterwards by a worker. *Source: [P03](P03-distributed-transactions.md).*

</details>

**42. Why is power of two choices good for load balancing?**

<details><summary>Answer</summary>

Pick two random hosts and take the one with fewer active requests; nearly as good as a full scan and resists herding. *Source: [P04](P04-load-balancing.md).*

</details>

**43. What do Stripe-style idempotency keys do?**

<details><summary>Answer</summary>

Store the first response for a key (client-generated, up to 255 characters, prunable after 24 hours) and return it on retries; differing parameters are an error. *Source: [P05](P05-api-design.md).*

</details>

**44. Why must pagination exist from the first API version?**

<details><summary>Answer</summary>

Adding it later is breaking: a client that got all 75 items now gets only the first page and does not know to continue. *Source: [P05](P05-api-design.md).*

</details>

**45. The four threat-modeling questions?**

<details><summary>Answer</summary>

What are we working on? What can go wrong? What are we going to do about it? Did we do a good enough job? *Source: [P06](P06-security-threat-modeling.md).*

</details>

**46. Four responses to a threat?**

<details><summary>Answer</summary>

Mitigate, eliminate, transfer, accept. *Source: [P06](P06-security-threat-modeling.md).*

</details>

**47. How many minutes of downtime per 30 days at 99.9% and 99.99%?**

<details><summary>Answer</summary>

About 43 minutes and about 4.3 minutes. *Source: [P07](P07-slos-and-incidents.md).*

</details>

**48. Definition of a cascading failure?**

<details><summary>Answer</summary>

A failure that grows over time as a result of positive feedback, for example overload on one replica raising load on the rest. *Source: [P07](P07-slos-and-incidents.md).*

</details>

**49. Why not 100% availability?**

<details><summary>Answer</summary>

Past a point extra reliability costs more, slows features, and users do not notice; error budgets fund change. *Source: [P07](P07-slos-and-incidents.md).*

</details>

**50. What goes in an ADR?**

<details><summary>Answer</summary>

Title, context, decision, status, consequences (positive, negative and neutral); immutable once accepted, superseded rather than edited. *Source: [P09](P09-decisions-and-design-docs.md).*

</details>

**51. Innovation tokens?**

<details><summary>Answer</summary>

A company can afford only about three new technologies at once; boring technology has well-understood failure modes. *Source: [P09](P09-decisions-and-design-docs.md).*

</details>

**52. Strangler fig in one line?**

<details><summary>Answer</summary>

Route through a façade and replace functionality piece by piece until the old system can be retired. *Source: [P10](P10-changing-systems-safely.md).*

</details>

## Incidents

**53. S3 2017 root cause?**

<details><summary>Answer</summary>

A mistyped input to a playbook command removed far more servers than intended, forcing full restarts of the index and placement subsystems. *Source: [C01](C01-aws-s3-2017.md).*

</details>

**54. Cloudflare 2019 root cause and why it went global?**

<details><summary>Answer</summary>

A WAF regex that backtracked catastrophically; rules were deployed globally in seconds without staged rollout and tests did not check CPU. *Source: [C02](C02-cloudflare-2019.md).*

</details>

**55. GitHub 2018 trigger and choice?**

<details><summary>Answer</summary>

A 43-second partition caused cross-region MySQL failover and writes on both sides; GitHub chose data integrity over availability, 24h11m degraded. *Source: [C03](C03-github-2018.md).*

</details>

**56. Facebook 2021 chain of events?**

<details><summary>Answer</summary>

A backbone command took down all connections; DNS servers then withdrew their BGP routes because they could not reach data centers; internal tools failed too. *Source: [C04](C04-facebook-2021.md).*

</details>

**57. Knight Capital 2012?**

<details><summary>Answer</summary>

A deployment missed one of eight servers, which still ran retired Power Peg code behind a repurposed flag; $460 million lost in 45 minutes. *Source: [C05](C05-knight-capital-2012.md).*

</details>

**58. Kinesis 2020 root cause?**

<details><summary>Answer</summary>

Adding front-end servers exceeded an OS thread limit (threads grow with fleet size), breaking shard-map construction; dependent services cascaded. *Source: [C06](C06-aws-kinesis-2020.md).*

</details>



**Related:** [W01 Mock interview protocol](W01-mock-interview-protocol.md), [README of the toolkit](README.md).

## Sources and provenance

> **Kind:** practice material. The exercises, answer keys and rubrics are **our reasoning** `[INDUSTRY PATTERN]`. Where a fact is sourced it is linked to the atlas note or primer that cites the primary source.
> **Sources:** Exercises and rubrics are our own. Facts they rely on are sourced in the linked atlas notes and primers; each exercise links its evidence.
> **Not read:** Published interview-rubric research and company-specific hiring rubrics.

---
## ✅ Verification log

*Checked 2026-10-27.*
- Each card was written from a claim stated and sourced in the linked note or primer; a spot check compared card answers with those pages.
- Links checked by `npm run validate`.
