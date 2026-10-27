# W02 — Find the flaw: design review drills

*Nine short designs, each with planted problems. The skill is the one a design review needs: spot the failure before it happens.*

## How to use this page

Each scenario describes a design that sounds reasonable and contains one or more flaws. **Read the scenario, write down every problem you can find, then open the answer.** Score yourself on how many you found and whether you proposed a fix. The answer keys rely on facts sourced in the linked notes; the framing and fixes are our reasoning.

## 1. The per-server rate limiter

**Design.** A public API runs on 10 identical servers behind a round-robin load balancer. Each server keeps an in-memory token bucket per API key, set to 100 requests per minute. To fix drift between servers the team later adds a shared counter store that every request consults; when that store is unavailable the servers refuse all requests, to be safe.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- Each server counts separately, so a client whose requests are spread evenly can make up to about 1,000 requests a minute (10 servers times 100), ten times the intended limit.
- The limit changes when servers are added or removed, so it is not stable.
- Refusing all traffic when a dependency fails (fail-closed) turns a cache outage into a total API outage; for a rate limiter, failing open (and alerting) is the usual choice because the limiter is a protection, not a core function.

**Fix.** Share the counters (for example atomic increments in a shared store) or route each key to one server, accept small approximation, and decide the failure mode deliberately (in the original design the per-server counters are the flaw; once a shared store is added, its failure mode becomes the next question). See [02 Rate limiter](../systems/02-rate-limiter.md).

</details>

## 2. The payment retry

**Design.** A checkout service calls the payment provider to charge a card, then inserts the order row, then publishes an `OrderPaid` event to a queue. If the charge call times out, the service calls it again.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- Retrying a charge without an idempotency key can charge the customer twice, because the first attempt may have succeeded before the timeout.
- Charge, database write and event publish are three separate steps with no atomic link: a crash between them leaves a charge with no order, or an order with no event.
- Nothing records the intent before the charge, so reconciliation has no starting point.

**Fix.** Send a client-generated idempotency key with every charge ([P05](P05-api-design.md)), record the payment intent first, write the order and an outbox event in one local transaction, and use idempotent consumers ([P03](P03-distributed-transactions.md)). See [17 Payment system](../systems/17-payment-system.md).

</details>

## 3. The cache-aside race

**Design.** Reads: on a cache miss read the database and then set the cache. Writes: update the database, then delete the cache entry. TTL is 24 hours.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- A reader can miss the cache, read the old value from the database, and then be slowed; a writer then updates the database and deletes the cache; the reader finally sets the old value into the cache. The cache now holds stale data until the 24-hour TTL expires.
- Long TTLs turn a rare race into a day-long inconsistency.

**Fix.** Shorten TTLs, store a version with each value and refuse to overwrite with an older one, or use leases or tokens on cache fills so a delete invalidates a slow reader's later set (the approach in [32 Distributed cache](../systems/32-distributed-cache.md)). Write-through caches have their own ordering races, so they are not a complete fix. State what staleness the product can tolerate. This is general practice, not tied to one source `[INDUSTRY PATTERN]`.

</details>

## 4. Permissions in the prompt

**Design.** A knowledge assistant retrieves the top 20 chunks from one shared index and tells the model: 'Only use documents the current user is allowed to read.'

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- Access control is delegated to the model. Retrieved text from restricted documents is already in the prompt, so it can leak through an answer, a citation or a prompt injection.
- The permission list is not an input to retrieval, so the 20 chunks may be mostly irrelevant to what the user may see.

**Fix.** Resolve the user's permissions before retrieval and filter inside the retrieval query; keep permissions in the chunk store and propagate revocations quickly. See [23 RAG knowledge assistant](../systems/23-rag-knowledge-assistant.md) and [P06 Security](P06-security-threat-modeling.md).

</details>

## 5. Monitoring that depends on what it monitors

**Design.** The team's alerts are evaluated by the same cluster that serves the product, using metrics stored in the product's database. The status page is hosted in the same region and administered through the product's own login.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- If the product or its region fails, the alerts and the status page can fail with it, exactly when they are needed.
- Incident histories show this pattern: AWS's 2017 S3 status dashboard console depended on S3, and its 2020 Kinesis event affected the tool used to post status because it used Cognito ([C01](C01-aws-s3-2017.md), [C06](C06-aws-kinesis-2020.md)). Monarch's paper makes low dependency on the alerting path a design principle ([30 Monitoring](../systems/30-metrics-monitoring-alerting.md)).

**Fix.** Run monitoring and the status page on independent infrastructure with minimal dependencies, add a dead man's switch alert, and test the manual fallback.

</details>

## 6. Fast rules, no staging

