# P15 — Reviewing code and designs effectively

*A primer on how to review a change: what the review is for, the order to read in, how to write comments, and how the job changes when an AI wrote the code. The rules come from Google's published code review guide and GitHub's guidance on AI-generated code; the worked examples and checklists are our own and are labelled.*

## At a glance

A review has one job: make sure the codebase is no worse after the change than before, without blocking people from making progress. Do it in a fixed order (does the change make sense, then the main part and its design, then the rest), read every line a human wrote, write comments that say why and how much they matter, and approve once the change clearly improves things even if it is not perfect. Reviewing AI-generated code is the same job with less trust: the author cannot explain why a line is there, the studies we read found weaker security and more confidence, and the usual failure is code that looks right.

**In 60 seconds:** (1) read the description and ask whether the change should exist; (2) read the most important file first and send design problems at once; (3) check tests as hard as code, because tests do not test themselves; (4) label each comment Nit, Optional, FYI or required; (5) approve when code health improves; (6) for AI code, run the checks first, verify every name and dependency, and watch for deleted or skipped tests.

---

## 1. What a review is for `[CONFIRMED]` (Google, The Standard of Code Review)

Google's guide says the primary purpose of code review is that the overall code health of the codebase improves over time. Its rule for approval is "In general, reviewers should favor approving a CL once it is in a state where it definitely improves the overall code health of the system being worked on, even if the CL isn't perfect" (a CL is a change list, Google's word for a change). Two limits keep that from becoming a rubber stamp: reviewers should not approve changes that "definitely worsen the overall code health" except in an emergency, and a reviewer may refuse a feature they do not want in the system even if it is well built.

- **Perfect is not the bar.** The guide: "there is only better code". Polish that is not important is labelled `Nit:` so the author may ignore it.
- **Facts beat taste.** "Technical facts and data overrule opinions and personal preferences." The style guide is the authority on style, and aspects of software design are "almost never a pure style issue".
- **Do not stall.** If author and reviewer cannot agree, try consensus first, then escalate (a tech lead, a maintainer, a manager). The guide's instruction: do not let a change sit because of the disagreement.
- **Speed is part of quality.** "One business day is the maximum time it should take to respond to a code review request." The guide counts the time to the first response, not the time to merge, and says slow reviews push people to submit worse changes and skip cleanups.

## 2. How to review, in order

### 2.1 Read in this order `[CONFIRMED]` (Google, Navigating a CL in review)

1. **Take a broad view.** Read the description and ask whether the change makes sense at all. If it should not exist, say so at once and, courteously, say what to do instead, so nobody builds on it.
2. **Look at the most important part first.** The guide's summary: "Look at the most important part of the change first." If you see major design problems there, send those comments immediately, even before reviewing the rest, because the rest may be rewritten and the author may already be building on top.
3. **Then the rest, in a sensible sequence.** Often the order the tool shows is fine. Sometimes it helps to "read the tests first before you read the main code", because they show what the change is meant to do.

If the change is too big to tell which part is the main one, ask the author what to read first or to split it. The author's guide says the right size is "one self-contained change", about 100 lines is usually reasonable and about 1,000 usually too large, and the reviewer decides. Tests belong in the same change as the logic they cover.

### 2.2 What to look for `[CONFIRMED]` (Google, What to look for in a code review)

| Area | The question to ask |
|---|---|
| Design | Do the pieces fit together? Does this belong in this codebase or in a library? Is now the time? |
| Functionality | Does it do what the author intended, and is that good for users? Think through edge cases and concurrency. |
| Complexity | Can a reader understand it quickly? Is anything over-built for a need that may never come? |
| Tests | Are they correct, and would they fail if the code broke? The guide: "Tests do not test themselves". |
| Naming and comments | Names say what the thing is; comments say why, not what. |
| Style and consistency | Follow the style guide; where it is silent, match the surrounding code. |
| Documentation | Update the docs that the change makes wrong. |
| Every line | "look at every line of code that you have been assigned to review" (generated code and data files may be scanned). |
| Context | Look at the change in the whole file and the wider system, and "Don't accept CLs that degrade the code health of the system". |
| Good things | Say what is good. Reviews that only list mistakes teach less. |

### 2.3 Let tools do what tools do `[INDUSTRY PATTERN]`

Our reasoning, consistent with both guides: formatting, lint rules, type errors, known-vulnerable dependencies and coverage gaps should be caught by CI before a person looks. A reviewer's time is for design, intent, edge cases, tests that prove nothing and risk, which tools cannot judge. If you keep writing the same comment, ask whether a check should say it instead.

