# P09 — Making and recording decisions: ADRs, design docs and boring technology

*A primer on how architects decide, write down and defend decisions. Practices come from Nygard's ADR essay, AWS's ADR guidance, Google's design-doc description and an essay on choosing technology; the worked guidance is our reasoning and is labelled. The book summaries in this repo cover ADRs from Richards and Ford's perspective.*

## At a glance

Most of an architect's output is decisions, and most of the value of a decision is its **reasoning**: the context, the options considered and the trade-offs accepted. Two lightweight artifacts carry that reasoning: the **architecture decision record (ADR)**, which records one decision, and the **design doc**, which proposes a design and invites review. A third idea, choosing "boring" technology, guides how many risky choices to make at once.

**In 60 seconds:** write a one-page ADR for every architecturally significant decision (context, decision, consequences, status); write a design doc when the problem or solution is ambiguous, with goals, non-goals and alternatives considered; never overwrite an old decision, supersede it; and spend a small, deliberate budget of new technology.

---

## 1. Architecture decision records `[CONFIRMED]` (Nygard, 2011; AWS Prescriptive Guidance)

Michael Nygard's essay argues that agile projects need small documents: "Large documents are never kept up to date" and "small, modular documents have at least a chance at being updated." The hardest thing to track is the **motivation** behind decisions; without it a newcomer must either blindly accept a decision (which may be outdated) or blindly change it (which may damage something they cannot see).

His format, kept in the repository: a short noun-phrase **Title**; **Context** (the forces at play, value-neutral and including tensions); **Decision** (full sentences, "We will ..."); **Status** (proposed, accepted, deprecated or superseded with a reference to the replacement); and **Consequences**, which should list the positive, negative and neutral results, because "a particular decision may have positive, negative, and neutral consequences". Rules: ADRs are "numbered sequentially and monotonically"; "if a decision is reversed, we will keep the old one around, but mark it as superseded"; and "the whole document should be one or two pages long", written as a conversation with a future developer.

AWS's guidance adds process: an ADR describes a significant choice, "its context, and its consequences"; the collection forms a **decision log**; "when the team accepts an ADR, it becomes immutable", and a new insight means proposing a new ADR that supersedes the old one. It lists what is architecturally significant, citing Richards and Ford: structure, non-functional requirements, dependencies, interfaces and construction techniques. It notes that recording the reason, not the implementation, makes it easier for others to adopt a decision and "prevents other architects who weren't involved in the decision-making process" from overruling it later.

The repo's chapter summary [19 Architecture decisions](../../fundamentals-of-software-architecture/summaries/19-architecture-decisions.md) covers the same ground from the book.

## 2. Design docs `[CONFIRMED]` (Malte Ubl, "Design Docs at Google")

Design docs are "relatively informal documents" written before coding that record "the high level implementation strategy and key design decisions with emphasis on the trade-offs that were considered". Their functions include early identification of design issues "when making changes is still cheap", achieving consensus, ensuring cross-cutting concerns are considered, scaling senior engineers' knowledge, and forming organisational memory. "Rule #1 is: Write them in whatever form makes the most sense for the particular project." A structure that has proved useful: **context and scope** (objective background, not a requirements document), **goals and non-goals** (non-goals are things that could reasonably be goals but are explicitly not, for example ACID compliance for a database, not negated goals such as 'the system shouldn't crash'), **the actual design** ("the place to write down the trade-offs you made"), **alternatives considered** (the author calls this "one of the most important" sections, because it shows why the chosen design best fits the goals), and **cross-cutting concerns** such as security, privacy and observability, which teams should standardise.

**When not to write one:** it is overhead, and the deciding question is whether the design problem is ambiguous. "A clear indicator that a doc might not be necessary are design docs that are really implementation manuals."

## 3. Choosing technology: innovation tokens `[CONFIRMED]` (Dan McKinley, "Choose Boring Technology")

