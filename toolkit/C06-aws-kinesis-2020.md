# C06 — AWS Kinesis outage, 25 November 2020 (thread limits and cascading dependencies)

*A real incident, told from the operator's own published account. The lessons section is our analysis and is labelled as such. Sources and what was not checked are at the end.*

## At a glance

**What happened.** Adding capacity to the Kinesis front-end fleet pushed every server over an operating-system thread limit, because each server keeps a thread per other server. Shard maps could not be built, a slow full restart followed, and services that depended on Kinesis (Cognito, CloudWatch, Lambda, EventBridge, ECS, EKS) failed in turn.

**Key facts** (as published)
- Capacity added from 2:44 to 3:47 AM PST; alarms from 5:15 AM; root cause confirmed at 9:39 AM; Kinesis fully normal at 10:23 PM PST `[CONFIRMED]`.
- Front-end servers could be added only at a few hundred per hour during recovery `[CONFIRMED]`.
- The status dashboard could not be updated normally because the tool used Cognito `[CONFIRMED]`.

**Why it matters for architects.** A scaling operation exposed a hidden quadratic resource (threads grow with fleet size), the recovery was slow by design, and the blast radius spread through hidden dependencies.

---

## What happened `[CONFIRMED]`

The trigger, but not the root cause, was a relatively small addition of capacity to the front-end fleet, which authenticates, throttles and routes requests to back-end shard clusters. Each front-end server caches a shard-map built from a membership service, DynamoDB and messages from other front-end servers; for the last, each server creates operating system threads for every other server. After the addition, the fleet exceeded the maximum number of threads allowed by an operating system configuration, so cache construction failed and servers ended up with useless shard-maps. Diagnosis was slowed by the variety of errors, and the team first suspected memory pressure. Restart was slow because the resources used to populate the shard-map compete with those used for serving requests, so bringing servers back too fast would starve request handling and make them look unhealthy. Dependent services failed in different ways: Cognito blocked on backlogged Kinesis buffers because of a latent bug, CloudWatch metrics and alarms were disrupted (which delayed autoscaling), Lambda metric buffering caused memory contention, and EventBridge delays affected ECS and EKS.

## Contributing factors `[CONFIRMED]`

- Thread count per server grows in proportion to the number of servers in the fleet, and the limit had no fine-grained alarm.
- Cold-start of the front-end fleet was slow because shard-map population competes with request handling.
- Several dependent services buffered or blocked in ways that turned a Kinesis problem into their own outage.
- Status communication tools depended on an affected service.

## What the company changed `[CONFIRMED]`

- Move to larger CPU and memory servers to reduce the number of servers and threads, add fine-grained thread alarms, and test a higher thread limit.
- Improve cold-start time and move the front-end cache to a dedicated fleet; separate large services such as CloudWatch onto a partitioned front-end fleet.
- Accelerate cellularization of the front-end fleet, as already done for the back-end.
- Change Cognito to reduce its dependency on Kinesis, and make CloudWatch keep 3 hours of metrics in its local store.

---

## 🔧 Our analysis (not from the source)

**Questions a design review could have asked**
- Which per-instance resources grow with fleet size (connections, threads, file descriptors, memory), and what are their limits?
- How long does a full cold restart of each tier take, and does restart load compete with serving?
- What does each dependent service do when its best-effort dependency stalls: drop, buffer boundedly, or block?
- Can we tell a trigger from a root cause quickly when many errors appear at once?
- Do our scaling operations have a staged, reversible procedure?

**Related notes:** [04 Message queue (Kafka)](../systems/04-message-queue-kafka.md) for streaming platforms; [30 Metrics monitoring and alerting](../systems/30-metrics-monitoring-alerting.md); [C01 AWS S3 2017](C01-aws-s3-2017.md) for dashboard dependencies.

## Practice

Draw the dependency chain from Kinesis to ECS and mark each edge as hard, best-effort or buffered. Where would you add a bulkhead or a timeout?

## Sources and provenance

> **Sources read on 2026-10-27:** AWS, [*Summary of the Amazon Kinesis Event in the Northern Virginia (US-EAST-1) Region*](https://aws.amazon.com/message/11201/) (November 2020).
> **Dated material:** 2020. The architecture has since evolved.
> **Not read:** Later AWS write-ups of similar events and the Kinesis service design.
> **Tags:** `[CONFIRMED]` stated by the primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Sections marked "Our analysis" are ours.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of the source. Quotations are confirmed by `npm run verify`.*
- Verified in the AWS summary: the trigger and root cause, the thread-per-server design, the recovery constraints, the timeline, the dependent-service failures, and the planned changes.
- Our analysis section is not sourced.
