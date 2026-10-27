# 16 — Reservation Scheduler (Hotel Rooms & Parking Spaces)

*A reference design built on verified building blocks. How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** A reservation scheduler models bookings as a resource and a time range, and lets the database refuse overlaps. In PostgreSQL an exclusion constraint on a unit and a half-open range guarantees no double booking, counted inventory uses a guarded counter, and holds with a TTL stop users losing a slot while paying. Search can be stale, but the write path always re-checks.

**Key numbers**
- `UNIQUE` is usually unsuitable for ranges; exclusion constraints are the documented fit `[CONFIRMED]`.
- `tstzrange` bounds are not canonicalised, so pass `[)` explicitly `[CONFIRMED]`.
- Stripe idempotency keys: up to 255 characters, pruned after at least 24 hours `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Exclusion constraint on (unit, period) | Overlaps impossible whoever writes | Single-shard writes and conflict retries |
| Guarded counters for pooled inventory | Simple capacity limit | Multi-night updates need ordering to avoid deadlocks |
| Holds as real rows | Block others during payment | A sweeper and expiry handling |

**Common mistakes**
- Using a unique index on (room, start) to prevent overlaps.
- Mixing open and closed bounds so back-to-back stays conflict.
- Trusting a distributed lock instead of the database constraint.


---

## 🧒 Non-technical explanation

A reservation system is a **wall calendar with one rule: no two bookings may overlap on the same room or space**. Everything hard comes from several people reaching for the same square of the calendar at the same moment.

- **Hotel:** you book *a night in a room type* ("a double room on 12 Dec"). The hotel has, say, 40 doubles, so it counts how many are taken. It may not assign the physical room until you check in.
- **Parking:** you book *a time slot in a space or zone* ("Level 2, 08:00–18:00"). Slots are shorter, change often (you extend, you overstay), and a car that doesn't show up should free the space.

Both need the same three things: **look** (is it free?), **hold** (reserve it for a few minutes while you pay), **commit** (it's yours, or the hold expires).

---

## TL;DR for engineers

- **Model it as `resource × time range`.** A hotel room, a room type with a count, or a parking space are all *resources*, and a booking claims a range of time on one.
- **Let the database prevent overlaps.** In PostgreSQL, an **exclusion constraint** on `(resource WITH =, period WITH &&)` makes overlapping bookings for one resource impossible, whatever your application does `[CONFIRMED]`. For *counted* inventory (room type per night), use a guarded counter update.
- **Separate search from booking.** Search can be eventually consistent (caches, indexes). The **write** path must re-check against the source of truth.
- **Holds with a TTL** stop users losing a room at the payment step. Holds count as occupied until they expire.
- **Retries are normal.** Concurrency under `REPEATABLE READ` or `SERIALIZABLE` raises serialization errors (SQLSTATE `40001`) that the app **must retry** `[CONFIRMED]`, and payment calls need **idempotency keys** `[CONFIRMED]`.
- **Hotels and parking differ in granularity and policy** (nights vs minutes, overbooking, no-show release), not in the core mechanism.

---

## 1. Requirements (design framing)

**Functional:** search availability (location, dates/times, filters) · view price · **hold** · pay and confirm · modify (change dates, extend) · cancel with a policy · notify · for parking: entry/exit access (QR code or plate), overstay handling.

**Non-functional:** **never double-book** the same unit (hard constraint) · search latency in the low hundreds of milliseconds · availability of the booking path · correctness over speed on the write path · auditability (why was this booking accepted or refused?).

**Clarifying questions that change the design:**

| Question | Why it matters |
|---|---|
| Is a booking for a **specific unit** or a **type** (room type, parking zone)? | Specific → exclusion constraint. Type → counted inventory. |
| What is the **time granularity**? (nights, hours, 15 minutes) | Range type and indexing choice |
| Is **overbooking** allowed? | Allowed → the counter limit is a business number, not capacity |
| Hold duration and payment model (pay now, pay later, pre-auth)? | Hold TTL, saga steps |
| Can bookings be **extended or moved**? | Re-run the overlap check on the new range |
| Single region or global? Is one hotel's inventory a natural shard? | Partition key (`hotel_id`, `lot_id`) |

---

## 2. Hotel rooms vs parking spaces

| | **Hotel** | **Parking** |
|---|---|---|
| Resource | Room type with a count (e.g. 40 doubles), or a specific room | A numbered space, or a **zone/level pool** with a capacity |
| Time unit | **Nights** (check-in date to check-out date) | Minutes or hours, often same-day |
| Natural range type | `daterange`, in the property's **local** calendar | `tstzrange` (UTC), with rate rules applied in the lot's local time zone |
| Assignment | Often **late** (room assigned at check-in) | Pool bookings often have **no assigned space** until entry |
| Typical churn | Low: change or cancel | **High**: extensions, overstays, early exit, no-shows |
| Overbooking | Common industry practice to hedge no-shows (business policy) | Possible for pools, risky for numbered spaces |
| Access control | Key card at check-in | Gate: QR code or plate recognition at entry and exit |

The mechanisms below apply to both. The *choice between them* follows the first row.

---

## 3. Preventing double booking

### Option A: exclusion constraint on a specific resource `[CONFIRMED]`

The PostgreSQL docs state that `UNIQUE` "is usually unsuitable for range types. Instead, an exclusion constraint is often more appropriate". Their meeting-room example, after installing `btree_gist`, "will reject overlapping ranges only if the meeting room numbers are equal":

```sql
CREATE EXTENSION btree_gist;
CREATE TABLE room_reservation (
    room text,
    during tsrange,
    EXCLUDE USING GIST (room WITH =, during WITH &&)
);
```

An overlapping insert fails with `conflicting key value violates exclusion constraint`. The docs define an exclusion constraint as ensuring that "if any two rows are compared on the specified columns or expressions using the specified operators, at least one of these operator comparisons will return false or null", and note that adding one "will automatically create an index of the type specified".

Our adaptation for parking (illustrative, not from the docs):

```sql
CREATE TABLE booking (
  id           uuid PRIMARY KEY,
  space_id     bigint NOT NULL,
  during       tstzrange NOT NULL,                 -- build as tstzrange(start, end, '[)')
  status       text NOT NULL CHECK (status IN ('HELD','CONFIRMED','CANCELLED')),
  hold_expires timestamptz,
  EXCLUDE USING GIST (space_id WITH =, during WITH &&)
         WHERE (status IN ('HELD','CONFIRMED'))     -- cancelled bookings don't block
);
```

- **Bounds matter.** Back-to-back bookings (10:00–12:00 then 12:00–14:00) must not conflict, so use half-open ranges `[)`. The docs say the two-argument constructor builds a range "in standard form (lower bound inclusive, upper bound exclusive)", and that `daterange` canonicalises to `[)`. **`tstzrange` is not canonicalised**, so its bounds keep whatever inclusivity you give it. Always pass `'[)'` explicitly for time ranges. This is a subtlety of the docs' text, so state the bounds yourself.
- **Why the database, not the app:** an application check-then-insert has a race window. A non-deferrable constraint (the default) is checked immediately after each statement, so a concurrent overlapping insert waits for the first transaction to finish and then fails. The database enforces it regardless of which service writes (per the PostgreSQL CREATE TABLE docs, found by an independent review: a non-deferrable constraint is checked immediately after every command, and commit-time checking needs DEFERRABLE), so it also protects against bugs and back-office tools.
- **A conditional (partial) constraint**, as in the `WHERE` clause above, lets cancelled rows stay for audit without blocking. This is an optional feature of exclusion constraints. We did not re-read the `CREATE TABLE ... EXCLUDE` page for it in this session, so treat the exact `WHERE` syntax as `[INDUSTRY PATTERN]` and test it on your PostgreSQL version.

### Option B: counted inventory (room type per night) `[INDUSTRY PATTERN]` with documented database behaviour

When there is no specific unit, keep one row per `(room_type, night)` with `capacity` and `sold`:

```sql
UPDATE inventory
   SET sold = sold + 1
 WHERE room_type_id = $1 AND night = $2 AND sold < capacity;   -- 0 rows updated → sold out
