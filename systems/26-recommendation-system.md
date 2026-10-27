# 26 — Recommendation System (Two-Stage ML Ranking)

*Real-system parts from the YouTube recommendation paper (2016) and ByteDance's Monolith paper (2022), plus a reference design for the surrounding platform. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A recommender must pick a few dozen items for one user out of millions, in tens of milliseconds, and keep learning from what users do. The standard answer is **two stages**: a cheap **candidate generation** model narrows millions to hundreds using the user's history, then a richer **ranking** model scores those hundreds with many features and sorts them; a final step applies business rules. Around it sit event logging, a feature store, training pipelines and experiments. The hard parts are **freshness** (new items and new behaviour), **feedback loops** (what you show shapes what you learn), and **evaluation** (offline metrics do not always predict live results).

**Key numbers** (as published, with the year)
- YouTube's 2016 models learned about one billion parameters and were trained on hundreds of billions of examples `[CONFIRMED]`.
- Candidate generation winnows "millions" of videos to "hundreds", then ranking scores those hundreds to "dozens" `[CONFIRMED]`.
- Training with sampled negatives (several thousand per example) gave more than a 100 times speedup over a full softmax `[CONFIRMED]`.
- Serving scored millions of items under "a strict serving latency of tens of milliseconds" using approximate nearest-neighbour search `[CONFIRMED]`.
- Monolith synchronised changed sparse parameters from training to serving at a minute-level interval and snapshotted the training servers once a day, accepting up to a day of lost updates on failure `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Two stages: retrieve then rank | Rich features only on hundreds of items, not millions | Recall of the first stage caps the quality of the second |
| Rank by expected watch time, not click | Click-through promotes "clickbait" | Harder objective, needs careful training |
| Feed example age as a feature | Corrects bias toward old, popular items | Extra feature to set correctly at serving time |
| Online training with minute-level sync | Adapts to feedback in real time | More moving parts, lower reliability guarantees |
| Decide with live A/B tests | Offline metrics are not always correlated with live results | Slow, needs traffic and care |

**Common mistakes**
- Using clicks as the only target and getting clickbait.
- Training on all data uniformly, so the model favours what was popular in the past.
- Training/serving skew: features computed differently offline and online.
- Judging a change only by offline metrics.
- Ignoring cold start for new users and new items.

---

## 🧒 Non-technical explanation

Imagine a **bookshop assistant for a shop with millions of books**. First they quickly pull a trolley of a few hundred books that look right from what you bought and asked about before; that has to be fast and roughly right. Then, standing at the trolley, they think harder about each one (your mood, time of day, what you ignored last time) and pick the best few to put on the counter. They also keep learning from what you actually take home, and they make sure the counter is not the same every visit and not only bestsellers.

---

## TL;DR for engineers

- **Stage 1, candidate generation:** a learned user embedding finds nearby item embeddings through approximate nearest-neighbour search `[CONFIRMED]` (YouTube).
- **Stage 2, ranking:** a deep model with hundreds of features scores each candidate, trained to predict expected watch time per impression `[CONFIRMED]`.
- **Freshness:** an "example age" feature corrects the bias toward the past `[CONFIRMED]`.
- **Online learning:** stream logs through a joiner into training and push parameter changes to serving within minutes `[CONFIRMED]` (Monolith).
- **Feature store, re-ranking rules, cold start, experiments, monitoring:** the platform concerns `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** return a ranked list of items for a user and context (home page, next item) · log impressions and actions · retrain and redeploy models · support experiments · filter ineligible items (blocked, already seen, unavailable).

**Non-functional:** **latency** (tens to hundreds of milliseconds end to end) · **scale** (millions of items, many users) · **freshness** of items and behaviour · **quality** (engagement, but also diversity and satisfaction) · **robustness** (a failed component degrades gracefully) · **cost** (GPU training, feature storage).

**Clarifying questions:** what is recommended (videos, products, posts)? Catalogue size and churn? What is the objective (watch time, purchases, retention)? How fresh must the models be? What are the business rules? How many experiments run at once?

---

