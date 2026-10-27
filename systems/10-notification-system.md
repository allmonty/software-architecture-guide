# 10 — Notification System

*A reference design built on verified building blocks. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A notification platform accepts requests, deduplicates them, checks preferences, renders content, queues per channel and priority, and calls providers such as APNs and FCM. Its design is shaped by the providers' behaviour: priority, expiry, collapsing, token hygiene and rate limits, and by queues that deliver at least once, so every stage must be idempotent.

**Key numbers**
- APNs payload limit 4 KB (5 KB VoIP), `apns-priority` 10/5/1 `[CONFIRMED]`.
- FCM TTL 0–28 days, default 4 weeks; tokens stale after a month `[CONFIRMED]`.
- SQS standard queues are at-least-once with possible reordering `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Separate queues by channel and priority | A marketing blast cannot starve a security alert | More queues and workers to run |
| Idempotency key at ingest | Producer retries do not duplicate sends | A dedup store with a TTL |
| Fail toward a rare duplicate | No distributed transactions with a provider | Occasional repeated notification |

**Common mistakes**
- Claiming exactly-once delivery: the provider edge is best effort.
- Retrying errors that cannot succeed (APNs `BadDeviceToken`, `Unregistered`).
- Reporting 'delivered' when the provider only accepted the request.


---

## 🧒 Non-technical explanation

A notification system is a **post office with sorting rules**. Many departments drop off letters ("your order shipped", "someone liked your photo"). The post office decides:
- **Should this letter go out at all?** (Did the person opt out? Is it 3 a.m. there? Have we already sent this exact letter?)
- **By which carrier?** Phone push, email, or text message, each with its own rules and prices.
- **How urgent is it?** A fraud alert jumps the line. A weekly digest can wait.
- **What if the carrier refuses it?** Retry later, try another way, or give up and write down that this address is dead.

The carriers (Apple and Google) are **not under your control**, and they have their own rules about how long a letter may sit and how many you may send.

---

## TL;DR for engineers

- **The platform is a pipeline:** accept → validate/dedupe → check preferences → render a template → enqueue per channel and priority → channel workers → provider → handle feedback. Each stage can fail independently `[INDUSTRY PATTERN]`.
- **Queues give at-least-once, not exactly-once.** SQS standard queues "ensure at-least-once message delivery" and "more than one copy of a message might be delivered", so **dedupe** on a notification ID `[CONFIRMED]` (SQS docs).
- **Providers shape the design.** APNs: priority 10 / 5 / 1, `apns-expiration`, `apns-collapse-id` (≤64 bytes), 4 KB payload, specific error codes with retry rules `[CONFIRMED]`. FCM: TTL 0–28 days (default 4 weeks), `collapse_key`, normal vs high priority, one-month token staleness `[CONFIRMED]`.
- **Token hygiene is part of the system:** remove tokens on APNs `410 Unregistered` and FCM `UNREGISTERED`, store a timestamp per token, prune stale ones `[CONFIRMED]`.
- **Retry with back-off, dead-letter the rest**, and never retry errors that cannot succeed (e.g. APNs `BadDeviceToken`, `Unregistered`, `PayloadTooLarge`) `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Functional:** send transactional (receipts, alerts) and marketing messages · channels: mobile push, email, SMS, in-app · per-user preferences and opt-out · templates and localisation · scheduling and quiet hours · bulk/broadcast to millions · delivery status and analytics.