```

For a stay of several nights, update all the nights **in a fixed order** inside one transaction (to avoid deadlocks between two overlapping stays) and abort if any row updates zero rows. The **overbooking limit** is just a larger `capacity`, which is a business number. PostgreSQL behaviour that makes this safe `[CONFIRMED]`: under `READ COMMITTED`, if a concurrent updater commits first, "the search condition of the command (the WHERE clause) is re-evaluated to see if the updated version of the row still matches", so the second `UPDATE` sees `sold < capacity` against the new value.

### Option C: serializable isolation + retry `[CONFIRMED]`
Run the availability check and insert inside a `SERIALIZABLE` transaction and retry on failure. The docs: "applications using this level must be prepared to retry transactions due to serialization failures", and a retry handler should treat SQLSTATE **`40001`** generically, "because it will be very hard to predict exactly which transactions might contribute to the read/write dependencies and need to be rolled back". Under `REPEATABLE READ`, a concurrent committed update to the same row yields `could not serialize access due to concurrent update`, and the application "should abort the current transaction and retry the whole transaction from the beginning".

### Option D: hold in a fast store first `[INDUSTRY PATTERN]`
A Redis key `hold:{resource}:{slot}` with `SET ... NX PX <ttl>` can give a cheap first claim, but it is **not** the source of truth. The database constraint still decides. Use it only to reduce contention, and accept that a lost key (restart, eviction) must never allow a double booking.

| Option | Prevents | Handles ranges? | Retry needed? | Best for |
|---|---|---|---|---|
| A. Exclusion constraint | Any overlap on a specific unit | **Yes, natively** | On conflict error | Numbered parking spaces, specific rooms |
| B. Guarded counter | Selling beyond a count | Per night/slot rows | On zero rows or deadlock | Room types, parking zones |
| C. Serializable + retry | Anomalies in complex multi-row logic | Any | **Yes, always** | Rules that don't fit A or B |
| D. Redis hold | Contention only | Per key | n/a | A front line, never the truth |

---

## 4. Hold → pay → confirm

```
search (eventually consistent) ─► choose ─► HOLD (insert row status=HELD, hold_expires = now()+10 min)
                                              │ constraint rejects overlaps; held rows block others
                                              ▼
                                  payment (idempotency key) ─ success ─► CONFIRMED
                                              │ failure / timeout / expiry
                                              ▼
                                  release: status = CANCELLED (frees the range)
