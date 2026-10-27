# 17 — Payment System

*A reference design built on verified building blocks. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A payment service never moves money without an idempotency key, models each payment as a state machine, treats provider webhooks as at-least-once and unordered, and records every movement in an immutable double-entry ledger. A nightly reconciliation against the provider catches drift. Stripe's documented behaviour and Square's Books ledger are the verified building blocks.

**Key numbers**
- Stripe v1 saves the first response including 500s; keys pruned after at least 24 hours `[CONFIRMED]`.
- Webhook retries up to three days with exponential back-off; no ordering guarantee `[CONFIRMED]`.
- Square's Books: about 20 TB, built and run by three people `[CONFIRMED]` (2019).

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Idempotency keys | A retry cannot charge twice | The key must be stable and survive restarts |
| Webhook as source of truth | Handles async methods and redirects | Duplicates and reordering to handle |
| Immutable double-entry ledger | Audit trail, safe corrections | More storage and code than a balance column |

**Common mistakes**
- Treating a timeout as failure and creating a new payment.
- Fulfilling on the browser redirect instead of a confirmed state.
- Updating a balance in place instead of appending a journal entry.


---

## 🧒 Non-technical explanation

A payment system is a **cashier plus an accountant**. The cashier (your checkout) asks the bank's agent (the payment provider) "please take £25 from this card", and **must never take it twice**, even if the phone line drops halfway through the call. The accountant records every movement in a **ledger that can never be erased**: every entry is "money moved from here to there", so the books always balance. If a mistake is made, you don't scribble it out. You write a new correcting entry.

Because phone lines drop and banks take days, the system must handle three things well: **retries that are safe**, **answers that arrive late or twice**, and a daily **check that your books match the bank's**.

---

## TL;DR for engineers

- **Never move money without an idempotency key.** The client generates a unique key per logical operation. The server stores the first result and returns it for retries. Stripe: v1 saves "the status code and body of the first request", including `500`s. Keys up to 255 characters, pruned after at least 24 hours. A reused key with different parameters errors `[CONFIRMED]`.
- **Model payment as a state machine**, not a boolean. Stripe's PaymentIntent moves `requires_payment_method → requires_confirmation → requires_action → processing → succeeded` (or `canceled`, or `requires_capture` for auth-then-capture) `[CONFIRMED]`. Async methods such as bank debits can take days.
- **Webhooks are at-least-once and unordered.** Stripe retries delivery for up to **three days** with exponential back-off in live mode, may send duplicates, and does not guarantee ordering. Track event IDs, verify the `Stripe-Signature`, return `2xx` fast and process asynchronously `[CONFIRMED]`.
- **Keep an immutable double-entry ledger** (every transaction balances to zero). Square's Books: append-only journal and book entries, corrections as new entries, on Cloud Spanner `[CONFIRMED]`.
- **Reconcile** your ledger against the provider's reports on a schedule, because retries, timeouts and webhooks will occasionally disagree `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** create a payment for an order · support cards plus at least one async method · authorise and capture (e.g. hotel or marketplace holds) · refunds and partial refunds · payment status visible to the order system · payouts to sellers (marketplace) · receipts and notifications.

**Non-functional:** **correctness first** (no double charge, no lost charge) · **auditability** (every cent traceable) · availability of checkout · security and PCI scope minimisation · eventual consistency with external parties is expected, but internally the ledger is strongly consistent.

**Out of scope for this note:** fraud models, card-network rules, tax, FX.

---

## 2. The payment state machine `[CONFIRMED]` (Stripe PaymentIntents)

Stripe's docs describe the lifecycle of a PaymentIntent. Using it as the reference model:

| State | Meaning (from the docs) |
|---|---|
| `requires_payment_method` | Created, awaiting a payment method. Stripe advises creating the intent as soon as the amount to charge is known, so that Stripe can record all payment attempts (paraphrased from the Portuguese-locale page). **A failed attempt returns the intent to this state** so it can be retried |
| `requires_confirmation` | Payment info provided, ready to confirm. Most integrations skip this by sending the method when confirming |
| `requires_action` | Extra step needed, such as 3D Secure |
| `processing` | After actions, for **asynchronous** methods like bank debits, which can take up to several days to confirm and cannot be guaranteed meanwhile. With separate authorise-and-capture it can pass through `requires_capture` first |
| `succeeded` | The flow completed. Per the docs the funds are already in your account and it is safe to fulfil the order. Refunds use the Refunds API |
| `canceled` | Possible before `processing` or `succeeded`. It invalidates the intent, releases any held funds and **cannot be undone** |

