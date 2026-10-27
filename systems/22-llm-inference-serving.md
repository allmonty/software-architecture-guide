# 22 — LLM Inference Serving (ChatGPT-style)

*A reference design built on verified building blocks. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Serving a large language model is limited by GPU memory and by how requests are batched. Each request needs a KV cache that grows token by token, so the number of requests a GPU can hold decides throughput. vLLM manages that cache in fixed-size blocks like virtual-memory pages, Orca schedules work one decoding iteration at a time so requests join and leave a batch freely, and DistServe separates the compute-bound prefill phase from the memory-bound decoding phase. A production platform wraps these engines with a gateway, a router, autoscaling and metering.

**Key numbers**
- For the 13B-parameter OPT model, one token's KV cache is about 800 KB, so one 2,048-token request can need up to 1.6 GB `[CONFIRMED]` (vLLM paper).
- Existing systems used only 20.4%–38.2% of KV-cache memory for actual token states `[CONFIRMED]`; vLLM aims for near-zero waste and reports 2–4× higher throughput at the same latency `[CONFIRMED]`.
- Orca reported 36.9× higher throughput than NVIDIA FasterTransformer at the same latency on a GPT-3 175B model `[CONFIRMED]`; DistServe reported serving 7.4× more requests or meeting 12.6× tighter latency targets `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Paged KV cache (block size 16 by default) | Near-zero fragmentation, so bigger batches | A block table lookup per attention step and a custom attention kernel |
| Iteration-level scheduling | Finished requests leave and new ones join every step | More scheduler work per step than request-level batching |
| Disaggregate prefill and decoding | Each phase gets its own resources and parallelism | KV-cache transfer between GPUs and two pools to run |

**Common mistakes**
- Treating latency as one number: time to first token (prefill) and time per output token (decoding) are different problems.
- Sizing GPUs from model weights alone and forgetting the KV cache, which grows with batch size and sequence length.
- Claiming how a named commercial service serves its models: only the research systems above are published.

---

## 🧒 Non-technical explanation

Picture a **restaurant kitchen with one very expensive stove**. Every order needs the stove's full attention for a short moment, again and again, until the dish is finished. The stove is only efficient when it cooks many orders in each pass. But every order in progress also needs its **own tray of half-prepared ingredients** that keeps growing, and the counter space for trays is limited.

The old way was to reserve the maximum tray size for every order and to start a new batch only when the whole current batch was done. The new ways are to hand out tray space **in small tiles as it is needed**, to let orders **join or leave between passes**, and to run the **first-prep line** (reading the order) separately from the **stove line** (cooking one dish step at a time).

---

## TL;DR for engineers

- **Two phases:** the prompt is processed in parallel (prefill), then tokens are generated one at a time (decoding). Decoding "severely underutilizes GPU computation and becomes memory-bound" `[CONFIRMED]` (vLLM paper).
- **Memory decides batch size.** With a 13B model on a 40 GB A100, the weights take 26 GB (65%), leaving about 12 GB for the KV cache `[CONFIRMED]`.
- **PagedAttention** stores the KV cache in non-contiguous blocks with a block table per request, like OS paging `[CONFIRMED]`.
- **Iteration-level scheduling** (Orca) and **continuous batching** let requests join and leave every step `[CONFIRMED]`.
- **Prefill/decode disaggregation** (DistServe) optimises per-GPU **goodput** under time-to-first-token and time-per-output-token targets `[CONFIRMED]`.
- **A platform around the engine** (gateway, token-based limits, router, autoscaling, metering) is the standard design `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** a chat or completion API with streaming output · several models and sizes · system prompts, tools and long contexts · per-customer limits and billing by tokens · safe handling of abuse.

**Non-functional:** **time to first token (TTFT)** and **time per output token (TPOT)** targets · **throughput per GPU** (cost) · availability under bursty traffic · fairness between customers · predictable behaviour when overloaded.

**Clarifying questions:** interactive chat or batch? Typical prompt and output lengths? Shared long prefixes (system prompts, documents)? One model or many? Latency targets and the share of requests that must meet them? Budget and GPU type?

---

## 2. Why serving is hard: two phases and a growing cache

A request provides prompt tokens and the model generates output tokens one at a time `[CONFIRMED]`. The vLLM paper separates the **prompt phase**, where the whole prompt is processed in parallel, from the **autoregressive generation phase**, where tokens are produced sequentially and the work is "memory-bound".

