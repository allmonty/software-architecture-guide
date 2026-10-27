# 27 — LLM Training Infrastructure

*Real-system parts from Meta's Llama 3 report, ByteDance's MegaScale and Microsoft's ZeRO papers. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** Training a frontier language model means keeping thousands of GPUs busy on one synchronous job for weeks. Three problems dominate. **Memory:** a model's weights, gradients and optimizer state do not fit on one GPU, so the model is split across GPUs with several kinds of parallelism. **Communication:** the GPUs constantly exchange data, so network topology and collective libraries decide efficiency. **Failure:** with this many parts something breaks every few hours, and because training is synchronous one broken GPU stops everyone, so the system must detect faults, replace nodes and resume from a recent checkpoint automatically. Success is measured by utilisation (MFU) and by the share of time spent on useful training.

**Key numbers** (as published, with the year)
- Llama 3 405B trained on up to 16K H100 GPUs (80 GB each, eight per server), scheduled by Meta's MAST scheduler, with checkpoints on a 240 PB Tectonic file system sustaining 2 TB/s `[CONFIRMED]` (2024).
- Reported model FLOPs utilisation (MFU) of 38–43% for Llama 3's configurations `[CONFIRMED]`; MegaScale reached 55.2% MFU on a 175B model with 12,288 GPUs, 1.34 times Megatron-LM `[CONFIRMED]`.
- Over a 54-day snapshot Llama 3 saw 466 job interruptions, 419 of them unexpected; about 78% of the unexpected ones were attributed to hardware, GPUs being 58.7% of the total `[CONFIRMED]`. Effective training time stayed above 90% `[CONFIRMED]`.
- ZeRO: mixed-precision training with Adam needs 16 bytes per parameter for weights, gradients and optimizer state; partitioning all three over 64 GPUs gives a 64 times reduction in per-GPU model-state memory `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Combine tensor, pipeline, context and data parallelism | Fit and speed up a model no single GPU can hold | A complex configuration tied to the network topology |
| Shard optimizer state and gradients (ZeRO/FSDP) | Per-GPU memory shrinks with the number of GPUs | More communication (up to 50% more for full sharding in ZeRO) |
| Checkpoint often and fast | Less work lost after a failure | Bursty writes that saturate storage; GPU pause time |
| Automate fault handling | A failure every few hours cannot wait for a human | Needs deep diagnostics and spare capacity |
| Topology-aware placement | Cross-pod traffic is the scarce resource | Scheduler and parallelism plan must know the network |

**Common mistakes**
- Counting only compute and forgetting that a synchronous job fails whenever any one GPU does.
- Treating utilisation as one number. MFU, effective training time and goodput measure different losses.
- Ignoring stragglers: one slow GPU can slow thousands of others.
- Checkpointing rarely because it is expensive, then losing hours at each failure.

---

## 🧒 Non-technical explanation

Picture **sixteen thousand people building one enormous Lego model in a stadium, in lockstep**. Nobody can hold the whole model, so each person holds a slice and they constantly pass pieces to neighbours. Everyone must finish each step before the next begins, so if one person stops to tie a shoe, thousands wait. The organisers therefore photograph the model every few minutes (checkpoints), have inspectors listening for anyone who stalls, swap that person for a fresh one, and restart from the last photograph, all without a meeting.

---

## TL;DR for engineers

- **Memory:** model states cost about 16 bytes per parameter with mixed-precision Adam `[CONFIRMED]` (ZeRO); partition them across data-parallel workers `[CONFIRMED]`.
- **Parallelism:** Llama 3 used 4D parallelism: tensor, pipeline, context and (fully sharded) data parallelism, ordered by network demand `[CONFIRMED]`.
- **Network:** a 24K-GPU RoCE cluster on a three-layer Clos network, with topology-aware scheduling `[CONFIRMED]`.
- **Reliability:** frequent interruptions, automated diagnosis, replacing nodes, fast checkpointing and recovery `[CONFIRMED]` (Llama 3, MegaScale).
- **Scheduling, data loading, evaluation during training, cost:** surrounding concerns `[INDUSTRY PATTERN]` unless sourced.

---

## 1. Requirements (design framing)

**Functional:** run one very large training job across thousands of GPUs · schedule many jobs on shared clusters · checkpoint and resume · feed data continuously · expose progress and debugging tools.

**Non-functional:** **throughput and utilisation** (MFU, tokens per second) · **reliability** (useful time as a share of wall-clock time) · **recoverability** (small lost work per failure) · **debuggability at scale** · **cost** (GPU-hours and power) · **numerical stability** (loss converges).

**Clarifying questions:** model size and context length? Token budget and deadline? GPU count and interconnect? Failure tolerance and checkpoint budget? Shared or dedicated cluster? How are data and evaluation integrated?

---

## 2. Memory: why a model does not fit, and ZeRO `[CONFIRMED]` (Rajbhandari et al., 2020)

**What uses memory.** The ZeRO paper explains that model states (parameters, gradients, optimizer state) consume most device memory. Mixed-precision training with Adam holds fp16 parameters and gradients (2Ψ and 2Ψ bytes for Ψ parameters) plus fp32 parameters, momentum and variance (4Ψ + 4Ψ + 4Ψ), giving "16Ψ bytes". A 1.5-billion-parameter model therefore needs at least 24 GB for model states alone. Activations add more: the paper's example, a 1.5B model with sequence length 1K and batch size 32, needs about 60 GB, reduced to about 8 GB by activation checkpointing (recomputation) at roughly 33% extra compute.

**What plain data parallelism does.** It "does not reduce memory per device", running out of memory for models above about 1.4B parameters on 32 GB GPUs, because every worker holds a full copy.

**ZeRO-DP.** It partitions the redundant states across data-parallel workers in three cumulative stages: optimizer state (4 times less memory, same communication as data parallelism), plus gradients (8 times), plus parameters (memory falls linearly with the number of workers; for 64 GPUs a 64 times reduction at a modest 50% increase in communication). The paper's example: a trillion-parameter model needs about 16 TB for these states, which divided over 1,024 GPUs is 16 GB each. Fully sharded data parallelism (FSDP), which Llama 3 uses, descends from this idea.

---

## 3. Parallelism at Llama 3 scale `[CONFIRMED]` (Llama Team, Meta, 2024)

Llama 3 405B used "4D parallelism": **tensor parallelism** (split weight tensors across devices), **pipeline parallelism** (split the model by layers into stages), **context parallelism** (split the input sequence, for very long contexts up to 128K tokens) and **data parallelism** with fully sharded optimizer state and gradients. GPUs are grouped in the order [TP, CP, PP, DP]: the innermost dimension needs the most bandwidth and lowest latency and stays within a server; the outermost, data parallelism, tolerates a multi-hop network because it can prefetch sharded weights and reduce gradients asynchronously.

**Reported configurations (Table 4).** For example, 8,192 GPUs with TP 8, PP 16, DP 64 at 8K sequence length reached 430 TFLOPs per GPU and 43% MFU; 16,384 GPUs with DP 128 reached 41%; the long-context stage with context parallelism of 16 reached 38%. The global batch stayed at 16M tokens, so more GPUs meant a smaller batch per data-parallel group.

**Pipeline engineering.** The authors modified the pipeline schedule to allow a flexible number of micro-batches, balanced stages by removing one transformer layer from the first and last stages (the first holds the embedding, the last the output projection and loss), and used asynchronous point-to-point communication. They could pre-train on 8K-token sequences without activation checkpointing.

**Numerics.** Comparing loss across parallelism setups exposed numerical issues; they use FP32 gradient accumulation and FP32 reduce-scatter of gradients.

---

## 4. The cluster: compute, storage, network `[CONFIRMED]` (Llama 3)

- **Compute:** up to 16K H100 GPUs at 700 W each with 80 GB HBM3, in Grand Teton servers with eight GPUs and two CPUs, linked by NVLink within a server. Jobs are scheduled by **MAST**, Meta's global training scheduler.
- **Storage:** Tectonic, a distributed file system, forms the storage fabric: 240 PB across 7,500 SSD servers, 2 TB/s sustainable and 7 TB/s peak. The challenge is bursty checkpoint writes that saturate the fabric briefly. Each GPU's saved state ranges from 1 MB to 4 GB, and the aim is to minimise GPU pause time and raise checkpoint frequency to reduce lost work.
- **Network:** RoCE (RDMA over Ethernet) for the 405B model, InfiniBand for smaller models, 400 Gbps between GPUs. The RoCE cluster has 24K GPUs on a three-layer Clos network: 16 GPUs per rack, 192 racks per pod of 3,072 GPUs with full bisection bandwidth, eight pods per cluster with 1:7 oversubscription at the top. Parallelism and the scheduler are topology-aware to minimise cross-pod traffic. Llama 3 used up to 16K of the 24K GPUs.
- **Load balancing:** training produces a few "fat" flows that ECMP routing balances poorly, so the collective library opens 16 flows between two GPUs and an enhanced ECMP hashes on extra RoCE header fields. Deep-buffer spine switches absorb transient congestion, and the cluster runs without DCQCN congestion control.
- **Collectives:** NCCLX, a fork of NCCL tuned for high-latency networks, handles all-gather and reduce-scatter (FSDP) and point-to-point (pipeline).

---

## 5. Reliability: failures are the normal case `[CONFIRMED]`

**Llama 3 numbers.** "The complexity and potential failure scenarios of 16K GPU training surpass those of much larger CPU clusters", and "a single GPU failure may require a restart of the entire job". Even so, Llama 3 achieved "higher than 90% effective training time" while also performing automated maintenance. In a 54-day period there were 466 interruptions: 47 planned (maintenance, configuration or dataset updates) and 419 unexpected. About 78% of the unexpected were attributed to confirmed or suspected hardware; GPU causes were 58.7%, led by faulty GPUs, HBM3 memory failures, and software bugs, network switch or cable faults and host maintenance next. Manual intervention was needed only three times; automation handled the rest.

**Operational tools.** The team used PyTorch's NCCL flight recorder (a ring buffer of collective metadata and stack traces dumped on watchdog timeout), faster job startup and checkpointing, and selective, live-enabled heavier tracing without a restart. Stalls on NVLink often show as hung CUDA kernels without an error, so the communication library monitors state and times out. **Stragglers** are still-functioning but slow hardware; "even a single straggler can slow down thousands of other GPUs", found by prioritising suspicious communications.

**Environment effects.** They saw a 1–2% diurnal throughput change tied to temperature, and power swings on the order of tens of megawatts when all GPUs wait on a checkpoint or start and stop together.

**MegaScale's robust training workflow (ByteDance, 2024).** A driver process allocates nodes through a custom Kubernetes; each executor runs a daemon that sends **heartbeats** with information for anomaly detection. When the driver sees an abnormal status or misses a heartbeat, it suspends training on all executors and runs lightweight **self-check diagnostics**, then evicts the faulty nodes, replenishes healthy ones, and resumes from the latest checkpoint. Checkpointing is two-stage: each GPU copies its state to host memory (seconds) and continues, while a background process writes to HDFS. On recovery, one worker per data-parallel group reads the shared partition and shares it, cutting the load on HDFS. In a production run lasting several weeks on over 10,000 GPUs, training restarted over 100 times, and over 90% of software and hardware faults were found and fixed automatically.

---

## 6. Reference view of the whole system `[INDUSTRY PATTERN]`

```
researcher ─► job scheduler (topology-aware) ─► GPU cluster (servers · NVLink · RoCE/InfiniBand fabric)
                                                      │