## 3. Writing comments `[CONFIRMED]` (Google, How to write code review comments)

The guide's summary: "Be kind. Explain your reasoning." Its points:

- **Comment on the code, not the person.** The guide's pair of examples: "Why did you use threads here when there's obviously no benefit to be gained from concurrency?" is bad; saying the concurrency model adds complexity without a visible performance benefit, so single-threaded is better, is good. Its advice is "making comments about the code and never making comments about the developer" when the point may upset.
- **Label severity.** `Nit:` is minor, `Optional (or Consider):` is a good idea but not required, `FYI:` is for the future. The guide's reason: "without comment labels, authors may interpret all comments as mandatory".
- **Guide, do not design.** "In general it is the developer's responsibility to fix a CL, not the reviewer's." Point out the problem and let the author decide when that teaches more, give a direct suggestion when that helps more.
- **If you do not understand it, the code is unclear.** Asking for an explanation should usually lead to clearer code, not a reply in the review tool that future readers never see.
- **Praise specifically.** The guide: "people learn from reinforcement of what they are doing well and not just what they could do better".

## 4. Tutorial A: reviewing human-written code `[INDUSTRY PATTERN]`

*Our worked example. The change and the comments are invented; the method is section 2.*

The pull request is titled *Add coupon codes to checkout*. The description says it applies a percentage discount when a code is given. The diff:

```python
 def checkout(cart, user, coupon_code=None):
     total = sum(i.price * i.qty for i in cart.items)
+    if coupon_code:
+        coupon = db.query("SELECT * FROM coupons WHERE code = '%s'" % coupon_code)
+        if coupon:
+            total = total - total * coupon.percent / 100
     charge(user, total)
     return create_order(cart, user, total)
```

It adds one test, named *applies a 10 percent coupon*.

**Step 1, broad view.** Coupons are a real requirement, the description says what the change does, and the size is small. Continue.

**Step 2, the main part.** The new block in `checkout` is the whole change, so read it for design before details. One design question comes first: pricing rules are now inside the function that charges the card, so the next rule (expiry, minimum basket) will land here too.

**Step 3, the comments**, in the order a reviewer would send them:

| Label | Comment | Why |
|---|---|---|
| Required | The query builds SQL from `coupon_code` with string formatting, so a crafted code can change the query. Please use a parameterised query. | Input from the client reaches the database. This is the kind of thing a security scanner may also flag, but do not rely on it. |
| Required | What stops `percent` above 100, an expired coupon, or a single-use coupon redeemed by two requests at once? Today none of these is checked. | Functionality: edge cases and concurrency. A redemption count needs a conditional update, the same guarded-counter idea as in [note 16](../systems/16-reservation-scheduler.md). |
| Required | The test only covers the happy path and would still pass if the discount were applied twice. Please add unknown code, expired code and over-100 cases, and assert the exact total. | Tests do not test themselves: ask whether the test would fail when the code breaks. |
| Optional | Money is computed with division on what may be a float. Consider integer cents. | Not required to ship this change if the codebase already does it this way. |
| Optional | Consider moving the discount into a pricing function so `checkout` only charges. | The design question above, offered rather than demanded. |
| Nit | `coupon` could be `found`; there is a `coupons` table in scope. | Polish. |
| Praise | Good that this is one small change with its test. | Reinforces the habit. |

**Decision.** Request changes: three required items. After they are fixed, approve even if the optional ones stay open, as Google's standard says. If the author pushes back on a required item, answer with the reason (a defect, not a preference), and escalate only if that fails.

## 5. Tutorial B: reviewing AI-generated code

### 5.1 What the evidence says `[CONFIRMED]`

