# W06 — Review an API: a worked exercise

*A made-up shop API with planted flaws, a review procedure to follow, and an answer key. The skill is the one in [P15](P15-effective-review.md) applied to a contract: find what is hard to undo before clients depend on it.*

## How to use this page

1. Read the spec in section 1 as if it arrived in a pull request for a public API.
2. Do **not** open the answer key. Write down every problem, with a severity (required, optional, nit) and a one-line fix. Use the procedure in section 2.
3. Then read section 3. Score yourself: how many of the eleven findings did you get, and did you rank the authorisation problems first?
4. Finally classify the planned changes in section 4 as compatible or breaking, and compare.

The spec, the findings and the comments are **our exercise** `[INDUSTRY PATTERN]`. Where a rule comes from a primary source it is quoted and linked in the key.

## 1. The spec under review

*Shop API, version 1. Invented for this exercise.*

```
Auth: Bearer token. The token carries user_id and role ("customer" or "staff").

POST   /v1/orders              {items: [{sku, qty}], coupon?}   -> 201 order
GET    /v1/orders              ?page=N&per_page=M               -> 200 [orders]   (every order matching the filters)
GET    /v1/orders/{id}                                          -> 200 order      (any valid token)
PATCH  /v1/orders/{id}         {any order field}                -> 200 order
POST   /v1/orders/{id}/refund  {amount?}                        -> 200
DELETE /v1/orders/{id}                                          -> 204

Order: id (sequential integer), status (created | paid | shipped), total (number),
       currency (default "USD"), customer_id, notes, internal_cost

Errors: always HTTP 200 with {"ok": false, "error": "<text>"}

Planned for v1.1:
  (a) rename total to amount_total
  (b) make shipping_country a required field of POST /v1/orders
  (c) change the default currency from "USD" to the customer's account currency
  (d) add the status value "partially_shipped"
  (e) add an optional field gift_message to POST /v1/orders
```

## 2. The review procedure

Follow the order from [P15 section 2.1](P15-effective-review.md): the broad view first, then the most important part, then the rest.

1. **Broad view.** Who calls this API (browsers, partners, internal jobs) and can you update them? That decides how strict compatibility must be.
2. **The most important part.** For an API that is almost always *who may do what to which object*. Read the authorisation model before the field names.
3. **The data shape.** What can clients read, write and list, and how much can one call cost?
4. **Failure and retry.** What happens on a timeout, a duplicate, an error?
5. **Evolution.** Which of the planned changes would break a client that already exists?

Write comments with labels (`Required`, `Optional`, `Nit`) and give the reason with each.

## 3. Answer key

Open this only after writing your own list.

<details><summary>The eleven findings</summary>