data store ─► data loaders ─► training job (TP · CP · PP · FSDP) ─► checkpoints ─► distributed file system
                                                      │
                          heartbeats · logs · flight recorder ─► fault detection ─► evict, replace, resume
```

- **Scheduler:** places jobs by network topology, keeps spare nodes, and supports automated maintenance windows.
- **Data pipeline:** deterministic, resumable data loading so a restart continues from the same data position.
- **Evaluation during training:** periodic evaluation on held-out sets to catch divergence early; stop or roll back on loss spikes.
- **Cost and capacity:** schedule a few very large jobs and many small ones, reserve headroom for failures, track power.
- **Hand-off:** the finished model goes to post-training and evaluation (see [28 LLM fine-tuning and evaluation](28-llm-finetuning-evaluation.md)) and serving (see [22 LLM inference serving](22-llm-inference-serving.md)).

---

## 7. Capacity reasoning (illustrative)

- **Model-state memory** ≈ 16 bytes × parameters (ZeRO's formula). For a 405-billion-parameter model that is about 6.5 TB before activations, which is why states must be sharded across many GPUs. This is our arithmetic using the paper's formula.
- **Aggregate GPU memory:** 16,384 GPUs × 80 GB ≈ 1.3 PB, so sharded states fit with room for activations and buffers.
- **Interruption rate:** 419 unexpected interruptions over 54 days is roughly one every three hours (54 × 24 ÷ 419), our division of the reported counts. A job that restarts that often needs checkpoints measured in minutes, not hours.
- **Lost work per failure** ≈ half the checkpoint interval plus restart time. Halving the interval halves expected loss and raises the checkpoint write load.

---

## ⚠️ Reviewer notes

1. **The Llama 3 interruption table does not add up in one cell.** It lists 148 faulty-GPU interruptions at 30.1%, but 148 of 419 is 35.3%; the other rows and the 58.7% GPU total are consistent with the percentages. We quote the percentages and the text, and do not rely on the 148.
2. **MFU figures come from different models and definitions.** Llama 3's 38–43% and MegaScale's 55.2% use different models, hardware and baselines; do not compare them as if from one benchmark.
3. **These are two companies' clusters.** The sources do not describe Google, OpenAI or Anthropic training systems, and we make no claim about them.
4. **ZeRO is a 2020 paper.** FSDP is a later implementation of the same idea; Llama 3 modifies how it reshards model weights.
5. **Not read:** Llama 3 pre-training data sections, Megatron-LM, GPipe and PipeDream papers, mixture-of-experts training, TPU-based systems, and cost or power analyses.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (utilisation), **reliability/recoverability**, **observability**, **cost efficiency**, **scalability**.
- **Style (Ch 13):** a **tightly coupled, synchronous compute fabric** managed by a control plane (scheduler, fault detection, recovery).
- **Quanta (Ch 7):** the whole training job is one architectural quantum, which is exactly why any single failure stops everything; the control plane and storage are separate quanta.
- **Trade-off (First Law, Ch 1):** **utilisation vs recoverability.** More frequent checkpoints and diagnostics cost throughput and buy faster recovery.
- **ADR sketch (Ch 19):** *"We will shard model state across data-parallel workers, place parallelism dimensions by network demand, and checkpoint in two stages with automatic node replacement. We accept the engineering cost of topology-aware scheduling in exchange for higher utilisation and effective training time."*
- Plain English: split the model, keep neighbours close, photograph often, and swap broken parts fast.

---

## Interview questions to practice

1. How do you train a model that does not fit on one GPU?
2. Explain data, tensor and pipeline parallelism. When do you use each?
3. How much memory does training need per parameter, and what does ZeRO change?
4. A GPU fails every few hours on a 16K-GPU job. How do you keep making progress?
5. How would you design checkpointing for a huge cluster?
6. What is a straggler, and how do you find one?
7. How does network topology affect your parallelism plan?
8. How do you measure whether the cluster is used well?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: model size, tokens, GPUs, deadline, failure budget.
2. Estimate: memory per parameter, GPUs needed, tokens per second, expected failures per day.
3. Plan parallelism: placement of tensor, pipeline, context and data dimensions against the network.
4. Design the control plane: scheduler, heartbeats and diagnostics, node replacement, checkpointing.
5. Deep dive: checkpoint format, frequency and storage; data loading and resumption.
6. Failure and scale: single-GPU failure, straggler, storage saturation, loss spike, power.

**If it grows 10×**
- Failures scale with GPU count: invest in automation and faster checkpoints before more GPUs.
- Network becomes the limit: more topology awareness and communication overlap.
- Power and cooling: stagger synchronised phases.

**Answer outlines** (try the questions above first)

<details><summary>How do you keep progress with frequent failures?</summary>

Detect fast with heartbeats and timeouts, diagnose with automated checks, evict the bad node and bring a healthy one, then resume from the last checkpoint. Keep checkpoints frequent and cheap with a two-stage save, keep spare nodes, and automate everything common so humans handle only the odd cases.

</details>

<details><summary>How do you checkpoint at this scale?</summary>

Each GPU saves its own shard; copy to host memory first so the GPU resumes in seconds, then write to the distributed file system in the background. On restore, have one worker per data-parallel group read and share the common shard to avoid overloading storage.

</details>

<details><summary>Why does topology matter?</summary>

Tensor parallelism exchanges data every layer and needs the fastest links, so it stays inside a server; data parallelism communicates least often and can cross pods. The scheduler must place groups so that high-traffic dimensions share fast links.

</details>

## 📚 Further reading

- The three sources listed under Sources and provenance.
- [`neokim-post/01` How LLMs work](../../neokim-post/01-how-llms-work.md) for model and training basics.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [22 LLM inference serving](22-llm-inference-serving.md), [28 LLM fine-tuning and evaluation](28-llm-finetuning-evaluation.md), [04 Kafka](04-message-queue-kafka.md) and [05 S3](05-object-storage-s3.md) for storage and replication ideas.

## Sources and provenance

> **Kind:** real system. The Llama 3 report and the MegaScale paper describe real production clusters; ZeRO describes a published method. The reference view in section 6 is our summary shape.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Llama Team, Meta, [*The Llama 3 Herd of Models*](https://arxiv.org/pdf/2407.21783) (2024; Section 3.3 Infrastructure, Scaling and Efficiency) · Jiang et al., [*MegaScale: Scaling Large Language Model Training to More Than 10,000 GPUs*](https://arxiv.org/pdf/2402.15627) (ByteDance, 2024) · Rajbhandari et al., [*ZeRO: Memory Optimizations Toward Training Trillion Parameter Models*](https://arxiv.org/pdf/1910.02054) (2020).
> **Dated material:** 2020–2024. Hardware and practice move quickly.
> **Not read:** Llama 3 data and training recipe sections, Megatron-LM and pipeline papers, TPU-based training, mixture-of-experts.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the Llama 3 report: 16K H100s, 700 W, 80 GB HBM3, eight GPUs per server with NVLink, MAST, Tectonic (240 PB, 7,500 servers, 2 TB/s sustained, 7 TB/s peak), checkpoint sizes 1 MB to 4 GB per GPU, RoCE and InfiniBand at 400 Gbps, the 24K Clos topology and 1:7 oversubscription, load balancing and congestion control, 4D parallelism and ordering, Table 4 MFU values, pipeline changes, NCCLX, 466 interruptions (47 planned, 419 unexpected), 78% hardware, 58.7% GPU, more than 90% effective training time, three manual interventions, straggler and environment observations. The table cell inconsistency is noted in the reviewer notes.
- Verified in MegaScale: 55.2% MFU on 12,288 GPUs and 1.34 times Megatron-LM, heartbeat and diagnostics workflow, two-stage checkpointing, shared read of data-parallel partitions, more than 100 restarts and over 90% automatic fixes in a multi-week run.
- Verified in ZeRO: 16Ψ bytes with K = 12, the 24 GB and 60 GB / 8 GB examples, three stages with 4 times, 8 times and Nd times reductions, 50% extra communication, the trillion-parameter example on 1,024 GPUs.
- Labelled industry pattern, not sourced: the reference diagram, data-loader and evaluation practices, cost framing, and the arithmetic in section 7.
- Not claimed: the training systems of any company other than those in the sources.
