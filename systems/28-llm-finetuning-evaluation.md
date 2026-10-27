# 28 — LLM Fine-tuning, Evaluation and Deployment Pipeline

*A reference design built on published methods (LoRA, InstructGPT, DPO, S-LoRA, LLM-as-a-judge) and one detailed public recipe (Llama 3 post-training). How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** You have a model that is good but not good enough: it misses your domain, ignores your format, or says things you cannot ship. Improving it is a loop, not a one-off job: **curate data**, **train** (full fine-tuning, LoRA adapters, or preference tuning), **evaluate against a gate** (quality, regressions, safety, latency, cost), **roll out gradually** and **watch production** so the failures become the next round of data. Try cheaper options first (better prompts, retrieval); fine-tune when behaviour, style or a narrow skill must change. The most common failure is a model that improves on the target metric and quietly gets worse somewhere else.

**Key numbers** (as published, in the authors' tests)
- LoRA cut trainable parameters by 10,000 times and training GPU memory by 3 times compared with full fine-tuning of GPT-3 175B with Adam, with quality on par or better `[CONFIRMED]`; the checkpoint shrank from 350 GB to 35 MB under the paper's setup `[CONFIRMED]`.
- InstructGPT: outputs of a 1.3B model fine-tuned with human feedback were preferred to those of the 175B GPT-3, with 100 times fewer parameters `[CONFIRMED]`.
- Llama 3 post-training used six rounds of supervised fine-tuning, rejection sampling and DPO `[CONFIRMED]`; DPO "required less compute for large-scale models and performed better" than PPO in their tests `[CONFIRMED]`.
- S-LoRA served thousands of LoRA adapters on one or more GPUs, with up to 4 times the throughput of vLLM with naive LoRA support when serving a small number of adapters (the baseline cannot scale to many) and up to 30 times that of HuggingFace PEFT while supporting a significantly larger number of adapters `[CONFIRMED]` (the authors' benchmarks, on Llama-7B and 13B models on A10G and A100 GPUs).
- Strong LLM judges matched human preferences with over 80% agreement, the same level as agreement between humans `[CONFIRMED]` (MT-Bench paper).

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| LoRA adapters instead of full fine-tuning | Tiny checkpoints, cheap training, many variants | May not match full fine-tuning for large behaviour changes |
| Preference tuning with DPO instead of PPO-based RLHF | Simpler, no sampling during tuning | Needs good preference pairs; data quality dominates |
| Gate every release on an evaluation suite | Catch regressions before users do | Building and maintaining the suite is real work |
| LLM judge for open-ended quality | Scales where humans do not | Judges have biases; calibrate with humans |
| Canary rollout with fast rollback | Limits blast radius | Needs routing and monitoring in place |

**Common mistakes**
- Fine-tuning to inject facts. Retrieval (see [23 RAG knowledge assistant](23-rag-knowledge-assistant.md)) updates knowledge; fine-tuning shapes behaviour.
- Measuring only the target task. InstructGPT reported regressions on public benchmarks (an "alignment tax") that needed a specific fix.
- Evaluating on data that leaked into training (contamination).
- Trusting an LLM judge without checking its biases.
- No rollback plan for a model release.

---

## 🧒 Non-technical explanation

Imagine **coaching a talented new hire**. First you check whether a clearer brief or a reference binder would be enough (prompting, retrieval). If they still need to change how they work, you give them worked examples, then have them produce several answers and tell them which ones you prefer. After each round you give them a standard test, including the old tests, so you notice if fixing one weakness created another. Only then do they meet customers, first a few, with a supervisor who can pull them off the desk instantly. Everything that goes wrong with real customers goes into the next training round.

---

## TL;DR for engineers

- **Order of attempts:** prompt, then retrieval, then fine-tune `[INDUSTRY PATTERN]`; Anthropic notes that "optimizing single LLM calls with retrieval and in-context examples is usually enough" for many applications `[CONFIRMED]`.
- **LoRA** freezes the model and trains small low-rank matrices, so adapters are tiny and swappable `[CONFIRMED]`.
- **Alignment recipe:** supervised demonstrations, then preference data, then a preference-optimisation step (RLHF with PPO in InstructGPT; DPO in Llama 3) `[CONFIRMED]`.
- **Data quality** is the main lever and a heavy engineering effort in Llama 3 (cleaning, pruning, scoring, deduplication) `[CONFIRMED]`.
- **Evaluation** combines benchmarks, human or LLM-judge preference, safety metrics (violation rate and false refusal rate) and contamination checks `[CONFIRMED]` as practised in the sources.
- **Serving many adapters** is a memory-management problem solved by S-LoRA `[CONFIRMED]`.
- **Release gates, canary, rollback, feedback loop:** the platform around the training `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** ingest and curate training data · run fine-tuning jobs (full, adapter, preference tuning) · evaluate candidates automatically · register versions · deploy gradually and roll back · collect production feedback for the next round.

**Non-functional:** **quality** (target metric up) · **no regressions** (other capabilities, safety) · **reproducibility** (data and config versioned) · **cost** (GPU hours, labelling) · **speed of iteration** · **safety and compliance** (training data permission, privacy) · **serving cost** of many variants.

**Clarifying questions:** what is wrong with the current model, and is it knowledge, behaviour or format? How much labelled data exists, and who can label? How many variants (per customer, per task)? What must never regress? How often do we release? What does a bad release cost?

---

## 2. Should you fine-tune? `[INDUSTRY PATTERN]`, with one sourced anchor

Try in this order and stop when the metric is met: a better prompt and examples, then retrieval, then fine-tuning. Anthropic's guidance says "optimizing single LLM calls with retrieval and in-context examples is usually enough" for many applications and recommends only adding complexity when it "demonstrably improves outcomes" `[CONFIRMED]` (see [25 AI agent platform](25-ai-agent-platform.md)). Fine-tune when you need consistent style or format, a narrow skill the base model lacks, lower cost by using a smaller tuned model, or behaviour that prompts cannot enforce. Do not fine-tune to add facts that change; use retrieval.

---

## 3. Methods

### 3.1 LoRA: cheap, swappable adapters `[CONFIRMED]` (Hu et al.)

Full fine-tuning "retrains all model parameters", and "deploying independent instances of fine-tuned models, each with 175B parameters, is prohibitively expensive". **LoRA** freezes the pre-trained model weights and injects small trainable rank decomposition matrices into each layer of the Transformer. The update to a weight matrix W0 is represented as W0 + BA with a small rank r.

Reported effects on GPT-3 175B: trainable parameters down by 10,000 times and GPU memory requirement down by 3 times; quality on par or better than fine-tuning on the models they tested; and, unlike adapters inserted as extra layers, "no additional inference latency", because BA can be merged into W0. Training VRAM fell from 1.2 TB to 350 GB, and with r = 4 on the query and value projections the checkpoint shrank from 350 GB to 35 MB. Switching tasks means swapping the small matrices, "a quick operation with very little memory overhead".

**What this means for design:** one base model plus many small adapters (per customer or task), versioned like code.

### 3.1b QLoRA: fine-tuning a large model on one GPU `[CONFIRMED]` (Dettmers et al., 2023)

QLoRA extends LoRA to cut memory further so large models can be tuned on modest hardware. The abstract says it is efficient enough "to finetune a 65B parameter model on a single 48GB GPU while preserving full 16-bit finetuning task performance". It "backpropagates gradients through a frozen, 4-bit quantized pretrained language model into Low Rank Adapters". Three memory savings: **4-bit NormalFloat (NF4)**, a data type the authors call information-theoretically optimal for normally distributed weights; **Double Quantization**, quantizing the quantization constants; and **Paged Optimizers** to manage memory spikes. Their Guanaco model family reached 99.3% of ChatGPT's performance on the Vicuna benchmark with 24 hours of fine-tuning on one GPU (the authors' claim on that benchmark and period).

Two findings matter for the evaluation section below: fine-tuning on a small, high-quality dataset gave state-of-the-art results even with smaller models, and the authors found that GPT-4 evaluations are "a cheap and reasonable alternative to human evaluation" while "current chatbot benchmarks are not trustworthy to accurately evaluate the performance levels of chatbots". For system design: LoRA-style adapters can sit on a quantized base, lowering the GPU needed for training; whether quantization is acceptable for serving quality is a separate evaluation question the paper does not settle.

### 3.2 Aligning with human feedback: InstructGPT `[CONFIRMED]` (Ouyang et al., 2022)

The recipe: collect labeler-written and API prompts, collect human **demonstrations** and fine-tune with supervised learning; collect **rankings** of model outputs, train a reward model; then fine-tune with reinforcement learning (PPO) against the reward model. The paper reports hiring a team of 40 contractors; the datasets were about 13k prompts for supervised fine-tuning, 33k for the reward model and 31k for PPO.

Results: outputs from the 1.3B InstructGPT were preferred to the 175B GPT-3 despite "100x fewer parameters"; 175B InstructGPT was preferred to 175B GPT-3 outputs 85 ± 3% of the time; on closed-domain tasks it made up information about half as often (21% versus 41%); it produced about 25% fewer toxic outputs when prompted to be respectful; it did not significantly improve on two bias datasets.

**The alignment tax.** RLHF caused performance regressions on public datasets (SQuAD, DROP, HellaSwag, WMT 2015 French to English). Mixing in updates that increase the likelihood of the pretraining distribution (PPO-ptx) greatly reduced them "without compromising labeler preference scores".

**Whose preferences.** The authors state the procedure aligns the model to the stated preferences of a specific group (mostly labelers and researchers), "rather than any broader notion of 'human values'".

### 3.3 DPO: preference tuning without a reward-model loop `[CONFIRMED]` (Rafailov et al., 2023)

RLHF is described as "a complex and often unstable procedure". DPO uses a parameterisation that lets the standard problem be solved "with only a simple classification loss", with no sampling from the model during fine-tuning and little hyperparameter tuning. The authors report it matches or exceeds PPO-based RLHF on sentiment control, summarisation and single-turn dialogue, while being simpler.

### 3.4 A full public recipe: Llama 3 post-training `[CONFIRMED]` (Meta, 2024)

Llama 3 is aligned with "several rounds of post-training", each round being supervised fine-tuning (SFT) followed by DPO on examples collected by human annotation or generated synthetically; the paper applies "six rounds". The backbone is a reward model trained on human preference data and the language model. Key elements:
- **Rejection sampling:** for each prompt, sample K outputs (typically 10 to 30) from the latest model and use the reward model to pick the best; those become training data. PagedAttention (see [22 LLM inference serving](22-llm-inference-serving.md)) gave over 2 times higher throughput for this step.
- **DPO details:** mostly the newest preference data, so data matches the current policy; they tried PPO but DPO needed less compute and performed better, especially on instruction-following benchmarks; learning rate 10⁻⁵ and β 0.1; formatting tokens masked from the loss for stability.
- **Model averaging:** average models from experiments with different data or hyperparameters at each reward-model, SFT or DPO stage.
- **Data cleaning and quality control** because most data is model-generated: rule-based removal of patterns such as excessive emojis or overly apologetic phrases; topic classification; quality scoring using both reward-model and Llama-based signals (examples marked high quality by either were kept, as the two disagreed often); difficulty scoring; semantic deduplication.
- **Safety:** a violation rate measured on adversarial prompts and a **false refusal rate** measured on borderline prompts, optimised together, with red teaming and a separate Llama Guard model for input and output safety.

This is a large-organisation recipe; the sources do not say which parts matter most for a smaller team.

---

## 4. Evaluation `[CONFIRMED]` where noted, otherwise `[INDUSTRY PATTERN]`

- **Why traditional benchmarks are not enough.** The MT-Bench paper observes that aligned models are strongly preferred by users while benchmarks like MMLU and HELM "cannot effectively tell the difference" between aligned and base models.
- **LLM-as-a-judge.** Using strong models to judge answers to open-ended questions reached "over 80% agreement" with human preferences, "the same level of agreement between humans". The paper also names the limits: **position, verbosity and self-enhancement biases**, and limited reasoning ability, with mitigations proposed. Calibrate any judge against human labels on your own task.
- **Contamination.** Llama 3 includes an analysis of how much benchmark scores may be influenced by evaluation data appearing in the pre-training corpus. Keep your evaluation sets out of training data and check for overlap.
- **Safety pair of metrics.** Track violations and false refusals together, since lowering one tends to raise the other `[CONFIRMED]` (Llama 3 optimises both).
- **Regression suite** `[INDUSTRY PATTERN]`: a fixed set of tasks covering what the model did well before (general capability, format following, previously fixed bugs), plus latency and cost per request. A release gate compares the candidate with the current production model, not with a number in isolation.
- **Human review** `[INDUSTRY PATTERN]`: samples of disagreements and of the worst-scoring cases.

---

## 5. Serving many fine-tuned variants: S-LoRA `[CONFIRMED]` (Sheng et al., 2023)

With adapters, one deployment can serve many customised models, but naive designs load each adapter into GPU memory. **S-LoRA** "stores all adapters in the main memory and fetches the adapters used by the currently running queries to the GPU memory". **Unified Paging** uses one memory pool for adapter weights of different ranks and KV-cache tensors of varying lengths, reducing fragmentation. It adds a tensor-parallel strategy and custom kernels for batching requests that use different adapters. Reported results: thousands of adapters served on a single GPU or across several, up to 4 times the throughput of vLLM with naive LoRA support when serving a small number of adapters, up to 30 times that of HuggingFace PEFT, and several orders of magnitude more adapters served. The 4 times figure is at small adapter counts, because the baseline cannot scale to a large number; the paper's benchmarks use Llama-7B and 13B models on A10G and A100 GPUs.

---

## 6. The platform `[INDUSTRY PATTERN]`

```
production feedback ─► data pipeline (filter, dedup, quality score, version) ◄─ annotators
                              │
        pretrained model ─► training jobs (SFT · LoRA · DPO · rejection sampling) on a GPU cluster
                              │ candidate model or adapter
                              ▼
                       model registry ─► evaluation gate ──► pass? ─► canary router ─► serving (base + adapters)
                         (versioned)      benchmarks · regression · judge · safety · cost    │
                                                                                monitoring ◄─┘ ─► rollback / next round
```

- **Data pipeline:** versioned datasets with lineage, permission and PII checks, deduplication, and a quality score; held-out evaluation data kept separate.
- **Training jobs:** reproducible configs, checkpointing, and the infrastructure covered in [27 LLM training infrastructure](27-llm-training-infrastructure.md).
- **Registry:** every model and adapter with its data version, config, metrics and approval state.
- **Evaluation gate:** automatic; blocks release if any protected metric regresses beyond a threshold or safety worsens.
- **Rollout:** shadow traffic (candidate runs, answer not shown), then a small canary percentage, then ramp; automatic rollback on error rate, latency, user-feedback or safety signal.
- **Monitoring and feedback:** track quality proxies (thumbs, edits, escalations), drift, and cost; sample failures into the next round's data.
- **Serving:** adapters per tenant or task on shared base models, as in S-LoRA; see [22 LLM inference serving](22-llm-inference-serving.md).
- **Governance:** record who approved a release and which data it used.

---

## 7. Failure scenarios

- **Regression slips through.** The candidate is better on the target metric and worse elsewhere. The regression suite and a gate against the production model catch it `[CONFIRMED]` that such regressions occur (InstructGPT's alignment tax); the gate is `[INDUSTRY PATTERN]`.
- **Evaluation contamination.** Scores look great because test data was in training data; check overlap `[CONFIRMED]` as a practised analysis (Llama 3).
- **Judge bias.** A model judge prefers longer or first-listed answers; randomise order, control length, check against humans `[CONFIRMED]` (MT-Bench).
- **Bad data poisons the model.** Cleaning, pruning and deduplication, as in Llama 3 `[CONFIRMED]`.
- **Canary shows live degradation.** Roll back to the previous version `[INDUSTRY PATTERN]`.
- **Over-refusal or unsafe outputs.** Track both violation and false-refusal rates `[CONFIRMED]`.
- **Adapter sprawl.** Thousands of adapters need lifecycle management, memory-aware scheduling and cleanup `[INDUSTRY PATTERN]`; S-LoRA addresses the serving side `[CONFIRMED]`.

---

## 8. Cost reasoning (illustrative)

- **Full fine-tuning memory** is dominated by optimizer state; LoRA's reported 3 times reduction and 35 MB checkpoints change the economics of many variants. Your numbers depend on model size and rank.
- **Labelling** cost ≈ examples × minutes × hourly rate; InstructGPT's datasets were in the tens of thousands of prompts, but modern recipes mix human and synthetic data.
- **Evaluation cost** per candidate ≈ suite size × cost per call, plus judge calls. A suite run on every candidate should be cheap enough to run often.
- **Serving** many adapters on a shared base is far cheaper than a deployment per variant, per the S-LoRA results.

---

## ⚠️ Reviewer notes

1. **Results are from specific models and tasks.** LoRA's numbers are for GPT-3-era and smaller models, InstructGPT's for 2022 models and its labelers' preferences, and Llama 3's for Meta's data and scale.
2. **DPO versus PPO is not settled by one result.** Llama 3 reports DPO better for them; the DPO paper reports parity or better on its tasks. We do not claim DPO always wins.
3. **LLM-judge agreement was measured on MT-Bench and Chatbot Arena data,** with GPT-4 as judge. It need not hold for your task or judge.
4. **The release pipeline (gate, shadow, canary, rollback) is industry practice,** not sourced.
5. **Not read:** other adapter variants (QLoRA is covered in section 3.1b), RLHF safety datasets in detail, evaluation platforms, data-licensing guidance, and vendor fine-tuning service documentation.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **quality assurance** (no regressions), **reproducibility**, **agility** (fast iteration), **safety**, **cost efficiency**.
- **Style (Ch 13):** a **pipeline** (data → train → evaluate → deploy) closed into a loop by production feedback.
- **Quanta (Ch 7):** training and serving are independent quanta joined by the registry; the evaluation gate is the contract between them.
- **Trade-off (First Law, Ch 1):** **speed of iteration vs safety of release.** More evaluation and slower ramps lower risk and slow improvement.
- **ADR sketch (Ch 19):** *"We will ship models and adapters only through an automatic evaluation gate that compares with the production model, then a canary with automatic rollback. We accept slower releases in exchange for catching regressions before users do."*
- Plain English: train, test against the old tests, release to a few, watch, repeat.

---

## Interview questions to practice

1. Our chatbot is wrong about our domain and ignores our format. How would you improve it?
2. When do you fine-tune instead of using retrieval or better prompts?
3. What is LoRA, and why does it matter for serving many customers?
4. How do you prevent a fine-tuned model from regressing on other tasks?
5. How do you evaluate open-ended output? What are the pitfalls of an LLM judge?
6. How would you roll out a new model version safely?
7. How would you build the data pipeline, and what goes wrong with bad data?
8. How would you serve a thousand customer-specific variants?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: what is failing, available data and labelers, number of variants, protected behaviours, release cadence.
2. Decide the approach: prompt, retrieval, adapter fine-tuning, preference tuning; justify.
3. Design the pipeline: data curation, training jobs, registry, evaluation gate, rollout, monitoring.
4. Deep dive: the evaluation suite (target, regression, safety, cost) and the judge's limits.
5. Serving: shared base with adapters, memory management.
6. Failure and scale: regression, contamination, bad data, rollback, adapter growth.

**If it grows 10×**
- Variants: adapter lifecycle, memory-aware serving, automated per-tenant evaluation.
- Data: quality scoring and deduplication become the bottleneck; invest in tooling and active selection.
- Evaluation: keep the suite fast, sample, and use judges with human calibration.

**Answer outlines** (try the questions above first)

<details><summary>How do you prevent regressions?</summary>

Keep a regression suite of what the model did well before, run it on every candidate, and gate release on not getting worse than the production model beyond a tolerance. Mix in general data during tuning, keep the learning rate modest, and watch safety and refusal rates together.

</details>

<details><summary>What are the pitfalls of an LLM judge?</summary>

Position, verbosity and self-enhancement biases, and weak reasoning on hard questions. Randomise answer order, control for length, use a judge from a different family than the model being judged, and calibrate against human labels on your task.

</details>

<details><summary>How do you roll out safely?</summary>

Register the model, pass the gate, run in shadow, then a small canary, ramp while watching quality, latency, cost and safety signals, and keep the previous version warm for instant rollback.

</details>

## 📚 Further reading

- The papers and report listed under Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) for the basics of training and tokens.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [22 LLM inference serving](22-llm-inference-serving.md), [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [25 AI agent platform](25-ai-agent-platform.md), and [27 LLM training infrastructure](27-llm-training-infrastructure.md).

## Sources and provenance

> **Kind:** reference design with real parts. The methods are published; how any company runs its own improvement pipeline is not, apart from the Llama 3 recipe. The release pipeline in section 6 is the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Hu et al., [*LoRA: Low-Rank Adaptation of Large Language Models*](https://arxiv.org/pdf/2106.09685) (2021) · Ouyang et al., [*Training language models to follow instructions with human feedback*](https://arxiv.org/pdf/2203.02155) (2022) · Rafailov et al., [*Direct Preference Optimization*](https://arxiv.org/pdf/2305.18290) (2023) · Dettmers et al., [*QLoRA: Efficient Finetuning of Quantized LLMs*](https://arxiv.org/pdf/2305.14314) (2023) · Sheng et al., [*S-LoRA: Serving Thousands of Concurrent LoRA Adapters*](https://arxiv.org/pdf/2311.03285) (2023) · Zheng et al., [*Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena*](https://arxiv.org/pdf/2306.05685) (2023) · Llama Team, Meta, [*The Llama 3 Herd of Models*](https://arxiv.org/pdf/2407.21783) (2024; Section 4 post-training, parts of Sections 5 and 6) · and, for the anchor in section 2, Anthropic, [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents) (2024).
> **Dated material:** papers from 2021–2024; recipes and best practice change quickly.
> **Not read:** vendor fine-tuning services, other evaluation frameworks, the Llama 3 sections on pre-training data beyond what is cited here.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in LoRA: abstract claims (10,000 times, 3 times, no additional inference latency), W0 + BA with rank r, 1.2 TB to 350 GB VRAM, 350 GB to 35 MB checkpoint with r = 4 on query and value matrices, task switching by swapping matrices.
- Verified in InstructGPT: recipe, 40 contractors, 13k, 33k and 31k prompt counts, 1.3B versus 175B preference, 85 ± 3% preference, 21% versus 41% closed-domain hallucination, about 25% fewer toxic outputs when prompted to be respectful, no significant bias improvement, alignment tax and PPO-ptx, the statement on whose preferences.
- Verified in DPO: description of RLHF, simple classification loss, no sampling during fine-tuning, comparison claims.
- Verified in QLoRA (abstract): the 65B on a single 48 GB GPU claim, frozen 4-bit base with LoRA, NF4, Double Quantization, Paged Optimizers, the Guanaco 99.3% claim, and the statements about GPT-4 evaluation and benchmarks. The paper's experiments were not reviewed.
- Verified in S-LoRA: adapters in main memory, Unified Paging, custom kernels and tensor parallelism, thousands of adapters, up to 4 times the throughput of vLLM with naive LoRA support and up to 30 times that of HuggingFace PEFT (the abstract gives only the 4 times figure; the introduction gives both).
- Verified in the MT-Bench paper: benchmark discrepancy statement, over 80% agreement, bias list.
- Verified in Llama 3: rounds of SFT then DPO, six rounds, rejection sampling with K between 10 and 30, PagedAttention over 2 times throughput, DPO versus PPO statement, learning rate and β, model averaging, data cleaning and pruning list, contamination analysis, violation and false refusal rates, Llama Guard.
- Labelled industry pattern, not sourced: the decision ladder, the release pipeline, shadow and canary rollout, monitoring, governance, cost arithmetic.
- Not claimed: how any specific vendor's fine-tuning product works.
- Corrected (independent review, 2026-10-27): the S-LoRA 4 times throughput figure holds for a small number of adapters; the introduction says so, and the benchmark models and GPUs are now stated.