**Design lessons:**
- **One payment intent per order**, reused across attempts, so the provider can track all attempts and you can look up the state without guessing.
- **Fulfil on a confirmed `succeeded`**, ideally from the webhook (or a fetched status), not from the browser's redirect, which can be skipped or spoofed `[INDUSTRY PATTERN]`.
- Handle **`processing`** as a real state in your order flow. The order is "pending payment", not "paid" `[INDUSTRY PATTERN]`.
- Note: Stripe's docs now recommend its Checkout Sessions API over raw PaymentIntents for most integrations. The state model is still how its payments behave underneath.

---

## 3. Idempotency: the core safety mechanism `[CONFIRMED]` (Stripe docs)

- The client generates the key. Stripe suggests V4 UUIDs, up to **255 characters**, and warns against sensitive data in keys.
- **API v1:** Stripe "saves the status code and body of the first request made with a given idempotency key after endpoint execution begins", and "retries with the same key return the saved response, including `500` errors".
- **Parameter check:** the idempotency layer "compares incoming parameters to those of the original request and errors if they're not the same".
- **Not saved:** requests that fail validation or conflict with a concurrently executing request, since no endpoint began execution. Those can be retried.
- **Pruning:** keys can be removed automatically once they are **at least 24 hours old**, and a reused pruned key generates a new request.
- `POST` accepts keys. `GET` and `DELETE` are idempotent by definition and do not need them.
- **API v2** differs: retries "don't repeat successful operations" and Stripe retries failed or partial work to completion where possible.

**What *you* must do on your side** `[INDUSTRY PATTERN]`:
1. Generate the key from a **stable business identity** plus an attempt discriminator, such as `order_id + attempt_no`. If a retry changes the amount or card, use a new attempt number, because changed parameters on the same key error.
2. **Persist the key and your own intent record before** calling the provider, so a crash between "request sent" and "response stored" can be resolved by repeating the same call with the same key.
3. Use the same idea **inside your system**: an idempotency key on your own payment API, with the result stored in the same transaction as your payment record. See [16 Reservation scheduler](16-reservation-scheduler.md) for the hold-then-pay flow.
4. **Timeouts are not failures.** If the call times out, the payment may or may not have happened. Retry with the same key, or query the intent's status. Never create a fresh payment.

---

## 4. Webhooks: late, duplicate, unordered `[CONFIRMED]` (Stripe docs)

- **Delivery:** live mode retries for up to three days with exponential back-off (paraphrase). Sandbox events retry three times over a few hours. A disabled or deleted destination stops further retries. Manual resend is available for 15 days in the Dashboard (30 days via CLI).
- **Duplicates:** endpoints may receive the same event more than once, so record the IDs of events you have processed and skip any already recorded (paraphrase). Occasionally two Event objects are generated, so match on `data.object` ID plus `event.type`.
- **Ordering:** Stripe does not guarantee that events are delivered in the order they were generated (paraphrase). Do not use `created` (second resolution) to order events. If `invoice.paid` arrives before its related objects, fetch them from the API.
- **Respond fast:** return `2xx` before any complex logic that could cause a timeout (paraphrase). Process via an **asynchronous queue**, since spikes (for example at the start of a billing month) can overwhelm synchronous handlers.
- **Verify authenticity:** check the `Stripe-Signature` header (timestamp `t=` plus `v1=` HMAC-SHA256 of `timestamp.payload`) using the endpoint's signing secret and the **raw request body**. Default tolerance is **five minutes** to limit replay attacks, and a tolerance of `0` disables the freshness check. Use constant-time comparison, ignore schemes other than `v1`, and keep clocks in sync with NTP. Also allow-list Stripe's IP addresses.
- **Subscribe only to event types you need**, and exempt the webhook route from CSRF protection.

