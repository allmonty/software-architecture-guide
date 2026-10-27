# W01 — Mock interview protocol and scoring rubric

*How to practise a system-design interview alone or with a partner, and how to score it honestly. Everything here is our own method.*

## 1. Why practise this way

Reading designs is passive. The skill an interview tests is producing a design under time pressure, narrating trade-offs and responding to challenges. A repeatable protocol with a rubric lets you see which part is weak (estimation, data model, failure handling, communication) instead of just feeling that it went badly.

## 2. Setup

- **Pick a prompt** you have not studied: use an atlas title (for example "design a notification system") and do not open the note first. After the session, read the note and compare.
- **Timebox 45 minutes** with a visible timer. Use a blank whiteboard or paper, and talk out loud (record audio if alone).
- **Partner role (if any):** answer clarifying questions with numbers you decide in advance, then interrupt twice with a challenge from the list in section 4.

## 3. The 45-minute script

| Minutes | Step | Output you should have |
|---|---|---|
| 0 to 5 | Clarify requirements and scope | 3 to 5 functional requirements, 3 non-functional targets, explicit non-goals |
| 5 to 10 | Estimate | requests per second (average and peak), storage, bandwidth, with stated assumptions ([P01](P01-estimation.md)) |
| 10 to 15 | Interface and data model | main API calls, core entities, the key access pattern |
| 15 to 25 | High-level design | boxes and arrows for the main flow; where state lives; named technologies only when you can justify them |
| 25 to 38 | Deep dive on the one or two hard problems | the mechanism, alternatives, why this one, what it costs |
| 38 to 43 | Failure and scale | what fails, how you detect and recover; what changes at 10 times load |
| 43 to 45 | Summary | restate the design, trade-offs and what you would do next |

The atlas notes' *Interview practice* sections follow the same outline (their six steps, plus a closing summary here).

## 4. Challenges a partner can raise

- "What happens if this component is down for ten minutes?"
- "Your estimate says 50,000 writes per second. How does one database handle that?"
- "Why this database and not that one?" ([P02](P02-storage-engines.md))
- "How do you avoid doing this twice if the client retries?" ([P05](P05-api-design.md), [P03](P03-distributed-transactions.md))
- "What do you monitor, and what is the SLO?" ([P07](P07-slos-and-incidents.md))
- "What does this cost per user?" ([P08](P08-cost-as-a-design-input.md))
- "Where could an attacker get in?" ([P06](P06-security-threat-modeling.md))
- "How would you migrate from the old system?" ([P10](P10-changing-systems-safely.md))

## 5. Scoring rubric (0 to 3 per row)

Score yourself after the session, ideally from the recording, then again a week later.

| Dimension | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Requirements | Starts designing immediately | Lists features only | Adds non-functional targets | Adds non-goals and priorities, confirms with the interviewer |
| Estimation | None | Numbers without assumptions | Correct arithmetic, assumptions stated | Uses results to drive a design decision |
| Interface and data | Skipped | Vague entities | Clear API and entities | Access patterns drive the data model and indexes |
| High-level design | Unclear or a single box | Boxes without flows | Main flow works end to end | Clean separation of state and compute, with a reason for each box |
| Deep dive | Names a technology | Describes it without alternatives | Compares alternatives | Explains the mechanism, trade-offs, and when it breaks |
| Failure and scale | Not covered | Mentions replication | Walks through specific failures | Detects, degrades, recovers, and names the 10 times bottleneck |
| Trade-offs | None stated | States pros only | States pros and cons | Ties each choice to a requirement and says what would change it |
| Communication | Silent or rambling | Follows the template mechanically | Clear, checks in | Adapts to the interviewer, summarises, admits unknowns |

**Interpreting a total (max 24):** below 12, drill the lowest rows with the exercises in [W02](W02-find-the-flaw.md) and [W03](W03-estimation-drills.md); 12 to 18, pick two rows and practise them deliberately; above 18, raise difficulty (shorter time, harder prompt, a partner who interrupts).

## 6. After the session (15 minutes)

1. Read the matching atlas note and write down three things you missed.
2. Re-score using the rubric, and note the single behaviour to change next time (for example "state assumptions before computing").
3. Add any fact you got wrong to your flashcards ([W05](W05-flashcards.md)).
4. Redo the weakest segment only (for example the 10-minute failure discussion) the next day.

## 7. Common mistakes

- Spending 20 minutes on the high-level boxes and none on failure.
- Naming a technology without saying why. "Kafka" is not a reason.
- Treating the first design as final. Interviewers reward noticing a flaw yourself.
- Estimating without using the result.
- Ignoring the interviewer's hints.

**Related:** [README](../README.md) (answer outline), [P01 Estimation](P01-estimation.md), [W02 Find the flaw](W02-find-the-flaw.md), [W05 Flashcards](W05-flashcards.md).

## Sources and provenance

> **Kind:** practice material. The exercises, answer keys and rubrics are **our reasoning** `[INDUSTRY PATTERN]`. Where a fact is sourced it is linked to the atlas note or primer that cites the primary source.
> **Sources:** Exercises and rubrics are our own. Facts they rely on are sourced in the linked atlas notes and primers; each exercise links its evidence.
> **Not read:** Published interview-rubric research and company-specific hiring rubrics.

---
## ✅ Verification log

*Checked 2026-10-27.*
- Nothing in this page makes a factual claim about a system; it is a method and a rubric.
- Links checked by `npm run validate`.
