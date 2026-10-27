# P08 — Cost as a design input

*A primer on treating cost as an architectural quality. Principles come from the AWS Well-Architected cost pillar and the FinOps Foundation; the cost levers and the cross-references to atlas numbers are our reasoning and are labelled.*

## At a glance

Architects are expected to know what a design costs and what drives that cost. The published frameworks are short and agree on a few ideas: cost is owned by the people who design and run the system, it should be measured against **business output** (unit economics) rather than as a raw total, usage should follow demand, and cost data should be fast and visible. Beyond those principles, the useful skill is knowing **which resource dominates** in each kind of system and which levers move it.

**In 60 seconds:** estimate the dominant resource first (storage, egress bandwidth, compute, GPU hours, tokens, engineer time), express cost per unit of value (per user, per request, per million tokens), name two levers and what each gives up, and say how you would measure it in production.

---

## 1. The published principles `[CONFIRMED]`

**AWS Well-Architected, cost optimization pillar.** A cost-optimized workload "fully utilizes all resources, achieves an outcome at the lowest possible price point, and meets your functional requirements". Its design principles:
- **Implement cloud financial management:** invest time and resources to build capability, as you would for security or operations.
- **Adopt a consumption model:** pay only for what you consume and scale usage with demand; the example is that development and test environments used eight hours a day on weekdays can be stopped otherwise for a potential saving of 75% (40 hours versus 168 hours).
- **Measure overall efficiency:** measure the business output of the workload and the cost of delivering it.
- **Stop spending money on undifferentiated heavy lifting:** use managed services for work like data-center operations and operating-system management so teams can focus on customers.
- **Analyze and attribute expenditure:** attribute costs to workloads, owners and revenue streams to measure return on investment.

The pillar is organised around practising cloud financial management, expenditure and usage awareness, cost-effective resources, managing demand and supply, and optimizing over time. It is a framework: the whitepaper says it "does not provide implementation details or architectural patterns".

**FinOps Foundation principles.** Teams need to collaborate (finance, technology, product and business work together in near real time); decisions are driven by the business value of cloud ("unit economic and value-based metrics demonstrate business impact better than aggregate spend", and teams "make conscious trade-off decisions among cost, quality, and speed"); everyone takes ownership of their cloud usage, with engineers owning cost "from architecture design to ongoing operations"; FinOps data should be accessible and timely; and a centralized team drives FinOps as an enabler, "much like security". The Foundation defines FinOps as "an operational framework and cultural practice which maximizes the business value of cloud".

## 2. What drives cost in each kind of system `[INDUSTRY PATTERN]`, with numbers from the atlas

| System type | Usually dominant cost | Levers (and what they give up) | Atlas evidence |
|---|---|---|---|
| Blob and media storage | Storage plus egress | Tiering and cooling (slower access), erasure coding (CPU, repair traffic), CDN offload | [05 S3](../systems/05-object-storage-s3.md), [07 Photos](../systems/07-photo-upload-storage.md), [13 Netflix](../systems/13-netflix.md) |
| Live video | Transcoding compute and bandwidth | Transcode only popular channels, hardware encoders (a Twitch engineer said in a 2021 interview that its hardware transcoder work was expanding capacity 10 times at only two times the cost) | [29 Live streaming](../systems/29-live-streaming-twitch.md) |
| Time-series / observability | Memory | Compression (Gorilla's 12 times reduction), shorter hot window, rollups | [30 Monitoring](../systems/30-metrics-monitoring-alerting.md) |
| Search and vector indexes | RAM | Compressed vectors, SSD-resident indexes (DiskANN: a billion points on a 64 GB machine) | [24 Vector search](../systems/24-vector-semantic-search.md) |
| LLM serving | GPU hours | Batching, paged KV cache, smaller models for easy requests, caching | [22 LLM serving](../systems/22-llm-inference-serving.md) |
| Agents | Tokens | Fewer steps, caching, smaller models (Anthropic reports about 15 times more tokens for multi-agent than chat) | [25 AI agent platform](../systems/25-ai-agent-platform.md) |
| Training | GPU hours and failures | Higher utilisation, faster recovery, adapters instead of full fine-tuning | [27 Training](../systems/27-llm-training-infrastructure.md), [28 Fine-tuning](../systems/28-llm-finetuning-evaluation.md) |
| Streaming analytics | Compute and storage of events | Sampling, pre-aggregation, retention | [31 Ad clicks](../systems/31-ad-click-aggregation.md) |
| Chat / real time | Connections and fan-out | Connection density, regional placement | [08 Chat](../systems/08-chat-whatsapp.md), [09 Discord](../systems/09-discord.md) |

## 3. A cost conversation in a design review `[INDUSTRY PATTERN]`

1. **Unit cost:** cost per user, per request, per GB stored or per million tokens, with the assumptions.
2. **Dominant driver and the 10× question:** what happens to cost if load grows 10 times? Which part scales worse than linearly?
3. **Elasticity:** what scales down at night or between launches? What is committed (reserved, fixed) and what is on demand?
4. **Levers and trade-offs:** each saving gives up something (latency, durability, freshness, quality); name it.
5. **Ownership and visibility:** tags, per-team budgets and alerts so cost surprises appear in days, not at month end.
6. **Build versus buy:** compare the full cost, including engineers' time and on-call, not just the infrastructure bill (the AWS principle on undifferentiated heavy lifting is one side of this argument; the other is lock-in and control, which these sources do not weigh).
7. **Reliability coupling:** more nines cost more (see [P07](P07-slos-and-incidents.md)); price the target.

---

## Questions to practise

1. What dominates the cost of a video platform, a vector search service and an LLM chatbot? Why?
2. How would you reduce the cost of a storage-heavy service without hurting durability?
3. What does 'unit economics' mean for an API product?
4. When is a managed service cheaper than running it yourself, and when not?
5. A 10× traffic spike is expected. Which parts of your design get 10× more expensive, and which do not?

## Practice

Take one system from the atlas, estimate its monthly cost at 10 million users with explicit unit prices, identify the dominant line item, and propose two savings with their trade-offs.

**Related:** [P01 Estimation](P01-estimation.md), [P07 SLOs](P07-slos-and-incidents.md), [22 LLM inference serving](../systems/22-llm-inference-serving.md), [29 Live streaming](../systems/29-live-streaming-twitch.md), [30 Monitoring](../systems/30-metrics-monitoring-alerting.md).

## Sources and provenance

> **Sources read on 2026-10-27:** AWS, [Cost Optimization Pillar whitepaper](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html) and [Design principles](https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/design-principles.html) (Well-Architected, whitepaper dated 27 June 2024) · FinOps Foundation, [Principles](https://www.finops.org/framework/principles/) and [What is FinOps](https://www.finops.org/introduction/what-is-finops/) (read through Internet Archive copies).
> **Dated material:** The AWS whitepaper is from 2024; cloud prices and FinOps materials change frequently.
> **Not read:** Actual cloud price lists, reserved-capacity and committed-use discount mechanics, the FinOps framework capabilities and maturity model, and cost-benchmark studies.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the AWS pages: the definition of a cost-optimized workload, the five design principles including the 75% example, the six pillars and the statement about implementation details.
- Verified in the FinOps pages: the principles as summarised and quoted, and the definition of FinOps.
- Not sourced (our reasoning): the cost-driver table's driver and lever columns (the numbers in it are from the cited atlas notes, each sourced there), and the design-review procedure.