**Design consequence** `[INDUSTRY PATTERN]`: a webhook handler is "verify → record event ID (unique constraint) → enqueue → 2xx". The worker then loads the *current* object state from the provider API rather than trusting the event payload's ordering.

---

## 5. The ledger: immutable double-entry `[CONFIRMED]` (Square Books, 2019)

**Why Square built it:** the old settlement service computed a merchant's balance with "an expensive group-by aggregate for each merchant", struggled at millions of payouts a day, could not split one payment into multiple payouts (a many-to-one relationship), allowed inconsistencies ("nothing is stopping [the payout_id] from being nulled out"), and needed application-level sharding with painful cross-shard transactions.

**The model:** *Double Entry Accounting*. "All transactions (which we call 'journal entries') must balance to 0, so each cent lost is matched with a cent gained". It forces you to state "not just what financial state change occurred, but why".

**Schema (simplified, from the post):**
- `books`: one row per book. Holds a balance, type, owner, unique ID. Books are the only mutable table because the current balance updates on each operation.
- `journal_entries`: one row per accounting transaction.
- `book_entries`: each row links a journal entry and a book, with a debit (+) or credit (−) amount, and a **monotonic per-book version counter**. Because balances are cached on book entries, journal and book entries are "effectively append-only and immutable".
- **Worked example in the post:** two payments of $100 and $80 debit the *Payments* book and credit *Pending Balance* (so Payments = $180 and Pending = −$180). A refund credits *Refunds* and debits *Pending*. The payout then equals the pending balance, which is one row, with no aggregation. It also allows **splitting payouts** arbitrarily.
- **Corrections:** "You can't update the data in place": you write a new entry that corrects the previous one, so "there will always be a trace of what happened".
- **Multitenancy:** tenants are "shelves", and secondary indexes are namespaced by `shelf_id`.
- **Storage:** Google Cloud Spanner, which removed application-level sharding. Spanner schemas required UUIDs instead of monotonically increasing integers, hotspot-aware timestamp ordering, and interleaved tables for co-location. At the time of writing, **~20 TB** of data, run by **a team of three**.

**Take-aways for an interview** `[INDUSTRY PATTERN]` extrapolated from this design:
- Record every money movement as a **balanced journal entry** and never `UPDATE` amounts.
- Store money as **integers in minor units** (cents) plus a currency code, never floats.
- Keep **business state** (order, payment intent) separate from **accounting state** (ledger), linked by IDs.
- The ledger write and the "payment succeeded" state change should commit **together** (one transaction, or an outbox).

---

## 6. Architecture `[INDUSTRY PATTERN]` unless tagged

```
Checkout (browser/app) ──► Order service ──► Payment service ──► PSP API (idempotency key)
                                                   │                   │  │
                                        payment DB (intent, attempts)  │  └─► webhooks ──► verify → dedupe → queue
                                                   │                   │                           │
                                              outbox/queue ◄───────────┴───────────────────────────┘
                                                   │
                                  Ledger service (immutable double-entry) ──► reports / payouts
                                                   │
                                        Reconciliation job ◄── PSP settlement reports
```

- **Card data never touches your servers.** The client sends it to the PSP (tokenisation/hosted fields) and you handle only tokens, which minimises PCI scope. PCI rules were not read here, so treat this as the standard design.
- **Payment service** owns intents, attempts and idempotency records. **Ledger service** owns money movements. **Order service** owns fulfilment.
- **Outbox pattern:** commit "payment succeeded" plus the event in one local transaction, then publish, so downstream (ledger, notifications) never misses it. See [04 Message queue](04-message-queue-kafka.md) and [10 Notification system](10-notification-system.md).
- **Rate limits and back-pressure** on provider calls: see [02 Rate limiter](02-rate-limiter.md). Stripe documents its own limiters (request rate, concurrency, load shedders) and recommends dark launches and kill switches.
- **Reconciliation:** compare your ledger and intents with the provider's settlement and transaction reports daily. Investigate differences and write correcting entries, never edits.

---

## 7. Failure cases to walk through