**The KV cache** stores the key and value vectors of earlier tokens so they need not be recomputed. For the 13B OPT model the paper computes 800 KB per token (2 for key and value × 5,120 hidden size × 40 layers × 2 bytes in FP16), so a 2,048-token request can need up to **1.6 GB** `[CONFIRMED]`. We can check the arithmetic: 2 × 5,120 × 40 × 2 = 819,200 bytes ≈ 800 KB, and 2,048 × 800 KB ≈ 1.6 GB.

**Caveat for modern models.** That formula assumes every attention head has its own key and value (multi-head attention, as in OPT). Many newer models use **grouped-query attention (GQA)**, where several query heads share a key/value head, so the per-token KV size is 2 × layers × KV heads × head dimension × bytes. Llama 3, for instance, uses GQA with 8 key-value heads `[CONFIRMED]` (Llama 3 report, Section 3.2), which makes its cache much smaller than the multi-head formula would give. When an interviewer asks you to size a KV cache, ask which attention variant the model uses.

**What the GPU holds** (paper's 13B example on a 40 GB A100): parameters 26 GB (65%), KV cache about 12 GB, a small remainder for activations. In Table 1 the 13B server has 15.7K KV-cache "slots", and the 175B server (8 × A100-80GB) has 264 GB for KV cache and 60.1K slots `[CONFIRMED]`. The KV cache is dynamic: it grows with every generated token and is freed when a request ends, so it is the part that limits how many requests you can run together.

---

## 3. Managing the KV cache: PagedAttention and vLLM `[CONFIRMED]`

**The problem with contiguous allocation.** Earlier systems stored each request's KV cache in one contiguous region sized for the maximum length (for example 2,048 tokens). That wastes space inside the region (internal fragmentation, since actual lengths are shorter) and between regions (external fragmentation). The paper's profiling found that "only 20.4% - 38.2% of the KV cache memory is used to store the actual token states" in the existing systems. They also could not share memory between the sequences of one request.

**The fix.** vLLM splits each request's KV cache into **blocks** and keeps a **block table** mapping logical blocks to physical blocks, so the cache can grow dynamically without reserving all positions in advance. The paper reports that "the block size 16 is large enough to efficiently utilize the GPU" and small enough to limit internal fragmentation, and vLLM's default block size is 16.

**Sharing.** Requests that produce several outputs (parallel sampling, beam search) share the prompt's blocks, and vLLM uses **copy-on-write** at block granularity when a shared block must be modified, like forking a process. A shared **prefix** (a long system prompt, for example) can have its KV cache stored once and reused by many requests.

**When memory runs out.** vLLM schedules **first-come-first-serve** "ensuring fairness and preventing starvation", and when it must preempt it serves the earliest requests first and preempts the latest. Preempted state is either **swapped** to CPU memory or **recomputed** when the request is rescheduled, and eviction is **all-or-nothing** per sequence: "either evict all or none of the blocks of a sequence". Sequences in one request are gang-scheduled as a group.

**Distributed models.** For models larger than one GPU, vLLM supports Megatron-LM style tensor model parallelism in an SPMD pattern, with GPUs synchronising via all-reduce.

**Result.** "vLLM improves the throughput of popular LLMs by 2-4× with the same level of latency compared to the state-of-the-art systems, such as FasterTransformer and Orca", with larger gains for longer sequences, bigger models and more complex decoding.

---

## 4. Scheduling: iteration-level batching `[CONFIRMED]` (Orca, OSDI 2022)

**The limitation of request-level batching.** The paper describes a mechanism where requests that finish early "cannot return to the client", and "newly arrived requests have to wait until the current batch completely finishes".

**Iteration-level scheduling.** The scheduler "schedules execution at the granularity of iteration (instead of request)": it invokes the execution engine to run a **single iteration** of the model on the batch, then reconsiders the batch. Finished requests leave immediately and new ones join.

**Selective batching.** Because requests in the same iteration can be at different positions, Orca applies batching "only to a selected set of operations" so the technique works for Transformers.

**Result.** On a GPT-3 175B model, Orca reported a "36.9× throughput improvement at the same level of latency" versus FasterTransformer. Today this is usually called **continuous batching** and appears in vLLM too.

---

## 5. Separating prefill from decoding `[CONFIRMED]` (DistServe, OSDI 2024)

DistServe observes that existing systems **colocate** prefill and decoding and batch them together across requests, which "leads to strong prefill-decoding interferences" and couples their resource allocation and parallelism.

**Two latency numbers.** **TTFT**, "the duration of the prefill phase", and **TPOT**, "the average time taken to generate a token for each request (except for the first token)". Different applications weight them differently: a real-time chatbot prioritises a low TTFT, while, in the paper's example, document summarisation tolerates a slow start (its table allows 15 s TTFT for OPT-66B on LongBench) and cares more about TPOT. For very long documents the prefill itself is a large cost, so check which phase dominates for your workload.

**Goodput, not throughput.** The paper defines per-GPU **goodput** as "the maximum request rate that can be served adhering to the SLO attainment goal (say, 90%) for each GPU provisioned". A higher goodput directly lowers cost per query.

**The design.** DistServe assigns prefill and decoding to **different GPUs**, eliminating the interference and letting each phase use its own parallelism strategy. It reports serving "7.4 × more requests or 12.6× tighter SLO" than state-of-the-art systems while keeping more than 90% of requests within latency constraints. 

**The price: moving the KV cache.** Disaggregation means sending each request's KV cache from a prefill GPU to a decode GPU. The paper's example: the KV cache of a single 512-token request on OPT-66B is approximately 1.13 GB, so at an average of 10 requests per second the system must transfer 11.3 GB per second, "equivalently 90Gbps bandwidth" to make the overhead invisible. It relies on fast links: InfiniBand between nodes where available, otherwise NVLink inside a node (peak 600 GB/s between A100 GPUs). On its testbed, which had only 25 Gbps across nodes, DistServe therefore places the prefill and decode instances of a model stage on the same machine so the transfer uses NVLink; with that placement, KV transmission for OPT-175B accounted for less than 0.1% of total latency and over 95% of requests saw a transfer delay under 30 ms. The design is therefore tied to cluster topology.

---

## 5b. Other techniques the same papers point to `[CONFIRMED]`

- **Chunked prefill and stall-free batching (Sarathi-Serve, Agrawal et al., 2024).** Mixing long prefills with ongoing decodes causes "generation stalls" (a decode stalling for seconds in vLLM's scheduler). Sarathi-Serve splits a prefill into near equal chunks and builds stall-free schedules that add new requests to a batch without pausing ongoing decodes. It reports 2.6 times higher serving capacity than vLLM for Mistral-7B on one A100, up to 3.7 times for Yi-34B on two A100s, and up to 5.6 times for Falcon-180B with pipeline parallelism, under tail-latency constraints. It is the main alternative to DistServe for the prefill/decode interference problem: schedule smarter on shared GPUs instead of separating them.
- **Speculative decoding (Leviathan et al., 2022).** A small, fast model proposes several tokens and the large model checks them in parallel; with the paper's sampling method the output distribution is unchanged ("identical outputs"). It reports a 2X-3X speedup on T5-XXL over the standard T5X implementation, without retraining.
- **FlashAttention (Dao et al., 2022).** An IO-aware exact attention algorithm that uses tiling to cut reads and writes between GPU high-bandwidth memory and on-chip SRAM. The paper's reported speedups are for training (for example 3 times on GPT-2 at sequence length 1K); we do not claim inference numbers from it.

Quantization and vendor APIs remain unread.

---

## 6. The platform around the engine `[INDUSTRY PATTERN]`

No commercial service publishes its full serving stack, so this is the standard design:

```
client ─► API gateway ─► request router ─► inference replica (GPU server, vLLM-style engine)
         auth, quotas        load, prefix      scheduler · KV block manager · model executor
         token limits        affinity                │
              │                                      ▼
        usage metering ◄──────── token stream (SSE) ◄┘
autoscaler ◄── queue depth, GPU memory, TTFT/TPOT ── metrics
model weights store ──► replicas (slow cold start)
```

- **Gateway:** authentication, per-customer **token-based** rate limits and quotas, request validation, streaming via server-sent events. See [02 Rate limiter](02-rate-limiter.md) for limit algorithms and failure behaviour.
- **Router:** sends each request to a replica by current load and, when a long shared prefix exists, to a replica that already holds that prefix's KV cache (prefix-aware routing). The engine papers support prefix sharing inside an engine. Cross-replica prefix routing is our design extension.
- **Replicas:** one engine process per GPU group, sized so weights plus a useful KV-cache budget fit.
- **Autoscaling:** scale on queue depth and latency targets, not CPU. GPUs are scarce and loading weights is slow, so keep a warm floor and scale ahead of known peaks.
- **Overload behaviour:** queue briefly, then reject with a clear retry hint rather than let latency grow without bound. The vLLM paper notes the queue length "continues to grow infinitely" once the request rate exceeds capacity.
- **Metering and observability:** count input and output tokens per customer, track TTFT, TPOT, queue time, GPU memory and error rates, and record preemptions.
- **Multi-tenancy and safety:** isolate customers' prompts and caches, apply content policies, and cap output length to bound cost.

---

## 7. Capacity and cost reasoning (illustrative)

- **Weights:** parameters × bytes per parameter. In FP16 each parameter takes 2 bytes, so a 13B model is about 26 GB, matching the paper's table.
- **KV budget:** GPU memory minus weights minus activations. The paper's 13B example leaves about 12 GB, which at 800 KB per token holds about 15,000 tokens of context across all concurrent requests (12 GB ÷ 800 KB ≈ 15,000), consistent with its 15.7K slots.
- **Implication:** with 2,048-token requests only about 7 can be resident at once, and shorter real requests allow more. Paging lets the actual lengths, not the maximum, decide.
- **Cost metrics:** cost per million tokens ≈ GPU hourly price ÷ (tokens per second × 3,600) × 1,000,000. The inputs (price, tokens per second) are workload-specific, so state assumptions rather than quote numbers.

---

## ⚠️ Reviewer notes

1. **The papers' speedups are relative to specific baselines and workloads.** The 2–4×, 36.9× and 7.4× figures compare against particular systems (FasterTransformer, Orca, vLLM) on particular models and datasets. They are not general speedups.
2. **"Continuous batching" is a name, not a paper term.** Orca's term is iteration-level scheduling. Use the name your interviewer uses and be ready to explain the mechanism.
3. **Disaggregation is not free.** It needs a fast interconnect and topology-aware placement (section 5). Sarathi-Serve shows chunked prefill on shared GPUs as a competing way to reduce the same interference; we did not find a paper that compares them head to head, and we do not claim which wins.
4. **This note covers inference serving.** Training is in [27 LLM training infrastructure](27-llm-training-infrastructure.md) and improving a model is in [28 LLM fine-tuning, evaluation and deployment](28-llm-finetuning-evaluation.md).
5. **We did not read** vendor documentation for specific commercial APIs or quantization papers, so quantization is not claimed. Speculative decoding, FlashAttention and chunked prefill are covered from their papers in section 5b.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the papers. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (TTFT, TPOT), **elasticity** (bursty demand on scarce GPUs), **cost efficiency**, **availability**, **fairness** between tenants.
- **Style (Ch 13):** **service-based**: a stateless gateway and router in front of stateful GPU replicas. Inside a replica the scheduler, memory manager and executor are tightly coupled by design.
- **Quanta (Ch 7):** each replica is a quantum with its own memory state. Disaggregated serving splits it into prefill and decode quanta that must agree on a cache handoff.
- **Trade-off (First Law, Ch 1):** **latency vs throughput per GPU.** Larger batches raise throughput and also raise per-request latency, and goodput under a latency target is the metric that balances them.
- **ADR sketch (Ch 19):** *"We will run a vLLM-style engine with paged KV cache and continuous batching behind a token-aware gateway. We accept preemption under memory pressure in exchange for higher GPU utilisation."*
- Plain English: lay the trays out in tiles, change the batch every pass, and keep the prep line apart from the stove.

---

## Interview questions to practice

1. Why is serving an LLM harder than serving a typical stateless API?
2. What is the KV cache, and why does it limit throughput? Compute its size for a model of your choice.
3. How does continuous batching differ from request-level batching, and why does it raise utilisation?
4. What would you do when GPU memory is exhausted mid-generation?
5. What are TTFT and TPOT, and how would you set targets for a chat product versus a summarisation job?
6. How would you autoscale a GPU fleet, and what makes it hard?
7. How would you rate-limit and bill LLM requests?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: chat or batch, models, context lengths, latency targets, budget.
2. Estimate: requests/s, tokens per request, weights and KV-cache memory per GPU.
3. API: streaming chat endpoint with token limits and a request ID.
4. Design: gateway, router, GPU replicas with a paged-KV engine, autoscaler, metering.
5. Deep dive: KV cache paging, iteration-level scheduling, prefill versus decode.
6. Failure and scale: memory pressure and preemption, replica crash mid-stream, overload, cold starts.

**If it grows 10×**
- GPU cost dominates: improve utilisation with batching and prefix sharing before adding hardware.
- Latency targets conflict: separate prefill and decode pools and tune each.
- Long contexts blow up KV memory: cap or tier contexts and use prefix reuse.

**Answer outlines** (try the questions above first)

<details><summary>What is the KV cache, and why does it limit throughput?</summary>

It holds the key and value vectors of earlier tokens so they are not recomputed. It grows with every generated token and with batch size, and it competes with the model weights for GPU memory. Concurrent requests are bounded by how many caches fit, so it caps throughput.

</details>

<details><summary>What do you do when GPU memory runs out mid-generation?</summary>

Preempt: pick the newest requests, then either swap their cache to CPU memory or drop it and recompute later. Evict a whole sequence at a time, keep first-come-first-served order, and reject new work if pressure persists.

</details>

<details><summary>How do you set latency targets for chat versus summarisation?</summary>

Chat needs a low time to first token so the reply starts quickly and a steady token rate afterwards. Summarisation tolerates a slow start but wants a low time per output token for fast completion. Measure goodput: the request rate served within both targets per GPU.

</details>

## 📚 Further reading

- The three papers listed under Sources and provenance.
- [`neokim-post/01` How LLMs work](../../neokim-post/01-how-llms-work.md) for tokens, embeddings and the product-level serving design.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [02 Rate limiter](02-rate-limiter.md), [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [25 AI agent platform](25-ai-agent-platform.md), [28 LLM fine-tuning, evaluation and deployment](28-llm-finetuning-evaluation.md).

## Sources and provenance

> **Kind:** reference design with real parts. vLLM, Orca and DistServe are published research systems. How any commercial LLM service is built end to end is **not** published, so the platform in section 6 is the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-26 and 2026-10-27 (PDF text extracted locally; Sarathi-Serve, speculative decoding, FlashAttention and the Llama 3 GQA statement were added on the second date):** Kwon et al., [*Efficient Memory Management for Large Language Model Serving with PagedAttention*](https://arxiv.org/pdf/2309.06180) (SOSP 2023) · Yu et al., [*Orca: A Distributed Serving System for Transformer-Based Generative Models*](https://www.usenix.org/system/files/osdi22-yu.pdf) (OSDI 2022) · Zhong et al., [*DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving*](https://arxiv.org/pdf/2401.09670) (OSDI 2024, arXiv v3 June 2024) · Agrawal et al., [*Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve*](https://arxiv.org/pdf/2403.02310) (2024) · Leviathan et al., [*Fast Inference from Transformers via Speculative Decoding*](https://arxiv.org/pdf/2211.17192) (2022) · Dao et al., [*FlashAttention*](https://arxiv.org/pdf/2205.14135) (2022) · Llama Team, Meta, [*The Llama 3 Herd of Models*](https://arxiv.org/pdf/2407.21783) (2024; Section 3.2, for the GQA statement).
> **Dated material:** the papers are from 2022–2024 and the field moves quickly. The measurements are from the authors' hardware and models (A100 GPUs, OPT, GPT-3 and LLaMA models).
> **Not read:** quantization papers, vendor API documentation. Claims about those are not made.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-26, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the vLLM paper: 800 KB per token for OPT-13B and 1.6 GB per 2,048-token request (formula arithmetic re-derived: 2 × 5,120 × 40 × 2 = 819,200 bytes); 20.4%–38.2% usage; parameters 26 GB (65%) and KV cache about 12 GB on a 40 GB A100; Table 1 slot counts (15.7K, 9.7K, 60.1K) and KV memory (12, 21, 264 GB); block size 16 default; block table; copy-on-write; shared prefix; FCFS; all-or-nothing eviction with swap or recomputation; Megatron-style tensor parallelism; 2–4× throughput.
- Verified in Orca: iteration-level scheduling, selective batching, the request-level batching limitation, 36.9× on GPT-3 175B versus FasterTransformer.
- Verified in DistServe: disaggregation, TTFT and TPOT definitions, goodput definition with 90% SLO attainment, 7.4× and 12.6× figures, and the KV-transfer analysis (1.13 GB per 512-token OPT-66B request, 11.3 GB/s at 10 requests per second, about 90 Gbps, NVLink 600 GB/s, under 0.1% of OPT-175B latency, over 95% of transfers under 30 ms, 25 Gbps cross-node testbed).
- Verified in Sarathi-Serve, the speculative decoding paper and FlashAttention: the abstract-level claims quoted in section 5b (2.6, 3.7 and 5.6 times; 2X-3X with identical outputs; the training speedups). The papers' experimental setups beyond those figures were not reviewed.
- Labelled industry pattern, not sourced: the gateway, router with prefix-aware routing, autoscaling, metering, overload and multi-tenancy design, and the cost formula.
- Not claimed: how any named commercial LLM service is built.