## 2. The two-stage design `[CONFIRMED]` (Covington, Adams, Sargin, RecSys 2016)

The paper says YouTube "represents one of the largest scale and most sophisticated industrial recommendation systems in existence" and splits the system "according to the classic two-stage information retrieval dichotomy". It names three challenges: **scale**, **freshness** and **noise** (implicit feedback is sparse and the ground truth of satisfaction is rarely observed).

### 2.1 Candidate generation

- **Role:** retrieve a small subset (hundreds) of videos from a large corpus, "generally relevant to the user with high precision", providing "broad personalization via collaborative filtering".
- **Model:** the problem is framed as extreme multiclass classification: predict which video will be watched next among millions, using a user embedding computed by a neural network from the user's history and context, and video embeddings. Inputs include watch history (a variable-length sequence of video IDs, embedded and averaged), search history treated similarly, demographics and geography and device.
- **Training trick:** sampled negative classes, several thousand per example, which the paper says is "more than 100 times speedup over traditional softmax".
- **Serving:** because calibrated probabilities are not needed, the problem reduces to **nearest-neighbour search in the dot-product space**, with "general purpose libraries"; the authors found that A/B results "were not particularly sensitive to the choice of nearest neighbor search algorithm". See [24 Vector / semantic search at scale](24-vector-semantic-search.md).
- **Training labels:** implicit feedback of watches, not likes. The authors predict a future watch rather than a randomly held-out one because they found it performed better in A/B testing, and they exclude information from the user's future that would leak.
- **Freshness, "example age":** machine learning systems have an "implicit bias towards the past", so the age of the training example is fed as a feature during training and set to zero (or slightly negative) at serving time.

### 2.2 Ranking

- **Role:** with only a few hundred candidates, use "many more features describing the video and the user's relationship to the video", and score each impression. Ranking is also crucial for ensembling different candidate sources whose scores are not directly comparable.
- **Model:** a deep network "with similar architecture" scoring each impression with logistic regression, using hundreds of features. The final ranking objective is "generally a simple function of expected watch time per impression" because ranking by click-through rate "often promotes deceptive videos that the user does not complete".
- **Impression features** (how often a video was shown to this user) introduce "churn", so successive requests do not return identical lists. Serving up-to-the-second impression and watch history is called "an engineering feat onto itself".

### 2.3 Evaluation

The paper uses offline metrics (precision, recall, ranking loss) to guide iteration but relies on **live A/B experiments** for the final judgement, because "live A/B results are not always correlated with offline experiments". Live experiments measure click-through rate, watch time and other engagement metrics.

---

## 3. Learning from feedback in real time: Monolith `[CONFIRMED]` (ByteDance, 2022)

Monolith argues that general-purpose deep learning frameworks fall short for recommendation: static parameters and dense computation suit it poorly, and batch training and serving are completely separated, which prevents the model from interacting with customer feedback in real time. The authors' system is described as tailored to **online training**.