The essay's model: "every company gets about three innovation tokens"; you can spend them as you like, but the supply is fixed for a long time and people overestimate it. Choosing a language, a datastore or an infrastructure component that is new to you spends a token; writing your own database is a serious warning sign unless that is your business. Boring is not bad: the essay says ‹boring› should not be conflated with ‹bad›, and the benefit of boring technology is that its capabilities and, more importantly, "their failure modes are well understood". The author's examples of boring technologies include MySQL, Postgres, Python, Memcached and cron (as of 2015).

## 4. A working method `[INDUSTRY PATTERN]`

1. **Decide what is decision-worthy:** hard to reverse, affects many teams, or affects a key quality attribute. Everything else, let teams decide.
2. **Frame the decision:** list the driving characteristics (for example latency, cost, consistency, team skills), the constraints, and two or more real options.
3. **Compare options against the characteristics** in a small table; make the trade-off explicit ("we accept X to gain Y").
4. **Write the ADR** after the decision, one page, with consequences including the negative ones and what would make you revisit it.
5. **Socialise early:** circulate the design doc before the meeting; decide who must agree and who is consulted.
6. **Link decisions to evidence:** benchmarks, incident reports (see the [casebook](README.md)), cost estimates ([P08](P08-cost-as-a-design-input.md)).
7. **Revisit on triggers:** scale thresholds, new requirements, cost changes; supersede, do not edit.

**Template for practice:** Title · Context (3 to 5 lines) · Options considered (2 to 3, one line each with their main trade-off) · Decision · Status · Consequences (positive, negative, neutral) · Revisit when.

---

## Questions to practise

1. What goes into an ADR, and why record consequences that are negative?
2. Why must an accepted ADR be immutable, and how do you change a decision then?
3. When would you write a design doc, and when would it be waste?
4. What is a non-goal? Give an example that is not just a negated goal.
5. How do you decide how much new technology a project can afford?

## Practice

Write an ADR for a choice in one atlas system (for example, orchestration versus choreography in a saga, or leveled versus tiered compaction), including two options, the decision, and at least two negative consequences. Then trade ADRs with a colleague and try to overturn the decision by changing one assumption.

**Related:** [P03 Distributed transactions](P03-distributed-transactions.md), [P02 Storage engines](P02-storage-engines.md), [P08 Cost](P08-cost-as-a-design-input.md), the book summaries [19 Architecture decisions](../../fundamentals-of-software-architecture/summaries/19-architecture-decisions.md) and [21 Diagramming and presenting](../../fundamentals-of-software-architecture/summaries/21-diagramming-and-presenting.md).

## Sources and provenance

> **Sources read on 2026-10-27:** Michael Nygard, [*Documenting Architecture Decisions*](https://www.cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011) · AWS Prescriptive Guidance, [Architectural decision record process](https://docs.aws.amazon.com/prescriptive-guidance/latest/architectural-decision-records/adr-process.html) · Malte Ubl, [*Design Docs at Google*](https://www.industrialempathy.com/posts/design-docs-at-google/) · Dan McKinley, [*Choose Boring Technology*](https://mcfunley.com/choose-boring-technology).
> **Dated material:** Nygard's essay is from 2011 and McKinley's from 2015; the practices are stable but tool examples have aged.
> **Not read:** ADR tooling and templates in practice, RFC processes at specific companies, decision-making research, and the full Richards and Ford text beyond the repo's summaries.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in Nygard's essay: the document-size argument, the motivation problem, the record format and rules as quoted.
- Verified in AWS's page: the ADR definition, decision log, immutability and supersession, the scope list, and the reasoning rationale.
- Verified in Ubl's article: the purpose, functions, structure, non-goals description, alternatives section and the when-not-to-write guidance.
- Verified in McKinley's essay: the innovation-token model and the boring-versus-bad passage.
- Not sourced (our reasoning): the working method, the template and the practice exercise.