| Failure | What happens | Mitigation |
|---|---|---|
| Client double-clicks "Pay" | Two requests, same order | Same idempotency key, or intent already `processing` |
| Timeout after sending to the PSP | Unknown outcome | Retry with the **same** key, or fetch the intent. Never a new payment |
| Webhook arrives twice | Duplicate event | Event-ID unique constraint `[CONFIRMED]` |
| Webhook arrives before the API call returns | Order ahead of response | Handlers fetch current state instead of assuming order `[CONFIRMED]` |
| Bank debit stays `processing` for days | Order cannot ship | "Pending payment" state, reminders, timeout policy |
| Process crashes after commit, before publishing | Event lost | Outbox |
| Ledger and PSP disagree | Silent drift | Reconciliation plus correcting entries |
| Refund requested twice | Double refund | Idempotency key on refund, and check refundable balance |

---

## ⚠️ Reviewer notes

1. **"Exactly-once payments" is not a thing.** The honest guarantee is *at-least-once delivery + idempotent processing*. Idempotency keys make retries safe. They do not stop *you* from creating two different keys for the same intent.
2. **Idempotency keys have a lifetime.** Stripe v1 may prune keys after 24 hours. A retry days later with an old key creates a **new** request, so your own records must prevent a late duplicate.
3. **A successful API response is not the same as settled money.** `succeeded` means the payment flow completed per Stripe's docs. Bank settlement and payouts are separate steps. Do not conflate them in your ledger.
4. **Do not copy Square's ledger as a template for every product.** The post itself notes that Square relaxed strict double-entry sign conventions for modelling ease. Study the principle (balanced, immutable entries), not the exact schema.
5. **Stripe's docs evolve.** We read the pages on 2026-10-27, including the note that Checkout Sessions is now recommended for most integrations. Re-read before relying on a detail such as retry windows.
6. **We read no card-network or PCI material**, so we state no compliance requirements.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](../../neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **data integrity / consistency**, **auditability**, **reliability**, **security**, **availability** of checkout, **recoverability**. Throughput matters less than correctness.
- **Style (Ch 13/14/17):** **service-based**, with an **event-driven** edge to the PSP (webhooks) and an immutable-log core (the ledger). Event sourcing's ideas (append-only facts, replay) show up in the ledger.
- **Quanta (Ch 7):** the ledger is a quantum that must be strongly consistent. The checkout and notification paths can be more relaxed. The PSP is an external quantum you cannot change, so everything that touches it is designed for unknown outcomes.
- **Trade-off (First Law, Ch 1):** **consistency and auditability vs speed and simplicity.** An immutable ledger is more work than an `UPDATE balance` column, and pays back in traceability.
- **ADR sketch (Ch 19):** *"We will record all money movements as balanced, append-only ledger entries and make every provider call idempotent. We accept more storage and more code than a mutable balance column, in exchange for an audit trail and safe retries."*
- Plain English: the cashier never takes money twice, and the accountant never erases a line.

---

## Interview questions to practice

1. A customer clicks Pay and your server times out waiting for the PSP. What do you do, and what must you never do?
2. How do idempotency keys work, and what happens when the same key is sent with a different amount?
3. Design the webhook endpoint. How do you handle duplicates, out-of-order events and slow processing?
4. Why use double-entry bookkeeping instead of a `balance` column? Walk through a payment, a refund and a payout.
5. How do you reconcile your records against the PSP's? What do you do with a mismatch?
6. How would you support authorise-now, capture-later (like a hotel or ride)? Which states change?
7. How would you let a marketplace split one payment between three sellers?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: methods, refunds, marketplace splits, regions.
2. Estimate: payments/s and ledger rows.
3. API: create intent with an idempotency key, webhook.
4. Design: payment service, PSP, queue, ledger, reconciliation.
5. Deep dive: state machine, retries, webhook handling.
6. Failure and scale: timeouts, duplicates, mismatches.

**If it grows 10×**
- Webhook spikes: acknowledge fast and process from a queue.
- Ledger growth: partition by account and keep entries append-only.
- More providers: put an adapter layer behind one intent model.

**Answer outlines** (try the questions above first)

<details><summary>The PSP call times out. What now?</summary>

Retry with the same idempotency key, or fetch the intent's status. Never create a fresh payment.

</details>

<details><summary>Why double-entry instead of a balance column?</summary>

Every transaction balances to zero, entries are append-only and corrections are new entries, giving an audit trail and consistency.

</details>

<details><summary>How do you handle duplicate and out-of-order webhooks?</summary>

Record event IDs under a unique constraint, enqueue, return 2xx, and have the worker read the current object state.

</details>

## 📚 Further reading

- The sources listed at the top.
- [Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) (see also [02 Rate limiter](02-rate-limiter.md)).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [16 Reservation scheduler](16-reservation-scheduler.md), [04 Message queue](04-message-queue-kafka.md), [`neokim-post/12` Airbnb](../../neokim-post/12-how-airbnb-works.md) (payments section and the `Idempotency-Key` discussion).

## Sources and provenance

> **Kind:** reference design with its important mechanisms sourced to primary documents. The usual interview question is "design a payment service" for a merchant or marketplace that takes card and bank payments through a payment service provider (PSP). Real PSP internals are not published in a way we could verify, so the architecture is the standard design `[INDUSTRY PATTERN]`. What **is** verified: Stripe's documented behaviour for **idempotency**, **PaymentIntent states** and **webhooks**, and Square's published design of an **immutable double-entry ledger** (Books).
> **Sources read on 2026-10-27:** Stripe docs: [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), [PaymentIntents lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle), [Webhooks](https://docs.stripe.com/webhooks) (our fetches of the last two returned Portuguese-locale pages. We read them in that language and translate the quoted facts) · Square Engineering, [*Books, an immutable double-entry accounting database service*](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/) (2019-10-16) · [Stripe's rate-limiter post](https://stripe.com/blog/rate-limiters), read for [02 Rate limiter](02-rate-limiter.md).
> **Not read:** card-network rules, PCI DSS text, bank settlement file formats, the Airbnb post on idempotency (paywalled, returned only its introduction), and any PSP's internal architecture. Claims about those are `[INDUSTRY PATTERN]` or left out.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Stripe pages fetched (Portuguese-locale responses, read and translated), Square post read from the live page and the Internet Archive copy (same text length).
- Verified in Stripe idempotency docs: client-generated keys, 255 characters, V4 UUIDs suggested, no sensitive data, v1 saves status code and body including `500`, parameter comparison errors, validation and concurrency conflicts not saved, pruning after at least 24 hours, `POST` accepts keys, `GET`/`DELETE` do not need them, v2 retry behaviour.
- Verified in Stripe PaymentIntent docs: the six states and meanings, async methods taking up to several days, `requires_capture` for authorise-then-capture, failure returns to `requires_payment_method`, cancellation irreversible and releases held funds, create the intent once the amount is known, the Checkout Sessions recommendation.
- Verified in Stripe webhook docs: three-day exponential retries in live mode, three sandbox retries, manual resend 15 days (Dashboard) and 30 days (CLI), duplicates possible and event-ID tracking, no ordering guarantee and `created` not for ordering, respond `2xx` before complex logic, async queue, signature scheme (`t=`, `v1`, HMAC-SHA256 of `timestamp.payload`), five-minute default tolerance and `0` disables freshness checking, raw-body requirement, IP allow-list, CSRF exemption.
- Verified in Square's post: the old settlement problems, double-entry rationale, `books` / `journal_entries` / `book_entries`, version counter, immutability and corrections-as-new-entries, shelves, Spanner schema rules, ~20 TB and a three-person team, the worked $100 / $80 example and its balances ($180 and −$180).
- Not read: Airbnb's idempotency post (member-only, only the introduction came back), PCI DSS, card-network rules, settlement file formats, any PSP's internals.
- Labelled industry pattern, not sourced: the reference architecture, the "persist the key before calling" advice, minor-unit integers, reconciliation practice, fulfil-on-webhook advice, the failure-case table.
- Method note: the Stripe pages came back in Portuguese because of locale. The facts above are our translation of the returned text, so quotes are paraphrased rather than verbatim.
- Quote audit (2026-10-27): Stripe sentences from the webhook and PaymentIntent pages were read in Portuguese, so they are now paraphrases without quotation marks (the idempotency page was read in English and its quotes are unchanged).