- **Collisionless embedding table.** Sparse IDs are mapped to embeddings through a hash table built on **cuckoo hashing** so that distinct IDs do not collide. Feature IDs are filtered before admission (by occurrence count and a probabilistic filter) and set to expire after inactivity, to limit memory. Experiments on MovieLens and an internal dataset showed that models with the collisionless table consistently outperformed ones with collisions.
- **Two training stages.** *Batch training* is a normal pass over historical data (used when the model changes). After deployment, *online training* consumes real-time data and updates the training parameter servers, which periodically synchronise to the serving parameter servers.
- **Streaming engine.** One Kafka queue logs user actions and another logs features; a **Flink** job, the online joiner, joins features with labels from actions to produce training examples into another Kafka queue, consumed directly for online training and dumped to HDFS for batch training. Actions and features arrive without time order, so each request has a unique key; late actions (a purchase days after the impression) are handled with an on-disk key-value store behind an in-memory cache.
- **Negative sampling** would change the output distribution, so a **log-odds correction** is applied at serving time.
- **Parameter synchronisation.** Production models are usually several terabytes in size, so full replacement is infeasible. Sparse parameters dominate model size, and only a small subset of IDs changes in a short window, so Monolith tracks touched keys and pushes only those at a **minute-level** interval; dense parameters change more slowly and sync about daily, at low-traffic times. The paper's example: 100,000 updated IDs per minute at 1,024 dimensions is about 400 MB per minute.
- **Fault tolerance.** The training servers are **snapshotted daily**; a failed server loses up to a day of updates, and the authors found the quality loss tolerable. They conclude that "system reliability could be traded-off for real-time learning".
- **Results.** On the Criteo ads dataset, a shorter sync interval gave better online AUC (5 hours 79.66, 1 hour 79.78, 30 minutes 79.80, against about 79.4 for batch). In a live A/B test on an ads model, online training improved AUC over batch training on each of seven days (the paper's Table 3 lists improvements of about 14% to 18%).

These are the authors' measurements on their data; the system is described for their BytePlus Recommend product.

---

## 3b. Offline, nearline and online computation: Netflix `[CONFIRMED]` (Amatriain and Basilico, March 2013)

A third source, Netflix's TechBlog post "System Architectures for Personalization and Recommendation", gives the cleanest vocabulary for where recommendation work runs. Its three modes of computation:
- **Online:** responds to recent events and the current context (for example assembling a gallery of action movies sorted for the member right now), but is "subject to an availability and response time Service Level Agreements (SLA)", which limits algorithm cost, so "it is always important to think of a fast fallback mechanism such as reverting to a precomputed result". Online components also need their data sources available online.
- **Offline:** batch jobs with relaxed latency, complex algorithms and large data (for example aggregating popularity statistics from millions of play events); easy to deploy and experiment with, since a slower experimental algorithm can simply get more instances. The cost is staleness: it "will not react quickly to changes in context or new data".
- **Nearline:** a compromise: computation is performed as in the online case, but results are stored rather than served immediately, triggered by user events, for example updating recommendations right after a member starts watching a movie. It is also "a natural setting for applying incremental learning algorithms".

The authors stress these are not either/or: "All approaches can and should be combined", for example precomputing part of a result offline and leaving cheaper, context-sensitive parts to online computation; and model training can be split into heavy global training offline and lighter per-user updates online (matrix factorization is their example). The post also separates three kinds of algorithm input: **models** (small files of parameters trained offline), **data** (processed information in a database) and **signals** (fresh information from live services such as what the member watched recently or the device and time), and distinguishes **events** (small time-sensitive units processed with minimal latency) from **data** (dense units where quality matters more than latency). Netflix's near-real-time event flow ran on an internal system it called Manhattan.

This maps onto the platform in section 4: the ranker and retrieval are the online part, the event log and joiner feed nearline updates, and full retraining is offline. It is a 2013 description from one company; the post is not about today's system.

## 4. The platform around the models `[INDUSTRY PATTERN]`

```
user ─► recommendation API ─► candidate generation ─► ranking ─► re-ranking rules ─► list
              │                  (ANN + other sources)   ▲             (diversity, filters)
              │                           ▲              │
              │                    feature store (online) ◄── streaming features
              └─► impressions + actions ─► event log ─► joiner ─► training ─► model store ─► serving
```

- **Multiple candidate sources:** the embedding retrieval above, plus popular, trending, followed accounts, recently watched, items similar to the last one. The YouTube paper says the two-stage design also "enables blending candidates generated by other sources".
- **Feature store:** the same feature definitions used offline for training and online for serving, to avoid training/serving skew; point-in-time correctness for training features.
- **Re-ranking and policy:** remove ineligible or already-seen items, enforce diversity, boost freshness, add exploration, apply business and safety rules.
- **Cold start:** new items have no behaviour; use content features, creator signals and deliberate exploration. New users have no history; use context, popularity and quick onboarding signals. The YouTube paper frames balancing new and well-established content "from an exploration/exploitation perspective" `[CONFIRMED]`; the tactics are ours.
- **Feedback loops:** what is shown determines what is learned, which can narrow recommendations and favour already-popular items. Counter with exploration, diversity constraints and holdout traffic that is not personalised `[INDUSTRY PATTERN]`.
- **Latency budget:** split the time between retrieval, feature fetch, ranking and re-ranking; cache user embeddings or candidate lists where staleness is acceptable; set timeouts and fall back to a popular list if a stage fails.
- **Experimentation:** A/B platform with guardrail metrics (retention, complaints, latency) beyond the engagement metric being optimised.
- **Monitoring:** feature drift, model score distributions, empty-candidate rates, latency per stage.

---

## 5. Failure scenarios

- **A candidate source or the ANN service is down.** Fall back to other sources or a popular list rather than an empty page `[INDUSTRY PATTERN]`.
- **A training or parameter server fails.** Recover from the latest snapshot; Monolith accepts losing up to a day of updates `[CONFIRMED]`.
- **Delayed labels.** A conversion arrives days after the impression; the joiner must look up old features in a disk store `[CONFIRMED]` (Monolith).
- **Training/serving skew.** Silent quality loss; detect by comparing logged serving features with training features `[INDUSTRY PATTERN]`.
- **Feedback loop narrows the feed.** Add exploration and diversity, and measure long-term retention `[INDUSTRY PATTERN]`.
- **Model update degrades quality.** Test in a live experiment before ramping and keep the old model for rollback `[INDUSTRY PATTERN]`.

---

## 6. Capacity reasoning (illustrative)

- **Funnel:** millions of items to hundreds of candidates to dozens shown, as in the YouTube figure. If ranking takes 1 ms per 100 candidates on one machine (our assumption), 10,000 requests per second needs enough machines to hold that rate with headroom.
- **Embedding table size** = distinct IDs × dimension × bytes. 1 billion IDs at 64 dimensions in 4-byte floats is about 256 GB, which explains why Monolith filters and expires IDs. Numbers are our assumptions.
- **Event volume** = requests per second × items shown per request. Logging every impression is large; sample non-critical fields.

---

## ⚠️ Reviewer notes

1. **The YouTube paper is from 2016.** The architecture has surely evolved; it remains the best-documented two-stage example. We do not claim it describes YouTube today.
2. **Monolith's AUC figures** come from a public dataset simulation and one live ads A/B test; Table 3 reports large relative improvements, and the paper does not define the percentage precisely in the text we read. Treat it as indicative.
3. **Netflix's description is from 2013, and TikTok's and Spotify's production recommenders are not described here;** we cite only the papers and post we read.
4. **Cold start, feedback loops, re-ranking and the feature store are industry practice,** not sourced claims.
5. **Not read:** Netflix's later recommendation engineering posts, two-tower retrieval papers, multi-task ranking papers, bandit/exploration literature, and feature store product documentation.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **performance** (latency), **scalability**, **freshness/data currency**, **experimentability**, **availability** (degrade, do not fail).
- **Style (Ch 13):** a **pipeline** for serving (retrieve, rank, re-rank) on top of an **event-driven** learning loop.
- **Quanta (Ch 7):** serving, streaming features and training are separate quanta, joined by the model store and the event log.
- **Trade-off (First Law, Ch 1):** **freshness vs reliability and cost.** Minute-level learning adapts faster and adds failure modes.
- **ADR sketch (Ch 19):** *"We will retrieve candidates by embedding nearest neighbours, rank them with a feature-rich model, and learn online from a streaming join. We accept reduced durability of model state in exchange for fresher recommendations."*
- Plain English: a quick shortlist, a careful pick, and a notebook updated every few minutes.

---

## Interview questions to practice

1. Design a recommendation system for a video app. Why two stages?
2. What would you optimise: clicks or watch time? Why?
3. How do you retrieve candidates from millions of items in tens of milliseconds?
4. How do you recommend new videos that have no history? And new users?
5. How do you keep the model fresh?
6. What is training/serving skew and how do you avoid it?
7. How do you evaluate changes? What if offline and online disagree?
8. What feedback loops can arise, and what would you do about them?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: item type, catalogue size, objective, latency target, freshness needs.
2. Estimate: users and requests per second, candidates per stage, embedding and feature storage, event volume.
3. API: get recommendations for a user and context; log events.
4. Design: candidate generation (embeddings plus other sources), ranker, re-ranker, feature store, event log, training and model store.
5. Deep dive: training objective, the example-age or freshness fix, cold start, exploration.
6. Failure and scale: stage failure fallbacks, delayed labels, skew, feedback loops, experiments.

**If it grows 10×**
- Retrieval: shard the ANN index and add sources; keep candidate counts bounded.
- Features: cache hot features, precompute heavy ones, keep point-in-time correctness.
- Training: more data per day pushes toward incremental/online training with the reliability trade-off.

**Answer outlines** (try the questions above first)

<details><summary>Why two stages?</summary>

Scoring millions of items with a rich model is too slow. A cheap model with few features narrows to hundreds with high recall; a richer model with many features ranks only those. The cost is that the first stage's recall caps the final quality, so you measure it separately.

</details>

<details><summary>How do you handle cold start?</summary>

For new items, rely on content features and creator history and give them guaranteed exploration impressions; for new users, start from context and popularity and learn quickly from the first interactions. Measure both groups separately because average metrics hide them.

</details>

<details><summary>Offline metrics improved but the A/B test did not. What now?</summary>

Trust the live test, then investigate the gap: training/serving skew, a mismatch between the offline label and the product goal, position bias in logged data, or interference with other changes. Fix the offline metric so it predicts the live one, rather than ignoring the disagreement.

</details>

## 📚 Further reading

- The two papers listed under Sources and provenance.
- Related notes in this repo: [11 News feed](11-news-feed.md), [12 YouTube](12-youtube.md), [13 Netflix](13-netflix.md), [14 Spotify](14-spotify.md), [24 Vector / semantic search at scale](24-vector-semantic-search.md).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).