```

- **The hold is a real row** inside the exclusion constraint's `WHERE`, so it blocks others. A **sweeper job** (or a check on read) marks expired holds `CANCELLED` `[INDUSTRY PATTERN]`. Treat `hold_expires < now()` as free at query time too, so a slow sweeper does not hide inventory.
- **Pay with an idempotency key.** Stripe `[CONFIRMED]`: the client generates the key (up to 255 characters, V4 UUIDs suggested). For API v1, Stripe saves the status code and body of the first request after execution begins, and retries with the same key return the saved response, "including `500` errors". Keys can be pruned after at least 24 hours. A reused key with **different parameters errors**. Validation failures and concurrent-request conflicts are not saved, so they can be retried. All `POST` requests accept keys, `GET` and `DELETE` do not need them.
- **Consequence for design:** derive the key from `(booking_id, attempt number)`, not a bare `booking_id`. A retry with a different card changes the parameters, which would error under the same key `[INDUSTRY PATTERN]`, inferred from the documented behaviour.
- **Saga, not a distributed transaction:** reserve → pay → confirm, with compensation (cancel the hold, refund) on failure. Use a **transactional outbox** so "booking confirmed" events (email, access code) are not lost if the process dies after commit `[INDUSTRY PATTERN]` (see [04 Message queue](04-message-queue-kafka.md) and [10 Notification system](10-notification-system.md)).
- **Confirm only if the hold is still valid.** The confirm step must re-check `status = 'HELD' AND hold_expires > now()`. A payment that completes *after* the hold expired needs a policy: refund, or try to re-take the slot, and re-check the constraint `[INDUSTRY PATTERN]`.

---

## 5. Availability search vs the booking write path `[INDUSTRY PATTERN]`

- **Search is read-heavy** (many looks per booking). Serve it from a **search index or cache** keyed by location, date range and filters, fed from the inventory DB by change events. It may be seconds stale.
- **Never trust search for the final answer.** The write path re-checks and the constraint decides. A "just sold out" error after a stale search is acceptable, a double booking is not.
- **Shard by property or lot** (`hotel_id`, `lot_id`): all bookings for a unit live in one shard, so the overlap check is a single-shard operation. Cross-property searches fan out to the index, not to the booking shards.
- **Cache availability counts per (unit, night)** with short TTLs, and invalidate on booking changes.

---

## 6. Parking-specific behaviour `[INDUSTRY PATTERN]` unless tagged

- **Extension** is a *new overlapping-check on an adjacent range*: the extended period must also pass the exclusion constraint. If the next slot is taken, the extension must fail or move the car.
- **Overstay:** the car is still there after its `during` ended. The access system detects it at exit. Options are to charge a penalty rate or block the next booking from starting until the space is empty. This is a business policy, and it shows why a pure calendar model is not enough: the physical state (`OCCUPIED`) may differ from the booked state.
- **No-show release:** if nobody enters within a grace period, mark the booking `NO_SHOW` and release the space for walk-ins, according to policy.
- **Pools vs numbered spaces:** pool bookings (counted inventory per time slot) are simpler and survive spaces being out of service. Numbered-space bookings give a guaranteed spot.
- **Dynamic pricing:** price depends on demand, time and duration. Keep the pricing service separate from the inventory core, and **store the price with the booking** so later price changes don't alter it.
- **Time zones and DST:** parking times are absolute instants (store in UTC), but a "day rate" boundary is in the lot's local time. Hotel nights are **local calendar dates**, which is why a `daterange` in the property's time zone fits.

---

## ⚠️ Reviewer notes

1. **`UNIQUE` cannot express "no overlap".** A unique index on `(room, start)` allows overlapping ranges with different starts. This is the most common interview mistake, and PostgreSQL's own docs say `UNIQUE` is "usually unsuitable for range types".
2. **Open vs closed bounds are a bug source.** Two back-to-back stays share a boundary instant. Use `[)` consistently, and pass bounds explicitly for `tstzrange`.
3. **Overbooking is a business decision.** Some hotels intentionally sell beyond capacity to cover no-shows. That is industry practice described in general terms, not something we sourced here. Make the limit a configuration number, and have a defined fallback (relocate the guest). Never overbook numbered parking spaces without a plan.
4. **Distributed locks are not a substitute for the database constraint.** A lock service can expire or be partitioned. Use it for contention reduction only.
5. **A clean `HELD`/`CONFIRMED` model still needs time.** Sweepers lag, clocks differ between servers, and a payment can complete after the hold lapsed. Use the database's `now()` for expiry decisions, not each app server's clock `[INDUSTRY PATTERN]`.
6. **We did not read the PostgreSQL `CREATE TABLE ... EXCLUDE` reference** in this session, so the partial-constraint syntax above needs testing.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited docs. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **data integrity** (no double booking), **reliability**, **availability** of search, **performance** of search vs correctness of booking, **auditability**.
- **Style (Ch 13/17):** a **service-based** split into search, booking (inventory), pricing, payment and notification. The inventory core is deliberately **one strongly consistent, shard-per-property store**, and the rest are event-driven consumers.
- **Quanta (Ch 7):** search can be a separate quantum (eventually consistent, can lag). The booking core plus payment saga is another, and must be correct even when search is stale.
- **Trade-off (First Law, Ch 1):** **consistency vs availability on the write path.** Correctness comes first: a refused booking is better than a double booking, so the write path accepts occasional "retry" errors.
- **ADR sketch (Ch 19):** *"We will enforce no-overlap with a PostgreSQL exclusion constraint on (unit, period) and use guarded counters for pooled inventory. We accept serialization-failure retries and single-shard writes per property."*
- Plain English: the calendar itself refuses to be double-written, so nobody has to be trusted to check first.

---

## Interview questions to practice

1. Two users book the last room for the same night at the same instant. Show exactly how your design stops the second one.
2. Why is a unique constraint on `(room_id, start_time)` not enough? What would you use instead?
3. Design the hold: how long, what status, what expires it, and what happens when payment completes after expiry?
4. Hotel with 40 doubles vs a parking garage with numbered spaces: how do the inventory tables differ?
5. A guest extends their parking by two hours but the next slot is booked. What does the system do?
6. How would you allow controlled overbooking, and what is the fallback?
7. Search says available, booking says sold out. Is that a bug?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: unit or pool, granularity, overbooking, extensions.
2. Estimate: bookings, searches per booking.
3. API: search, hold, confirm, cancel.
4. Design: search index, booking service, inventory DB, payment.
5. Deep dive: exclusion constraints, holds, idempotent payment.
6. Failure and scale: expired holds, late payment, overstay.

**If it grows 10×**
- Search load: a stale index or cache with a final re-check.
- Hot properties: shard by property and keep writes single-shard.
- Retry storms: back off on serialization failures.

**Answer outlines** (try the questions above first)

<details><summary>Two users book the last room at once. How is the second stopped?</summary>

Both insert a HELD booking with overlapping ranges. The exclusion constraint lets one commit and rejects the other, whichever service writes.

</details>

<details><summary>Design the hold.</summary>

A HELD row with an expiry inside the constraint, a payment step with an idempotency key, a sweeper that cancels expired holds, and a confirm that rechecks the hold is still valid.

</details>

<details><summary>Hotel types vs numbered parking spaces?</summary>

Room types are counted inventory per night. Numbered spaces use a range per unit with an exclusion constraint. Parking adds extensions, overstay and no-show release.

</details>

## 📚 Further reading

- PostgreSQL docs: [Range types](https://www.postgresql.org/docs/current/rangetypes.html), [Exclusion constraints](https://www.postgresql.org/docs/current/ddl-constraints.html), [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html), and the [`btree_gist`](https://www.postgresql.org/docs/current/btree-gist.html) extension (linked from the range-types page, not read separately).
- [Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests)
- The earlier [`neokim-post/12` Airbnb / Booking.com note](https://github.com/allmonty/study/blob/main/architecture/neokim-post/12-how-airbnb-works.md) for the hotel flow, estimates, row-lock and version-check options, and the property-count reviewer notes.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [17 Payment system](17-payment-system.md), [10 Notification system](10-notification-system.md), [02 Rate limiter](02-rate-limiter.md).

## Sources and provenance

> **Kind:** reference design, with its key correctness mechanisms sourced to the PostgreSQL and Stripe documentation. Booking.com, Airbnb and parking operators do not publish their reservation internals in enough detail to verify, so the system shape is the standard design `[INDUSTRY PATTERN]`. What **is** verified: how PostgreSQL range types and **exclusion constraints** prevent overlapping bookings, how its isolation levels behave under concurrency, and how payment idempotency keys work.
> **Basis:** generalises [`neokim-post/12` (Airbnb / Booking.com)](https://github.com/allmonty/study/blob/main/architecture/neokim-post/12-how-airbnb-works.md), which covers the hotel flow in depth, to a scheduler that also handles **parking spaces**. This note is about the *inventory and concurrency core*. Payments are covered in [17 Payment system](17-payment-system.md).
> **Sources read on 2026-10-27:** PostgreSQL docs: [Range types](https://www.postgresql.org/docs/current/rangetypes.html), [Constraints (exclusion constraints)](https://www.postgresql.org/docs/current/ddl-constraints.html), [Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html) · [Stripe: Idempotent requests](https://docs.stripe.com/api/idempotent_requests). The earlier note's PostgreSQL locking and Adyen references were verified in its own log and are not re-read here.
> **Tags:** `[CONFIRMED]` stated by the PostgreSQL or Stripe docs · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible, or a business policy choice.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* PostgreSQL and Stripe pages were fetched and quoted.
- Verified in PostgreSQL range-type docs: `UNIQUE` "usually unsuitable for range types"; exclusion constraints "often more appropriate"; the `room_reservation` example with `btree_gist` and `EXCLUDE USING GIST (room WITH =, during WITH &&)`; the error message; `tstzrange` and `daterange` exist; two-argument constructor defaults to `[)`; `int4range`, `int8range` and `daterange` canonicalise to `[)` while `tstzrange` is not listed.
- Verified in the constraints docs: exclusion-constraint definition and that an index is created automatically.
- Verified in the isolation docs: serializable retry requirement and SQLSTATE `40001`; the repeatable-read "could not serialize access due to concurrent update" error and the retry-whole-transaction advice; read-committed re-evaluation of the `WHERE` clause.
- Verified in Stripe's docs: idempotency key behaviour for API v1 (saved status and body including 500s, key length 255, pruning after at least 24 hours, parameter mismatch error, validation and concurrency conflicts not saved, GET and DELETE need no key).
- Not read in this session: the `CREATE TABLE ... EXCLUDE` reference (so the `WHERE (status IN ...)` partial form is marked for testing), the `btree_gist` page, Redis `SET NX PX` semantics, any hotel or parking operator documentation.
- Labelled as industry pattern, not sourced: overbooking practice, hold and sweeper design, search/booking split, parking extension, overstay and no-show behaviour, dynamic pricing, time-zone handling.
- Derived by us from documented behaviour: the "idempotency key = booking id + attempt number" advice follows from Stripe's rule that a changed-parameter retry on the same key errors.