**Design.** A security team can push detection rules to every edge location in seconds. The change process says rule changes may go global directly. Tests check that rules block bad requests and allow good ones. Rollback means rebuilding and redeploying the full ruleset.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- No test measures resource use, so a rule that burns CPU passes. Cloudflare's 2019 outage came from a regex that backtracked heavily, which their tests did not catch ([C02](C02-cloudflare-2019.md)).
- Skipping staged rollout for 'fast' changes removes the canary that catches such mistakes.
- A slow rollback extends the outage; a kill switch to disable the component quickly was what ended the incident.

**Fix.** Add performance profiling to the tests, stage even fast changes (a short canary can be seconds, not days), keep a one-step global disable, and make rollback faster than the push.

</details>

## 7. Failover across regions

**Design.** Orchestration software promotes a replica to primary automatically when the primary is unreachable for 30 seconds, including replicas in another region. Applications are configured with the primary's address from the same orchestrator.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- A brief network partition can cause promotion in the remote region while the old primary still holds unreplicated writes; when connectivity returns both sides hold writes the other lacks.
- Applications in the old region may not tolerate cross-region latency to the new primary, so the site becomes slow or unusable.
- GitHub's 2018 incident followed this shape: a 43-second partition, failover to another region, writes on both sides, and 24 hours of degraded service ([C03](C03-github-2018.md)).

**Fix.** Constrain automated promotion to regions the applications can use, define reconciliation for unreplicated writes (or accept loss explicitly), measure restore times, and test the partition case.

</details>

## 8. Counting clicks

**Design.** An analytics service counts an ad click when it arrives, groups counts by arrival minute, and removes duplicates using a set of click IDs held in each worker's memory. Workers restart often.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- Counting by arrival time puts late or retried clicks in the wrong minute; windows should use event time with a watermark and a lateness policy.
- In-memory dedup is lost on restart and not shared between workers, so duplicates are counted again.
- Nothing reconciles the fast counts with the raw log before billing.

**Fix.** Assign unique click IDs, deduplicate in a replicated store, window by event time, checkpoint state with source offsets, and reconcile against the raw log. See [31 Ad click aggregation](../systems/31-ad-click-aggregation.md).

</details>

## 9. Sizing a KV cache

**Design.** A team sizes GPU memory for serving a 70-billion-parameter model with 80 layers and hidden size 8192 using the formula from a paper on a 13B model: 2 x hidden size x layers x 2 bytes per token. They conclude each token needs about 2.6 MB of cache and plan far fewer concurrent requests than the hardware can hold.

<details><summary>What is wrong, and what would you change?</summary>

**Flaws**
- That formula assumes every attention head has its own key and value (multi-head attention). Llama 3 70B uses grouped-query attention with 8 key-value heads and 64 attention heads, so head dimension is 8192 / 64 = 128.
- Per-token cache is 2 x 80 layers x 8 KV heads x 128 x 2 bytes = 327,680 bytes, about 330 KB, eight times smaller than the multi-head figure (2 x 80 x 8192 x 2 = 2,621,440 bytes, about 2.6 MB). The team's plan under-uses the GPUs.

**Fix.** Ask which attention variant the model uses before sizing. See [22 LLM inference serving](../systems/22-llm-inference-serving.md); the model parameters are in the Llama 3 report (Table 3), and the per-token arithmetic is ours.

</details>

## After the drills

Make your own: take any atlas system, change one design decision to a plausible but worse one, and ask a partner to find it. The best flaws are ones that appear in real incident reports (see the [casebook](README.md)).

**Related:** [W01 Mock interview protocol](W01-mock-interview-protocol.md), the casebook [C01 to C06](README.md), [P03](P03-distributed-transactions.md), [P05](P05-api-design.md), [P06](P06-security-threat-modeling.md).

## Sources and provenance

> **Kind:** practice material. The exercises, answer keys and rubrics are **our reasoning** `[INDUSTRY PATTERN]`. Where a fact is sourced it is linked to the atlas note or primer that cites the primary source.
> **Sources:** Exercises and rubrics are our own. Facts they rely on are sourced in the linked atlas notes and primers; each exercise links its evidence.
> **Not read:** Published interview-rubric research and company-specific hiring rubrics.

---
## ✅ Verification log

*Checked 2026-10-27.*
- Scenario 9 arithmetic re-derived: 8192 / 64 = 128; 2 x 80 x 8 x 128 x 2 = 327,680; 2 x 80 x 8192 x 2 = 2,621,440; ratio 8. Llama 3 70B parameters (80 layers, dimension 8192, 64 attention heads, 8 key-value heads) are from Table 3 of the Llama 3 report, read in note 22's sources.
- Incident references (scenarios 5, 6 and 7) match the casebook pages C01, C02, C03 and C06.
- Scenarios 1 to 4 and 8 rest on facts in notes 02, 17, 23 and 31 and on general practice marked as such.