## Sources and provenance

> **Kind:** real system (YouTube 2016, ByteDance Monolith 2022) with a reference design for the surrounding platform `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (PDF text extracted locally):** Covington, Adams and Sargin, [*Deep Neural Networks for YouTube Recommendations*](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45530.pdf) (RecSys 2016) · Liu et al., [*Monolith: Real Time Recommendation System With Collisionless Embedding Table*](https://arxiv.org/pdf/2209.07663) (ByteDance, ORSUM at RecSys 2022) · Amatriain and Basilico, [*System Architectures for Personalization and Recommendation*](https://netflixtechblog.com/system-architectures-for-personalization-and-recommendation-e081aa94b5d8) (Netflix TechBlog, 27 March 2013; read through an Internet Archive copy).
> **Dated material:** 2016 and 2022 papers.
> **Not read:** later Netflix recommendation posts, two-tower and multi-task ranking papers, bandit literature, feature store documentation.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the YouTube paper: two-stage structure, scale figures (one billion parameters, hundreds of billions of examples), millions to hundreds to dozens funnel, extreme multiclass formulation, sampled negatives and the 100 times speedup, nearest-neighbour serving and insensitivity to the algorithm, example-age feature, ranking with logistic regression and expected watch time, click-through critique, impression features for churn, offline versus A/B statement, the exploration/exploitation remark.
- Verified in the Monolith paper: abstract claims, cuckoo hashmap, ID filtering and expiry, batch and online stages, Kafka and Flink streaming engine and online joiner, log-odds correction, minute-level sparse sync and daily dense sync, the 400 MB per minute example, daily snapshots, Criteo AUC table, Table 3 improvements, the reliability-for-realtime conclusion.
- Verified in the Netflix post: the online, offline and nearline definitions and their trade-offs, the fallback-to-precomputed advice, hybrid combination and hybrid modelling examples, models/data/signals and events/data distinctions, the Manhattan event flow.
- Labelled industry pattern, not sourced: multiple candidate sources beyond the papers, feature store, re-ranking policy, cold-start tactics, feedback-loop mitigations, latency budget, experiment guardrails, capacity arithmetic.
- Not claimed: how any current production recommender (YouTube, TikTok, Netflix, Spotify) works today.
