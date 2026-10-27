# 23 — RAG Knowledge Assistant (Enterprise Q&A)

*A reference design built on a published method (RAG) and a published retrieval technique (Contextual Retrieval). How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A language model does not know your company's documents. Retrieval-augmented generation (RAG) fixes that at question time: find the passages most relevant to the question, put them in the prompt, and ask the model to answer from them with citations. The system has two halves. **Ingestion** cuts documents into chunks, optionally adds context to each chunk, and builds a vector index and a keyword index. **Query** filters by what the user may see, retrieves with both indexes, reranks, and generates. Most quality problems are retrieval problems, so evaluation of retrieval is as important as evaluation of answers.

**Key numbers** (as published, in the authors' tests)
- A knowledge base under 200,000 tokens (about 500 pages) can go straight into the prompt, with no RAG needed `[CONFIRMED]` (Anthropic, 2024).
- Adding generated context to each chunk cut top-20 retrieval failures by 35% (embeddings) and 49% (with keyword search); adding a reranker reached 67% (5.7% → 1.9%) `[CONFIRMED]` (Anthropic's own datasets).
- In the original RAG paper the knowledge source was 21 million 100-word Wikipedia chunks behind an approximate nearest-neighbour index `[CONFIRMED]`.
- Replacing the index updates the model's knowledge without retraining: 70% correct with a matching 2016 index, 68% with a matching 2018 index, 12% and 4% when mismatched `[CONFIRMED]` (RAG paper).

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Hybrid retrieval (vectors + keyword) | Embeddings find meaning; keyword search finds exact identifiers | Two indexes to build and keep in sync |
| Add context to each chunk before indexing | Chunks lose their surroundings when split | An extra model call per chunk at ingestion |
| Rerank a wide candidate list | Better top results, fewer tokens in the prompt | Added latency and cost per question |
| Filter by permissions at retrieval time | A user must never see text they cannot open | Permissions must be stored with chunks and kept fresh |
| Answer with citations | Users can verify; you can measure grounding | More prompt and output tokens |

**Common mistakes**
- Judging the system by answer quality alone. If the right chunk was never retrieved, no prompt can fix it, so measure retrieval separately.
- Checking permissions only at the UI. Retrieval must filter, or the model may quote a document the user cannot read.
- Re-embedding everything on every change, or never refreshing. Plan incremental updates and deletions.
- Skipping a baseline. For a small corpus, the whole-corpus-in-the-prompt approach may beat a RAG pipeline.

---

## 🧒 Non-technical explanation

Imagine a **new employee with a great memory for general knowledge but who has never seen your company's files**. When asked a question, they do not guess: a librarian first pulls the few most relevant pages from the filing cabinet, the employee reads them, and answers while pointing at the page. The librarian must be good at two skills: finding pages by meaning ("how do I get a refund?") and by exact words ("error TS-999"). The librarian must also only fetch from drawers this particular asker is allowed to open.

---

## TL;DR for engineers

- **RAG** combines a generator (parametric memory) with a searchable index (non-parametric memory) `[CONFIRMED]` (Lewis et al., 2020).
- **Knowledge updates by replacing the index,** not by retraining `[CONFIRMED]`.
- **Chunks lose context.** Prepending a short generated explanation before embedding and keyword indexing reduced failed retrievals `[CONFIRMED]` (Anthropic).
- **Hybrid search plus reranking** beat embeddings alone in Anthropic's tests `[CONFIRMED]`.
- **Permissions, freshness, citations, evaluation and cost control** are the production concerns `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** ask questions in natural language over company documents (wiki, tickets, files) · answers cite their sources · results respect each user's permissions · new and changed documents appear quickly · deleted documents disappear.

**Non-functional:** **answer quality** (grounded, correct, says "I don't know") · **latency** (seconds, streaming) · **freshness** (minutes to hours) · **security** (no leakage across users) · **cost** (tokens, embeddings, reranking) · **auditability**.

**Clarifying questions:** corpus size and types? Update rate? Who may see what, and where is that defined? Languages? Expected question types (lookup, multi-document, numeric)? Latency and cost budget? Is a wrong answer costly (legal, medical)?

---

## 2. The method: retrieval-augmented generation `[CONFIRMED]`

The RAG paper (Lewis et al., arXiv 2005.11401) describes models "which combine pre-trained parametric and non-parametric memory for language generation". The parametric memory is a pre-trained seq2seq model (BART-large, 400 million parameters). The non-parametric memory is "a dense vector index of Wikipedia", accessed with a pre-trained neural retriever.

**Retriever.** A bi-encoder (two BERT-base encoders, one for documents and one for queries) scores document and query vectors. Finding the top-k documents is a Maximum Inner Product Search problem, which "can be approximately solved in sub-linear time". The authors used FAISS with a Hierarchical Navigable Small World index. Vector indexes are covered in [24 Vector / semantic search at scale](24-vector-semantic-search.md).

**Corpus setup.** The December 2018 Wikipedia dump was split into "disjoint 100-word chunks, to make a total of 21M documents". During training they retrieved the top k documents, with k in 5 or 10.

**Why it matters.** The paper observes that purely parametric models "may produce hallucinations" and that their knowledge is hard to update. In its tests, "RAG models hallucinate less and generate factually correct text more often than BART". In a human evaluation of Jeopardy question generation, evaluators judged RAG more factual in 42.7% of pairs versus 7.1% for BART.

**Updating knowledge.** With an index from December 2016, RAG answered 70% of questions about 2016 world leaders correctly; with the 2018 index and 2018 leaders it was 68%. With mismatched indexes accuracy fell to 12% and 4%. The authors conclude "we can update RAG's world knowledge by simply replacing its non-parametric memory."

---

## 3. Better retrieval: Contextual Retrieval `[CONFIRMED]` (Anthropic, September 2024)

**The problem.** Traditional RAG splits documents into chunks "usually no more than a few hundred tokens", and a chunk can lose its meaning. Anthropic's example: a chunk saying the company's revenue grew by 3% does not say which company or period.

**Hybrid search.** Embeddings "can miss crucial exact matches". BM25 is a ranking function that uses lexical matching, "particularly effective for queries that include unique identifiers or technical terms". The post's example is a query for an error code that embeddings might miss. Combining both gives more complete results.

**The technique.** Contextual Retrieval prepends chunk-specific explanatory text to each chunk before embedding and before building the BM25 index. A model is prompted with the whole document and the chunk to produce the context, which is "usually 50-100 tokens". With prompt caching, the post estimates "$1.02 per million document tokens" as a one-time cost under stated assumptions (800-token chunks, 8,000-token documents).

**Results.** Measured as the share of relevant documents not found in the top 20 chunks, averaged over their datasets (codebases, fiction, ArXiv papers and science papers) with a Gemini embedding model:
- Contextual embeddings: failures down 35%.
- Plus contextual BM25: down 49%.
- Plus a reranker (top 150 candidates reduced to the top 20): down 67%, from 5.7% to 1.9%.

Passing 20 chunks to the model beat 10 or 5. Generic document summaries added to chunks gave "very limited gains". The post advises "always run evals".

**Limits of this evidence.** It is one vendor's tests on its own datasets and one reranker. Treat the percentages as indicative, not as expected results on your data.

---

## 4. The reference design `[INDUSTRY PATTERN]`

```
Sources ─► sync ─► chunk ─► (add context) ─► embed ─► vector index
 (docs, wiki, tickets)            │                 └► keyword index
                                  └► chunk store (text, source, permissions)

user ─► permission scope ─► hybrid retrieve ─► rerank ─► build prompt ─► LLM ─► answer + citations
                                                                          └► log for evaluation
```

**Ingestion**
- **Sync and change detection:** connectors per source, incremental updates, deletions, and permission changes. A document that is deleted or made private must leave the index promptly.
- **Parsing and chunking:** extract text from PDFs, tables and slides; chunk by structure (headings, paragraphs) with some overlap. Chunking choices "can affect retrieval performance", as the Anthropic post says.
- **Context, embeddings, indexes:** as in section 3. Store the chunk text, the source link, a version and the access list alongside the vectors.

**Query**
- **Identity first:** resolve who the user is and which documents they may read, and apply that as a filter in the retrieval query. Never retrieve then filter in the prompt.
- **Hybrid retrieval and reranking:** as in section 3. Cap how many chunks reach the prompt.
- **Context placement:** more retrieved text is not always better. Liu et al. (*Lost in the Middle*, 2023) tested multi-document question answering and key-value retrieval and found that performance "can degrade significantly when changing the position of relevant information": it is often highest when the relevant information is at the beginning or end of the input and degrades when models must use information in the middle, even for explicitly long-context models `[CONFIRMED]`. Design consequences (ours): rerank so the best chunks sit first, keep the number of chunks bounded, and test your own model rather than assuming long context is used evenly. This agrees with Anthropic's finding that passing 20 chunks beat 10 or 5 in their tests, which shows the optimum is task- and model-specific.
- **Generation:** instruct the model to answer only from the supplied passages, cite them, and say when they are insufficient. See [22 LLM inference serving](22-llm-inference-serving.md) for serving the model.
- **Streaming and fallbacks:** stream the answer; if retrieval returns nothing relevant, answer that, rather than guess.

**Evaluation and operations**
- **Retrieval metrics:** recall of the known relevant chunk in the top-k, on a labelled question set. This is what the Anthropic post measured.
- **Answer metrics:** groundedness (does each claim appear in a cited chunk), correctness against reference answers, refusal quality. Use human review on samples and model-based grading with care, since graders have their own errors.
- **Monitoring:** log question, retrieved chunks, answer and feedback (with privacy controls); watch no-answer rate, citation click-through and latency.
- **Cost control:** cache embeddings and frequent answers where permissions allow, cap context size, rerank fewer candidates, use a small model for easy questions.
- **Security:** prompt injection through documents is a real risk, since retrieved text enters the prompt. Treat retrieved content as data, limit what the model can do with it, and keep the permission filter outside the model.

---

## 5. Failure scenarios

- **Stale or deleted content.** If sync lags, users get answers from removed documents. Use deletion events, a bounded refresh interval, and show the document's last-updated time `[INDUSTRY PATTERN]`.
- **Permission change.** A revoked permission must propagate to the chunk store before the next query; otherwise the answer leaks content `[INDUSTRY PATTERN]`.
- **Exact identifier missed.** Embeddings alone can miss a ticket number or error code; the keyword index rescues it `[CONFIRMED]` (Anthropic's example).
- **Right chunk not retrieved.** The model cannot answer or answers wrongly; fix chunking, add context, widen the candidate list and rerank `[CONFIRMED]` as a direction, with numbers specific to the Anthropic tests.
- **Hallucinated answer.** Require citations and check that cited chunks support the claim `[INDUSTRY PATTERN]`.

---

## 6. Capacity reasoning (illustrative)

- Chunks ≈ corpus tokens ÷ chunk size. With 50 million tokens and 500-token chunks that is 100,000 chunks. Both numbers are our assumptions.
- Contextualisation cost scales with document tokens. Anthropic's estimate of $1.02 per million document tokens assumed their model, prices and chunk sizes at the time; recompute for yours.
- Prompt size ≈ retrieved chunks × chunk size. Twenty 500-token chunks is about 10,000 tokens per question before the answer.
- Index size for vectors ≈ chunks × dimensions × bytes per number, before index overhead. 100,000 chunks × 1,024 dimensions × 4 bytes is about 400 MB. Dimensions are model-dependent; this is illustrative.

---

## ⚠️ Reviewer notes

1. **The retrieval gains come from one vendor's experiments** (their datasets, one reranker, a Gemini embedding model). They are not general results.
2. **The RAG paper's system trains the retriever and generator together** (fine-tuning the query encoder and generator). Most enterprise "RAG" does not; it assembles a prompt at query time. The shared idea is the retrieval step, not the training recipe.
3. **The 200,000-token threshold** is from the Anthropic post and tied to that model's context window then; it moves as context windows grow.
4. **Access control, sync, evaluation and prompt-injection guidance are industry practice,** not sourced claims.
5. **Not read:** other chunking studies, reranker papers (long-context position effects are covered from the *Lost in the Middle* abstract only), graph-based or agentic retrieval, ColBERT-style multi-vector retrieval, and vendor vector database documentation.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **security** (permission-correct answers), **accuracy**, **freshness**, **performance** (latency), **cost**.
- **Style (Ch 13):** two **pipelines**: a batch/stream ingestion pipeline and an online query service sharing the indexes.
- **Quanta (Ch 7):** ingestion and query scale independently; the indexes and chunk store are the shared coupling point.
- **Trade-off (First Law, Ch 1):** **quality vs latency and cost.** Wider candidate lists, contextualisation and reranking improve retrieval and add cost and delay.
- **ADR sketch (Ch 19):** *"We will retrieve with vector and keyword indexes, filter by permission inside the retrieval query, and rerank before generation. We accept a more complex ingestion pipeline in exchange for exact-match recall and for never exposing unauthorised text."*
- Plain English: a good librarian who checks your library card first.

---

## Interview questions to practice

1. Design a question-answering assistant over a company's internal documents.
2. Why not fine-tune the model on the documents instead?
3. How do you chunk documents, and what goes wrong with bad chunking?
4. Why combine keyword and vector search? What does reranking add?
5. How do you make sure users only see answers from documents they may read?
6. How do you keep the index fresh, including deletions?
7. How do you evaluate the system? Separate retrieval from generation.
8. What can go wrong when documents contain instructions (prompt injection)?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: corpus size, sources, update rate, permission model, accuracy needs.
2. Estimate: chunks, index size, questions per second, tokens per question.
3. API: ask endpoint with user identity, streaming answer, citations, feedback endpoint.
4. Design: connectors and sync, chunker, embedder, vector and keyword indexes with permissions, query service, reranker, LLM.
5. Deep dive: hybrid retrieval and reranking; permission filtering; evaluation.
6. Failure and scale: stale or deleted documents, permission changes, missed retrievals, prompt injection, cost.

**If it grows 10×**
- Index size and latency: shard the indexes (see [24 Vector / semantic search at scale](24-vector-semantic-search.md)) and filter early.
- Ingestion throughput: parallelise parsing and embedding, process changes incrementally.
- Cost: cache, rerank fewer candidates, route easy questions to a smaller model.

**Answer outlines** (try the questions above first)

<details><summary>Why not fine-tune the model on the documents?</summary>

Facts in weights are hard to update, cannot be cited, and cannot honour per-user permissions. Retrieval lets you replace the index to update knowledge, cite sources, and filter by who is asking. Fine-tuning can still help with style or domain vocabulary.

</details>

<details><summary>How do you enforce permissions?</summary>

Store each chunk's access list with it, resolve the user's groups at query time, and filter inside the retrieval query before ranking. Propagate permission changes quickly, and test with users who must not see a document.

</details>

<details><summary>How do you evaluate it?</summary>

Build a labelled question set. Measure retrieval recall in the top k first, then groundedness and correctness of answers, then refusal behaviour. Track the same set over time so every change to chunking, models or prompts is compared before release.

</details>

## 📚 Further reading

- The two sources listed under Sources and provenance.
- [`neokim-post/01` How LLMs work](../../neokim-post/01-how-llms-work.md) for embeddings and retrieval basics.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [20 Web crawler and search](20-web-crawler-search.md), [22 LLM inference serving](22-llm-inference-serving.md), [24 Vector / semantic search at scale](24-vector-semantic-search.md), [25 AI agent platform](25-ai-agent-platform.md) and [28 LLM fine-tuning, evaluation and deployment](28-llm-finetuning-evaluation.md).

## Sources and provenance

> **Kind:** reference design. RAG (the method) and Contextual Retrieval (a technique and its measurements) are published. How any particular company builds its internal assistant is not, so the platform in section 4 is the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Lewis et al., [*Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*](https://arxiv.org/pdf/2005.11401) (arXiv 2005.11401, 2020; PDF text extracted locally) · Anthropic, [*Introducing Contextual Retrieval*](https://www.anthropic.com/news/contextual-retrieval) (19 September 2024; read through an Internet Archive copy) · Liu et al., [*Lost in the Middle: How Language Models Use Long Contexts*](https://arxiv.org/pdf/2307.03172) (2023; abstract and introduction).
> **Dated material:** the RAG paper is from 2020 and the Anthropic post from 2024. Models, context windows and prices have changed since.
> **Not read:** the Anthropic cookbook, other chunking and reranking papers, vendor documentation for vector databases or enterprise search products.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading both sources in full. Quotations are confirmed by `npm run verify`.*
- Verified in the RAG paper: the parametric and non-parametric memory definition, BART-large with 400M parameters, DPR bi-encoder with BERT-base encoders, MIPS in sub-linear time, FAISS with HNSW, December 2018 dump in 100-word chunks giving 21M documents, k in 5 or 10 for training, hallucination statement, Jeopardy factuality percentages (42.7% and 7.1%), index hot-swapping results (70%, 68%, 12%, 4%).
- Verified in the Anthropic post: 200,000-token threshold, chunk size wording, BM25 description and error-code example, context length of 50–100 tokens, $1.02 per million document tokens and its assumptions, the 35%, 49% and 67% figures with 5.7% to 1.9%, top-150 to top-20 reranking, 20 chunks versus 10 or 5, the limited gains from generic summaries, "always run evals", datasets used.
- Verified in the Lost in the Middle abstract: the two tasks, the position effect (best at beginning or end, worse in the middle, even for long-context models). The models and quantitative results in the paper were not reviewed.
- Labelled industry pattern, not sourced: ingestion and sync design, permission filtering, evaluation metrics and monitoring, cost control, prompt-injection advice, capacity figures.
- Not claimed: results on any dataset other than those in the cited sources.