- **Perry et al. (CCS '23).** In a user study with 47 participants doing five security-related programming tasks in Python, JavaScript and C, with an assistant based on OpenAI's `codex-davinci-002`, "participants who had access to an AI assistant based on OpenAI's codex-davinci-002 model wrote significantly less secure code than those without access", and they "were more likely to believe they wrote secure code than those without access to the AI assistant". The abstract adds that participants who trusted the AI less and engaged more with their prompts wrote code with fewer vulnerabilities. Measured on a 2022 model; the finding that matters for review is overconfidence.
- **Fu et al. (arXiv 2310.02059, version of February 2025).** Of the code from GitHub Copilot, CodeWhisperer and Codeium found in public GitHub projects, "Our analysis identified 733 snippets, revealing a high likelihood of security weaknesses, with 29.5% of Python and 24.2% of JavaScript snippets affected", across 43 weakness categories. This is a static-analysis result on snippets labelled as generated, so it measures likelihood, not exploitable bugs. The same paper reports that Copilot Chat could fix up to 55.5% of the flagged issues when given the analyser's warnings, which supports running the tools first.
- **GitHub Docs, "Review AI-generated code".** The practice list below.

What the studies do not say: that a given model today is worse than a person on a given task. They say the habit of trusting the output is the risk.

### 5.2 The practice list `[CONFIRMED]` (GitHub Docs)

GitHub's guide for reviewing AI-generated code says, in its own words:

1. "Always run automated tests and static analysis tools first." Check it compiles, tests pass, and there are no new warnings.
2. Verify context and intent: does the code "solve the right problem" and follow your conventions?
3. Assess quality: readability, maintainability and clear naming still matter.
4. Scrutinize dependencies: check that suggested packages exist and are maintained, review licences, and watch for packages that do not exist, and for slopsquatting, which the page calls "a theoretical attack on LLMs using fake or malicious packages". It adds "it is good practice to always verify suggested packages yourself".
5. "Look for hallucinated APIs, ignored constraints, or incorrect logic. Watch for tests that are deleted or skipped, instead of fixed."
6. Use collaborative review for complex or sensitive changes, and automate what you can in CI.

### 5.3 How the job changes `[INDUSTRY PATTERN]`

Our reasoning, built on the two sources above and on section 2:

| | Human-written change | AI-generated change |
|---|---|---|
| Who can explain a line | The author | Nobody, unless the author understood it before accepting it |
| What to read first | The description, then the main part | The request that produced it, then the diff for scope: did it touch only what was asked? |
| Typical failure | A missed edge case | Plausible code that matches the pattern but not the intent, invented names, a failing test removed instead of fixed |
| Tests | Check that they would fail on a bug | The same, plus check they were not weakened or deleted to go green |
| Dependencies | Usually discussed | Check every new one by hand |
| Trust | Earned over time | Treat it as a change from an unknown contributor |
| Accountable | The author | Still the human who submits it: that an AI wrote it is not an answer in review |

A short procedure: (1) ask what was requested and read that first; (2) run tests, linters and scanners, and read their output; (3) check scope, then check every external name and dependency exists and is what you expect; (4) read the tests as hard as the code; (5) read every line as if a stranger wrote it; (6) if the change is too large to hold in your head, reject it and ask for smaller slices, as Google asks of human authors.

### 5.4 A worked example `[INDUSTRY PATTERN]`

*Invented. The task given to an assistant was "make `test_refund_is_idempotent` stop failing". The package name is made up for the example.*

```python
-def test_refund_is_idempotent():
-    ...
+# TODO flaky, removed

+from retryx import retry          # new dependency

+@retry(times=5)
 def refund(order_id):
     try:
         provider.refund(order_id)
-    except ProviderError:
-        raise
+    except Exception:
+        pass
```

| Finding | Why it matters |
|---|---|
| The failing test was deleted | The request was to stop the failure, not to remove the check. GitHub's list names this one: "tests that are deleted or skipped, instead of fixed". The test was probably telling the truth. |
| `except Exception: pass` | Errors are now swallowed, so a failed refund looks like a successful one. This is data loss for the customer and for the books. |
| `@retry(times=5)` on a refund | Retrying a money-moving call without an idempotency key can refund five times. See [P05](P05-api-design.md) and [17 Payment system](../systems/17-payment-system.md). |
| `retryx` is new | Does it exist, who maintains it, what licence? "Always verify suggested packages yourself." |
| The diff is bigger than the request | A one-line symptom became a new dependency and a changed error path. Scope is the first check. |

**Decision.** Reject, with a comment that explains why and what would be acceptable: restore the test, find why it fails (the flakiness is the finding), and fix idempotency with a key at the provider call.

## 6. Reviewing a design or an API

The same order works: does it need to exist, what is the main decision, then the details. For an API, the details are the choices that are hard to undo: pagination from the first version, safe retries, compatibility rules, authorisation on each object and field, and limits on what one call may cost. [P05](P05-api-design.md) holds the rules, [P06](P06-security-threat-modeling.md) the threat view, and W06 (a worked review with an answer key, in the next commit) is planned.

## 7. Review habits that fail `[INDUSTRY PATTERN]`

Our list, each the reverse of something the sources ask for: approving without reading ("LGTM" must mean "this code meets our standards", in the guide's words); a flood of nits that hides the one real problem; design comments sent after three rounds of line comments; reviewing a 2,000-line change in one pass; arguing taste when a fact or a style guide would settle it; answering a question about unclear code with a reply in the tool instead of clearer code.

## Interview questions to practice

1. What is the standard for approving a change, and when may a reviewer still say no?
2. In what order do you read a large change, and why send design comments first?
3. You are asked to review a 1,500-line change from a teammate. What do you do?
4. Label these comments: a missing null check, a variable name, a suggestion to extract a helper, a link to a future refactor.
5. What do you check first when the change was generated by an assistant?
6. A test was deleted in the same change that fixes a bug. What do you ask?
7. How do you review an API change that renames a field?

## Practice

Take one open pull request in a repository you know, or a change you made last month. Read it in the order of section 2.1, write the comments with labels, and decide approve or request changes. Then take a change an assistant produced for you and run the procedure in 5.3; list what you would not have caught by skimming.

**Related:** [P05 API design](P05-api-design.md), [P06 Security for architects](P06-security-threat-modeling.md), [P09 Decisions and design docs](P09-decisions-and-design-docs.md), [W02 Find the flaw](W02-find-the-flaw.md), W06 Review an API, [C02 Cloudflare, July 2019](C02-cloudflare-2019.md) (a change that passed code review and CI and still caused an outage).

## Sources and provenance

> **Sources read on 2026-10-29:** Google engineering practices, the code review guide: [The Standard of Code Review](https://google.github.io/eng-practices/review/reviewer/standard.html), [What to look for in a code review](https://google.github.io/eng-practices/review/reviewer/looking-for.html), [Navigating a CL in review](https://google.github.io/eng-practices/review/reviewer/navigate.html), [Speed of code reviews](https://google.github.io/eng-practices/review/reviewer/speed.html), [How to write code review comments](https://google.github.io/eng-practices/review/reviewer/comments.html), [Small CLs](https://google.github.io/eng-practices/review/developer/small-cls.html) · GitHub Docs, [Review AI-generated code](https://docs.github.com/en/copilot/tutorials/review-ai-generated-code) · Perry, Srivastava, Kumar and Boneh, [Do Users Write More Insecure Code with AI Assistants?](https://arxiv.org/abs/2211.03622) (CCS '23; read in full text) · Fu et al., [Security Weaknesses of Copilot-Generated Code in GitHub Projects](https://arxiv.org/abs/2310.02059) (read in full text, abstract and method sections).
> **Dated material:** the Google guide describes Google's own practice; its GitHub repository is archived (last push 2024-09-19, read through the GitHub API on 2026-10-29) while the site is still served. Perry et al. measured a 2022 model. Fu et al. measured tools as of its data collection. GitHub's page is a snapshot of 2026-10-29 and changes. Nothing here is a claim about current model quality.
> **Not read:** Google's author-side pages other than small changes, GitHub's Copilot code-review responsible-use page, research on review effectiveness (defect-finding rates, review size studies), static-analysis tool documentation, and any vendor claim about AI code quality.
> **Tags:** `[CONFIRMED]` stated by a primary source we read · `[INDUSTRY PATTERN]` standard practice or our own reasoning, including every worked example. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-29, by reading each source in full. Quotations are confirmed by `npm run verify`.*
- Verified in the Google pages: the approval standard and its limits, "there is only better code", facts over opinions, the escalation advice, the one-business-day response time, the three-step reading order and the tests-first suggestion, the review checklist items and their quotations, the severity labels and the reason for them, the guidance and praise points, the size advice (one self-contained change; about 100 lines reasonable and 1,000 too large).
- Verified in the GitHub Docs page: the six practices and the quoted sentences, including the slopsquatting wording.
- Verified in Perry et al.: 47 participants, five tasks, Python, JavaScript and C, `codex-davinci-002`, and the two findings quoted. Verified in Fu et al.: 733 snippets, 29.5% and 24.2%, 43 weakness categories, the tools covered, and the 55.5% figure for fixes with warnings supplied.
- Checked through the GitHub API on 2026-10-29: the Google engineering practices repository is archived.
- Not read: the items listed under Not read above.
- Not sourced (our reasoning): both worked examples and every comment in them, the human versus AI comparison table, the AI review procedure, the habits that fail, and the advice to let CI catch what tools can catch.
- Labelled: "the diff is bigger than the request" and "treat it as a change from an unknown contributor" are our framing of GitHub's guidance on context and intent, not its words.