| # | Severity | Finding | Why, and the fix |
|---|---|---|---|
| 1 | Required | `GET`, `PATCH`, `DELETE` and refund by `{id}` accept any valid token. A customer can read or change another customer's order by changing the id. | Broken object level authorization, number 1 in the OWASP API Security Top 10 (2023). OWASP: "Every API endpoint that receives an ID of an object, and performs any action on the object, should implement object-level authorization checks." Fix: check that the order belongs to the caller (or the caller is staff) on every route that takes an id. |
| 2 | Required | `GET /v1/orders` returns "every order matching the filters", which can include other customers' orders. | The same flaw on a collection. Fix: scope the list to the caller's orders unless staff. |
| 3 | Required | Refund and `DELETE` are open to any authenticated user. | Broken function level authorization. OWASP asks: "Can a regular user access administrative endpoints?" Fix: refund and delete need the `staff` role, checked in code, not inferred from the path. |
| 4 | Required | `PATCH` accepts any order field, so a client can set `status`, `total` or `customer_id`. Responses include `internal_cost`. | Broken object property level authorization. OWASP describes two faults under it: exposing properties the user should not read, and letting a user "change, add/or delete the value of a sensitive object's property" (formerly named mass assignment). Fix: an allow-list of writable fields for each role, and a response shape with no internal fields. |
| 5 | Required | `per_page` has no maximum, and `page=N` is offset pagination. | Unrestricted resource consumption: OWASP lists "Number of records per page to return in a single request-response" among the limits an API must set. Fix: a default and a maximum page size, and cursor tokens for a collection that grows (see [P05](P05-api-design.md) and Google's AIP-158: pagination must be there "at the outset"). |
| 6 | Required | `POST /v1/orders` has no idempotency key. A client that times out and retries creates a second order, and a second charge if payment is attached. | Google's AIP-155 and Stripe's design are the model: the client supplies a key and the server returns the first result for a retry. See [P05](P05-api-design.md) and [17 Payment system](../systems/17-payment-system.md). Refund needs the same. |
| 7 | Optional | Errors are always HTTP 200 with `{"ok": false}`. | Clients, caches, proxies and dashboards all read the status code, so every failure looks like success. AIP-193's reason for standard errors: they "enable API clients to construct centralized common error handling logic". Fix: use real status codes and one error shape. |
| 8 | Optional | `total` is a "number". | Money in floating point accumulates rounding error. Fix: integer minor units (cents) with the currency beside it. |
| 9 | Optional | Ids are sequential integers. | They make enumeration easy, but do not present random ids as the fix: OWASP notes "Object IDs can be anything from sequential integers, UUIDs, or generic strings", so the authorisation check in findings 1 and 2 is what protects the data. Opaque ids are an extra, not a replacement. |
| 10 | Optional | No limit on items per order, body size or request rate, and no rate-limit response. | Same OWASP risk as finding 5: execution time, upload size and operations per request are limits to set. See [02 Rate limiter](../systems/02-rate-limiter.md). |
| 11 | Optional | `status` is a closed list in the spec and `currency` has an implicit default. | Both become compatibility problems at the next release; see section 4. |

**Ranking.** A good review puts findings 1 to 4 first: they let one customer act on another's data, and they cannot be fixed later without a behaviour change that some client will notice. Findings 5 and 6 come next, because pagination and retries are costly to add after launch.

</details>

## 4. The planned v1.1 changes

*Classify each as compatible or breaking, then open the key.*

<details><summary>Compatible or breaking?</summary>

The rules are from Google's AIP-180, which assumes consumers in several languages, with no control over how and when they update; if all your clients ship with the server, you may choose stricter or looser rules, but say so.

| Change | Verdict | Reason |
|---|---|---|
| (a) rename `total` to `amount_total` | **Breaking** | AIP-180: "Renaming a component is semantically equivalent to \"remove and add\"", and removing is backwards incompatible. Add `amount_total`, keep `total`, and retire it in a later major version. |
| (b) make `shipping_country` required in `POST /v1/orders` | **Breaking** | "New required fields must not be added to existing request messages or resources." Make it optional with a documented default, or require it in v2. |
| (c) change the default currency | **Breaking** | "Changing the default value is considered breaking and must not be done." Old clients that omit `currency` would suddenly be charged in another currency. |
| (d) add `partially_shipped` to `status` | **Allowed, with caution** | Enums used in responses may gain values, but AIP-180 says "appropriate caution should be used", because client code may not handle a new value. Document that clients must tolerate unknown values before the first release, not after. |
| (e) add optional `gift_message` | **Compatible** | New optional components may be added in the same major version, as long as behaviour without them is unchanged. |

</details>

## 5. Scoring and what to do next

- 8 or more of the 11 findings, with 1 to 4 ranked first: you review APIs the way a security-minded senior would.
- Found only field-level issues (7, 8, 9): re-read the procedure; the authorisation questions come before the data shape.
- Missed the planned changes: redo section 4 using only the quoted rules.

To go on, take a real API spec from your work and write the review as comments with labels, then rewrite the three most serious as a short design note ([P09](P09-decisions-and-design-docs.md)).

**Related:** [P15 Reviewing code and designs effectively](P15-effective-review.md), [P05 API design](P05-api-design.md), [P06 Security for architects](P06-security-threat-modeling.md), [W02 Find the flaw](W02-find-the-flaw.md), [02 Rate limiter](../systems/02-rate-limiter.md), [17 Payment system](../systems/17-payment-system.md).

## Sources and provenance

> **Kind:** practice material. The spec, the findings, their ranking and the scoring bands are **our reasoning** `[INDUSTRY PATTERN]`. The rules the key quotes are `[CONFIRMED]` in the pages below.
> **Sources read on 2026-10-29:** OWASP API Security Top 10 2023: [API1 Broken Object Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization/), [API3 Broken Object Property Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization/), [API4 Unrestricted Resource Consumption](https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption/), [API5 Broken Function Level Authorization](https://api-security.owasp.org/editions/2023/en/0xa5-broken-function-level-authorization/) · Google API Improvement Proposals: [AIP-180 Backwards compatibility](https://google.aip.dev/180), [AIP-193 Errors](https://google.aip.dev/193), [AIP-158 Pagination](https://google.aip.dev/158), [AIP-155 Request identification](https://google.aip.dev/155). Idempotency and pagination detail is in [P05](P05-api-design.md).
> **Not read:** the other OWASP API risks (authentication, business flows, SSRF, misconfiguration, inventory, unsafe consumption), the OpenAPI specification, and any API review checklist from a company.

---
## ✅ Verification log

*Checked 2026-10-29.*
- Quotations in the key were checked against the fetched text of the OWASP pages (API1, API3, API4, API5) and AIP-180 and AIP-193; AIP-158's "at the outset" is as quoted in [P05](P05-api-design.md), which was verified on its own page. The OWASP list of ten risks and their order were read from the edition's index page.
- The compatibility verdicts in section 4 follow AIP-180's own rules; (d) is stated there as allowed with caution, and AIP-180 says its guidance is "indicative" and that some changes need judgment.
- Not sourced (our reasoning): the spec and every flaw in it, the severities, the ranking, the money-as-float and opaque-id advice, and the scoring bands.
- Not claimed: that these flaws occur together in any real API.