**Non-functional:** **reliability** (a password-reset code must arrive) · **priority isolation** (a marketing blast must not delay a security alert) · **no duplicates** where it matters · soft real-time (seconds for transactional) · scale to bursts (a broadcast to tens of millions) · **provider-limit awareness** · auditability (why was or wasn't this sent?).

**Scale:** depends entirely on the product. State your assumption and derive from it, for example 10M users × 5 notifications/day = 50M/day ≈ 580/s average, with bursts of 10–100× at broadcast time `[SPECULATIVE]` (an illustrative assumption, not a sourced figure).

---

## 2. Pipeline `[INDUSTRY PATTERN]`

```
producers (services, schedulers, campaigns)
        │  POST /notify { idempotency_key, user_id, type, data, priority }
        ▼
  ┌── Ingest API ──► validate, authz, rate-limit per producer
  │         │
  │         ▼
  │   Dedup store (idempotency_key)  ── already seen → return prior result
  │         │
  │         ▼
  │   Orchestrator: load preferences + device tokens + channel rules
  │         │   (opt-out? quiet hours? frequency cap? → drop / delay with reason)
  │         ▼
  │   Template render (locale, A/B)
  │         │
  │         ▼
  └─► per-channel, per-priority queues
          push-high | push-normal | email | sms | in-app
              │            │          │      │
          push workers  email wkrs  sms wkrs  ...  ──► providers (APNs, FCM, ESP, SMS gateway)
              ▲                                        │
              └──── retry w/ back-off, DLQ ◄── errors / receipts / feedback
```

Design points:
- **Separate queues by priority and channel** so a marketing blast cannot starve a security alert, and so an SMS provider outage does not stall push.
- **Idempotency key** at ingest: producers retry, and queues deliver at-least-once, so the same logical notification can arrive twice. Keep a TTL'd record of keys seen.
- **Preferences and caps** are checked in one place, so every producer inherits the same rules, and the decision (sent / dropped / delayed and why) is logged for audit.
- **Fan-out for broadcasts:** a campaign job pages through the audience and enqueues individual notifications, instead of one giant message. This lets you throttle, pause and resume.
- **Provider abstraction:** one interface per channel, with failover to a second provider for email/SMS where available.

---

## 3. What the push providers actually do

### APNs (Apple) `[CONFIRMED]`
- Requires **HTTP/2 and TLS 1.2+**. You may open multiple connections to raise throughput.
- **Payload limit 4 KB (4096 bytes)**, 5 KB (5120 bytes) for VoIP. Larger returns `413 PayloadTooLarge`.
- **`apns-priority`:** `10` sends immediately (the default if omitted), `5` sends "based on power considerations on the user's device", `1` prioritises power over all other factors and avoids waking the device. Priority 5 and 1 notifications "might get grouped and delivered in bursts" and may be throttled or not delivered.
- **`apns-expiration`:** a UNIX epoch in seconds. **Non-zero:** APNs stores the notification and retries until that date. **`0`:** APNs tries **once** and does not store it. APNs states it honours expiry on a best-effort basis, without guarantee.
- **Storage:** "APNs stores only one notification per bundle ID" for an offline device, and "in most cases, the latest notification is stored", though that is not guaranteed.
- **`apns-collapse-id`:** merges multiple notifications into one for the user. Max 64 bytes.
- **`apns-id`:** a UUID. APNs echoes it back in error reports, and creates one if you omit it.
- **Errors and retries:** `410 Unregistered` ("no need to send further pushes to the same device token, unless your application retrieves the same device token") and `410 ExpiredToken`. `429 TooManyRequests` ("too many requests were made consecutively to the same device token"). `503 Shutdown`, after which, per Apple, "After 15 minutes, you can retry JSON payloads that receive response status codes that begin with 5XX". Retry 5xx with back-off. **Do not retry** `BadDeviceToken`, `DeviceTokenNotForTopic`, `Forbidden`, `ExpiredToken`, `Unregistered` or `PayloadTooLarge`. You may retry `TooManyRequests` after a delay.
- **Auth tokens:** if you use token-based auth, do not refresh more often than once every 20 minutes (a too-frequent refresh returns an error).

### FCM (Google/Firebase) `[CONFIRMED]`
- **TTL:** "a duration from 0 to 2,419,200 seconds (28 days)". **Default: four weeks.** TTL 0 means a message that cannot be delivered immediately is discarded.
- **`collapse_key`:** if a message with the same key is already waiting, "the old message is discarded and then new message takes its place." Without it, old and new messages are both stored.
- **Priority:** **normal** is the default, and is "delivered immediately when the device is not sleeping", but in Doze "delivery may be delayed". **High** is for "time sensitive, user visible content", and generally "should result in user interaction". Using it for everything defeats its purpose.
- **Tokens:** a registration is **stale** if the app instance "hasn't connected for a month". Store a **timestamp** with every token, refresh roughly monthly (more often than weekly has no benefit), prune stale tokens on a schedule, and delete on `UNREGISTERED` (HTTP 404) and, once the payload is confirmed valid, `INVALID_ARGUMENT` (HTTP 400).

**Take-away for the design:** expiry and collapse keys decide whether a stale notification should ever be shown. A "your ride is arriving" push is worthless 30 minutes later, so give it a short TTL (or `apns-expiration: 0`) and a collapse key `[INDUSTRY PATTERN]`, applying the vendor semantics above.

---

## 4. Reliability: retries, duplicates, dead letters

- **Queue semantics** `[CONFIRMED]` (SQS): standard queues provide **at-least-once** delivery and best-effort ordering, so duplicates and reordering are possible. SQS also "redundantly stores the message in multiple availability zones" before acknowledging a send.
- **Dead-letter queues** `[CONFIRMED]` (SQS): a source queue can send messages that were not processed successfully to a DLQ after `maxReceiveCount` receives. Set it high enough to allow real retries. Set the DLQ's retention longer than the source queue's, because the original enqueue timestamp is kept.
- **Idempotent workers** `[INDUSTRY PATTERN]`: record `(notification_id, channel)` as sent before or atomically with calling the provider, and check it first. The provider call is the side effect you cannot roll back, so you choose between a rare duplicate (record after send) and a rare drop (record before send). For most notifications, a rare duplicate is the better failure.
- **Back-off with jitter** on retryable errors, per provider and per token, so one failing region does not hammer the provider. Respect APNs's 15-minute guidance after a shutdown `[CONFIRMED]`.
- **Circuit-break a provider** that is returning errors, and fail over or park the queue. `[INDUSTRY PATTERN]`

---

## 5. Data model `[INDUSTRY PATTERN]`

| Table | Key | Notes |
|---|---|---|
| `notification` | `notification_id` | type, user_id, payload, priority, created_at, idempotency_key (unique) |
| `delivery` | `(notification_id, channel)` | status (queued / sent / delivered / failed / dropped), provider id, error, attempts |
| `device_token` | `(user_id, token)` | platform, app version, **last_seen** timestamp, active flag |
| `preference` | `(user_id, type, channel)` | opt-in/out, quiet hours, frequency cap |
| `template` | `(type, locale, version)` | |

Deliveries are write-heavy and time-ordered, so a wide-column or time-partitioned store suits them. Preferences are read-heavy and small, so cache them.

---

## 6. Scale and abuse

- **Broadcast fan-out:** page through the audience, enqueue per user, throttle to the provider's accepted rate, and make the job resumable. `[INDUSTRY PATTERN]`
- **Per-user frequency caps** protect users from over-notification and protect you from `429` responses. APNs returns `429` for too many consecutive requests to the same token `[CONFIRMED]`.
- **Priority isolation:** separate queues and worker pools per priority, with capacity reserved for the high class `[INDUSTRY PATTERN]`.
- **Rate limit producers** so a buggy service cannot create a notification storm. See [02 Rate limiter](02-rate-limiter.md).
- **Privacy:** do not put sensitive data in the push payload. Fetch details after the user opens the app `[INDUSTRY PATTERN]`.

---

## ⚠️ Reviewer notes

1. **"Exactly-once delivery" is not offered by the delivery edge.** APNs and FCM are best-effort ("without any guarantee" for expiry in APNs's own words). What you can promise is at-least-once from your queue plus deduping, and best effort on the device.
2. **A push is not a delivery receipt.** APNs accepting a request does not mean the user saw it. Do not report "delivered" unless you have an app-level receipt `[INDUSTRY PATTERN]`.
3. **One-notification-per-bundle storage in APNs** means an offline device may get only the latest of several queued pushes. Design content so the latest one is self-sufficient, or use collapse IDs deliberately.
4. **Our fetch of Apple's docs page returned only a title.** The APNs facts above come from Apple's documentation data file (the same content the page renders) and were read in full. An earlier summarising fetch tried to fill the gap from its own memory. We discarded that and used only the data file text.
5. **We did not verify** FCM payload size limits, topic-fan-out limits or APNs/FCM throughput quotas, so none is stated.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the vendor docs. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **reliability**, **availability** of the ingest path, **elasticity** (campaign bursts), **interoperability** (many providers) and **isolation** between priorities.
- **Style (Ch 14):** **event-driven, broker topology**: producers emit, queues buffer, channel workers react. The orchestrator in the middle is closer to a **mediator** for the per-notification workflow (preferences → render → route). It is a hybrid.
- **Quanta (Ch 7):** each channel (push, email, SMS) is its own **quantum** with a separate queue, workers and provider. That is the point of the isolation.
- **Trade-off (First Law, Ch 1):** **at-least-once with dedup vs exactly-once complexity.** Accept a rare duplicate rather than build distributed transactions with a third-party provider that does not support them.
- **ADR sketch (Ch 19):** *"We will separate queues by channel and priority, deduplicate on an idempotency key, and record the send before calling the provider only for opt-in-critical notifications. We accept occasional duplicates for the rest."*
- Plain English: a post office with separate lanes for urgent mail, and a ledger so the same letter is not stamped twice.

---

## Interview questions to practice

1. Design a platform that sends 50M notifications in an hour without delaying one-time passwords. What are your queues?
2. A producer retries and a worker crashes after the provider call. How do you avoid sending twice?
3. APNs returns `410 Unregistered` for 8% of tokens. What do you do, and what does that tell you about token hygiene?
4. What should the TTL and collapse key be for "driver arriving in 2 minutes"? For "weekly digest"?
5. How do you implement per-user quiet hours across time zones for a broadcast?
6. How would you prove to support why a user did not get a notification?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: channels, volume, priorities, preferences, scheduling.
2. Estimate: notifications/day and burst size.
3. API: send with an idempotency key.
4. Design: ingest, preferences, queues, workers, providers.
5. Deep dive: retries, dedup, token cleanup, TTL and collapse keys.
6. Failure and scale: provider outage, broadcasts, DLQ.

**If it grows 10×**
- Broadcasts: page through the audience and throttle to provider limits.
- Hot users: per-user frequency caps and APNs 429 handling.
- Provider outage: circuit-break and fail over where possible.

**Answer outlines** (try the questions above first)

<details><summary>Send 50M notifications in an hour without delaying OTPs?</summary>

Use separate priority queues and worker pools with reserved capacity for the urgent class, and throttle the bulk queue to provider limits.

</details>

<details><summary>A producer retries and a worker crashes after the provider call. How do you avoid sending twice?</summary>

Dedup at ingest on an idempotency key and record the send per notification and channel. Accept a rare duplicate rather than a lost notification.

</details>

<details><summary>What TTL and collapse key for 'driver arriving'?</summary>

A short TTL (or APNs expiration 0) and a collapse key, because a stale arrival notice has no value and newer ones should replace older ones.

</details>

## 📚 Further reading

- The vendor docs listed at the top.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary; asynchronism and message-queue topics).
- Related in this repo: [04 Message queue / log](04-message-queue-kafka.md), [02 Rate limiter](02-rate-limiter.md), [08 Chat](08-chat-whatsapp.md) (APNs/FCM wake-ups for offline users).

## Sources and provenance

> **Kind:** reference design. No company publishes a full notification-platform architecture that we could verify, so the platform in the middle is the standard interview design `[INDUSTRY PATTERN]`. What **is** sourced to primary documents is the edge of the system: how Apple's APNs and Google's FCM behave (priority, expiry, collapsing, errors, token hygiene) and what a standard queue like Amazon SQS does and does not guarantee.
> **Sources read on 2026-10-27:** Apple, [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) and [Handling notification responses from APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns) (fetched from Apple's documentation JSON) · Firebase: [Setting the lifespan of a message](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan), [Message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority), [Manage FCM registration tokens](https://firebase.google.com/docs/cloud-messaging/manage-tokens) · AWS: [SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html), [SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).
> **Not read:** email and SMS provider documentation, so claims about those channels are `[INDUSTRY PATTERN]` only.
> **Tags:** `[CONFIRMED]` stated by a vendor doc · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* APNs: read in full from Apple's documentation data files. FCM and SQS: fetched pages, quotes checked against the returned text.
- Verified in Apple docs: HTTP/2 + TLS 1.2; 4 KB / 5 KB payload limits; `apns-priority` 10/5/1 meanings and default 10; `apns-expiration` semantics (0 = single attempt, non-zero = stored, best effort); one stored notification per bundle ID; `apns-collapse-id` ≤64 bytes; `apns-id` behaviour; status codes 410, 413, 429, 500, 503 and the reason strings; the "do not retry" list; retry after 15 minutes for 5xx shutdown; 20-minute minimum between auth-token refreshes.
- Verified in FCM docs: TTL 0–2,419,200 s, default four weeks, TTL 0 behaviour; `collapse_key` semantics; normal as default priority, Doze delay, high-priority guidance; one-month staleness, monthly refresh and no benefit under weekly, `UNREGISTERED` (404) and `INVALID_ARGUMENT` (400) handling, timestamps and pruning.
- Verified in SQS docs: at-least-once, possible duplicates and reordering, multi-AZ storage before ack; DLQ redrive with `maxReceiveCount`; DLQ retention should exceed source queue retention.
- Discarded: an unverified paraphrase from memory that a summarising fetch produced for the Apple page. Only the documentation-data text was used.
- Not verified: FCM payload size, FCM/APNs throughput limits, email and SMS provider behaviour, and anything about how any named company builds its notification platform. The platform pipeline and data model are `[INDUSTRY PATTERN]`, and the scale figure is `[SPECULATIVE]`.
