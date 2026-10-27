# 25 — AI Agent Platform (Tool Use and a Coding Agent)

*A reference design built on published guidance (Anthropic's "Building effective agents"), a published protocol (the Model Context Protocol) and a published method (ReAct). How it was sourced and what was not checked is under **Sources and provenance** near the end.*

## At a glance

**In 60 seconds.** An agent is a language model that repeatedly decides what to do next, calls a tool (search, run code, edit a file, call an API), reads the result and decides again, until it finishes or hits a limit. A platform for agents needs five things around that loop: a way to **define and call tools** safely, **state** so a long run survives crashes, **sandboxes** where model-written code runs, **limits** on steps, time and money, and **oversight** (approvals, logs, evaluation). The most useful advice from the sources is to use the simplest design that works: a fixed workflow if the steps are known, an agent only if they are not.

**Key numbers** (as published)
- Anthropic separates **workflows** (LLMs and tools "orchestrated through predefined code paths") from **agents** (LLMs that "dynamically direct their own processes and tool usage") `[CONFIRMED]`.
- Agentic systems "often trade latency and cost for better task performance" `[CONFIRMED]`; agents mean "higher costs, and the potential for compounding errors" `[CONFIRMED]`.
- ReAct beat imitation and reinforcement-learning baselines by an absolute 34% and 10% success rate on two interactive benchmarks (ALFWorld, WebShop) with one or two examples in the prompt `[CONFIRMED]`.
- In ReAct's error analysis, 47% of its failures were reasoning errors, including repeating earlier thoughts and actions in a loop `[CONFIRMED]`.

**Decisions and trade-offs**

| Decision | Why | Cost |
|---|---|---|
| Workflow instead of free agent | Predictable, cheaper, easier to test | Cannot handle open-ended tasks |
| A standard tool protocol (MCP) | Reuse tools across hosts and models | A new trust boundary to secure |
| Sandbox for model-written code | A bad command cannot hurt the platform | Cold start time, resource cost, no network by default |
| Persist state each step | A crash resumes instead of restarting | Storage and idempotency work |
| Step, time and cost budgets | Stops runaway loops | Some legitimate tasks stop early |
| Human approval for risky actions | Mistakes are caught before they matter | Slower, needs a good approval UI |

**Common mistakes**
- Starting with a complex agent framework when a single well-prompted call with retrieval would do.
- Treating tool results as trusted instructions. They are data, and may contain injected text.
- No stopping condition: a looping agent burns tokens indefinitely.
- Giving the agent one powerful credential instead of the end user's narrow one.
- Vague tool descriptions. Anthropic reports spending more time optimising tools than the overall prompt in their coding agent.

---

## 🧒 Non-technical explanation

Imagine a **very capable intern working in an office with a locked supply room**. You give them a goal. They think about what to do, ask the supply room for a tool (a search, a calculator, a file), look at the result, and decide the next step. You set rules: they can only use approved tools, must stop after a number of attempts, must ask a manager before anything irreversible like sending money, and write down every step in a logbook. Anything risky, like running an unfamiliar script, happens in a padded room, so a mistake breaks nothing important.

---

## TL;DR for engineers

- **Agent** = an LLM using tools in a loop on feedback from the environment `[CONFIRMED]` (Anthropic).
- **Prefer workflows** (prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer) when the steps are knowable `[CONFIRMED]`.
- **ReAct** interleaves reasoning and actions, which grounds answers in tool results and reduces hallucination, at the cost of loops and rigidity `[CONFIRMED]`.
- **MCP** is a client-host-server protocol on JSON-RPC for exposing tools, with capability negotiation and a recommendation for a human in the loop `[CONFIRMED]`.
- **State, sandbox, budgets, approvals, tracing, evaluation:** the platform concerns `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Functional:** accept a task (chat, ticket, API call) · run a model-driven loop with tools · stream progress · pause for human input · resume after failure · record the full trace.

**Non-functional:** **safety** (no action beyond the user's rights, no escape from the sandbox) · **reliability** of long runs · **cost control** · **latency** (first response soon, tasks may run minutes or hours) · **observability** · **extensibility** (new tools).

**Clarifying questions:** open-ended or well-defined tasks? Which tools, and can any act irreversibly (payments, deletes, emails)? Do tasks run seconds or hours? Multi-tenant? Who approves what? How do we know a run succeeded?

---

## 2. Workflows versus agents `[CONFIRMED]` (Anthropic, December 2024)

Anthropic's post "Building effective agents" groups both under **agentic systems**, but the authors "draw an important architectural distinction" between workflows and agents. Its advice is to find "the simplest solution possible, and only increasing complexity when needed", which "might mean not building agentic systems at all", and that for many applications "optimizing single LLM calls with retrieval and in-context examples is usually enough".

**The building block** is the *augmented LLM*: a model with retrieval, tools and memory.

**Five workflow patterns** the post describes:
1. **Prompt chaining:** a fixed sequence where each call processes the previous output, with programmatic checks (gates) between steps.
2. **Routing:** classify the input and send it to a specialised follow-up, for example easy questions to a smaller model and hard ones to a more capable one.
3. **Parallelization:** sectioning (independent subtasks in parallel) or voting (the same task several times).
4. **Orchestrator-workers:** a central model breaks the task down dynamically and delegates to workers, suited to cases such as multi-file code changes where subtasks cannot be predicted.
5. **Evaluator-optimizer:** one call generates, another evaluates, in a loop, when there are clear criteria and refinement helps.

**Agents** are for open-ended problems "where it's difficult or impossible to predict the required number of steps". They "are typically just LLMs using tools based on environmental feedback in a loop". At each step the agent should get ground truth from the environment (tool results, code execution), can pause for human feedback at checkpoints, and the run often includes "stopping conditions (such as a maximum number of iterations)". The post recommends "extensive testing in sandboxed environments, along with the appropriate guardrails".

**Frameworks.** The post suggests starting with direct LLM API calls because frameworks "often create extra layers of abstraction that can obscure the underlying prompts and responses".

**Tool design (the "agent-computer interface").** Tool definitions deserve as much prompt engineering as the prompts. The post's example: while building its SWE-bench agent, Anthropic "spent more time optimizing our tools than the overall prompt", and found that requiring absolute file paths made the model use the tool "flawlessly" after relative paths had caused mistakes. It also suggests making tools hard to misuse (poka-yoke), keeping formats close to text the model has seen, and avoiding formats that need exact counting or heavy escaping.

**Coding agents** are described as a good fit because solutions are verifiable by automated tests and agents can iterate on test results, but "human review remains crucial for ensuring solutions align with broader system requirements".

---

## 3. The agent loop: ReAct `[CONFIRMED]` (Yao et al., ICLR 2023)

ReAct has the model generate "reasoning traces and task-specific actions in an interleaved manner": reasoning helps "induce, track, and update action plans as well as handle exceptions", and actions let it gather information from external sources.

**Results.** On question answering (HotpotQA) and fact verification (Fever) with a Wikipedia API, ReAct reduced hallucination and error propagation compared with chain-of-thought alone. On ALFWorld and WebShop it beat imitation and reinforcement learning methods by an absolute 34% and 10%.

**Where it is weaker.** The authors found ReAct slightly behind chain-of-thought on HotpotQA (27.4 versus 29.4) and ahead on Fever (60.9 versus 56.3). In a manual study of 50 HotpotQA trajectories each, hallucination was CoT's main failure mode (56% of failures) and zero for ReAct, while ReAct's main failure was reasoning errors (47%), "including failing to recover from repetitive steps". They describe a frequent ReAct-specific pattern in which "the model repetitively generates the previous thoughts and actions". Search that returns nothing useful caused 23% of ReAct's failures.

**Design consequence.** The authors back off from ReAct to another method after a fixed number of steps (7 on HotpotQA, 5 on Fever), because more steps did not help. Our inference, not the paper's: this is the same reason to cap iterations and detect repetition in a production loop.

---

## 4. Tools as a protocol: MCP `[CONFIRMED]` (specification version 2025-06-18)

**Architecture.** MCP "follows a client-host-server architecture where each host can run multiple client instances". The **host** creates and manages clients, enforces security policy and consent, and coordinates LLM integration. Each **client** keeps one stateful session with one server. **Servers** expose resources, tools and prompts, and can be local processes or remote services. The protocol is built on JSON-RPC.

**Isolation principle.** Servers "should not be able to read the whole conversation, nor 'see into' other servers": the full conversation stays with the host.

**Lifecycle.** A session starts with an `initialize` request carrying the protocol version, client capabilities and client information; after the server responds, the client sends an `initialized` notification. Both sides then use only the capabilities they declared. The specification says implementations "SHOULD establish timeouts for all sent requests" and send a cancellation notification when one expires.

**Tools.** Servers that support tools declare a `tools` capability, list them with `tools/list` and invoke them with `tools/call`. Tools are "model-controlled", yet for trust and safety "there SHOULD always be a human in the loop with the ability to deny tool invocations". Tool errors come back as results with `isError: true`, separate from protocol errors. Clients MUST treat tool annotations as untrusted unless they come from trusted servers.

**Security requirements stated for tools.** Servers MUST validate all tool inputs, implement access controls, rate limit tool invocations and sanitise tool outputs. Clients SHOULD prompt for confirmation on sensitive operations, show tool inputs to the user before calling the server to avoid exfiltration, validate results before passing them to the model, time out calls, and log tool use for audit.

---

## 4b. Sandboxing technology: Firecracker `[CONFIRMED]` (Agache et al., NSDI 2020)

Section 5 says model-written code must run in an isolated sandbox. The best-documented example of the isolation technology behind such sandboxes is Firecracker, the virtual machine monitor AWS built for Lambda and Fargate. The paper's framing is the choice an agent platform also faces: "the traditional view is that there is a choice between virtualization with strong security and high overhead, and container technologies with weaker security and minimal overhead", a trade-off the authors call unacceptable for multi-tenant providers. What they built:
- **Design:** keep the Linux KVM hypervisor, but replace QEMU with a new minimal virtual machine monitor, device model and API for **MicroVMs**. About 50k lines of Rust, "96% fewer lines than QEMU", to shrink the attack surface.
- **Performance:** with a minimal guest kernel configuration, "memory overhead of less than 5MB per container", boot to application code in under 125 ms, and creation of up to 150 MicroVMs per second per host.
- **Defence in depth ("jailer"):** Firecracker itself runs inside a restrictive sandbox: a chroot, separate pid and network namespaces, dropped privileges and a seccomp-bpf profile that whitelists 24 syscalls (with argument filtering) and 30 ioctls.
- **Contrast with containers:** containers share the host kernel and rely on cgroups, namespaces, seccomp-bpf and chroot for isolation; a hypervisor boundary is a smaller and stronger interface. The paper discusses the trade-offs at length.

What this gives an interview answer: a concrete reason to put untrusted generated code in a micro-VM rather than a plain container, and real numbers for start-up time and per-sandbox overhead. It does not tell us how any agent product sandboxes code, and the figures are for Firecracker on AWS hardware in 2020.

## 4c. Lessons from a production multi-agent system `[CONFIRMED]` (Anthropic, June 2025)

Anthropic's engineering post on its multi-agent research system adds production detail to section 2. It uses an **orchestrator-worker** pattern: a lead agent plans, saves its plan to memory, and spawns subagents that search in parallel with their own context windows and return condensed findings. Reported points that matter for platform design:
- **Cost:** "agents typically use about 4× more tokens than chat interactions, and multi-agent systems use about 15× more tokens than chats", so the task must be valuable enough to pay for it. Token usage alone explained 80% of the variance in a browsing benchmark (BrowseComp).
- **Quality:** a multi-agent system with a larger lead model and smaller subagents outperformed a single larger agent by 90.2% on their internal research evaluation, strongest on breadth-first tasks; they note most coding tasks have fewer parallelisable parts than research.
- **State and recovery:** "agents are stateful and errors compound"; when errors occur they cannot just restart from the beginning, so they built systems that "resume from where the agent was when the errors occurred".
- **Deployments:** because agents may be anywhere in their process during an update, they use **rainbow deployments**, gradually shifting traffic from old to new versions while both run.
- **Debugging:** agents are non-deterministic between runs, which made production tracing necessary.
- **Limits they report:** lead agents run subagents synchronously, creating bottlenecks (the lead cannot steer subagents and subagents cannot coordinate); early versions made errors such as spawning 50 subagents for simple queries, so effort-scaling rules were embedded in prompts.

These are one company's reported experiences with one product, and the numbers come from its internal evaluations.

## 5. Reference platform `[INDUSTRY PATTERN]`

No vendor publishes its full agent platform, so this is the standard design:

```
user/API ─► session API ─► orchestrator ◄─► LLM gateway (see 22)
                              │  loop: plan → tool call → observe
                              ├──► tool gateway ──► MCP servers / internal APIs (scoped credentials)
                              ├──► sandbox pool (code, shell, browser)
                              ├──► state store (messages, tool results, checkpoints)
                              ├──► approval service ──► human
                              └──► trace + budget service ──► logs, evaluation
```

- **Orchestrator:** runs the loop; each step is persisted before the next starts, so a crashed worker's run is resumed by another worker from the last checkpoint. Make tool calls idempotent or record their results so a retry does not repeat a side effect.
- **LLM gateway:** a shared, rate-limited route to model serving; see [22 LLM inference serving](22-llm-inference-serving.md). Route easy steps to smaller models.
- **Tool gateway:** one place to authenticate tools, apply per-user permissions (use the end user's delegated credentials, not a platform superuser), enforce schemas, rate limits and timeouts, and log calls.
- **Sandbox:** model-written code runs in an isolated container or lightweight VM with no network or an allow-list, resource limits, an ephemeral filesystem and no platform secrets. Cut cold starts with a pool of pre-warmed, unused sandboxes; destroy a sandbox after one run (or reset it fully) and never hand one to a different tenant after use.
- **State and memory:** keep the conversation and tool results; summarise or trim when the context window fills; store long-term memory separately and treat it as data, not instructions.
- **Budgets:** hard caps on steps, tokens, wall-clock time and money per run, with a clear message when hit. Detect repeated identical actions, as ReAct's failure analysis suggests.
- **Approvals:** classify tools by risk (read, reversible write, irreversible or costly) and require human approval for the last class.
- **Prompt injection:** text returned by tools or web pages may contain instructions. Treat it as untrusted data, keep permissions narrow so an injected instruction cannot do much, and require approval for sensitive actions.
- **Long-running tasks:** run asynchronously with a job queue, stream progress by server-sent events or polling, allow cancellation.
- **Observability:** a trace per run (every model call, tool call, result, cost and latency), replayable for debugging.
- **Evaluation:** a task suite with automatic success checks (for coding, the tests), run before changing models, prompts or tools; track success rate, steps and cost per task.

### A coding agent on this platform

Anthropic's diagram of a coding agent shows the loop of reading the task, editing files, running code and tests, and using results as feedback. On the platform: the repository is checked out into a sandbox, tools are `read_file`, `edit_file`, `run_command`, `search`, the test results are the ground truth, a branch or patch is the output, and a human reviews it before merge. The tool set and its documentation matter as much as the prompt.

---

## 6. Failure scenarios

- **Infinite or repetitive loop.** The step cap and a repetition detector stop it `[CONFIRMED]` that the failure exists (ReAct); the mitigations are `[INDUSTRY PATTERN]`.
- **Worker crashes mid-run.** Resume from the last checkpoint; idempotent tools avoid duplicated side effects `[INDUSTRY PATTERN]`.
- **A tool is slow or hangs.** Time out and report an error result to the model (MCP recommends timeouts and cancellation) `[CONFIRMED]` for the protocol guidance.
- **Prompt injection through a tool result.** Narrow permissions, approvals and output validation limit the damage `[INDUSTRY PATTERN]`; MCP says clients should validate tool results `[CONFIRMED]`.
- **Model proposes a destructive action.** Approval gate and dry-run mode `[INDUSTRY PATTERN]`.
- **Sandbox escape or resource abuse.** Isolation, limits, no secrets, short lifetime `[INDUSTRY PATTERN]`.
- **Cost blow-up.** Budgets and alerts `[INDUSTRY PATTERN]`.

---

## 7. Cost reasoning (illustrative)

- Tokens per run grow with steps because each step usually resends the growing history. Ten steps with a context of 20,000 tokens at the end could read on the order of 100,000 input tokens in total, before prompt caching. These numbers are assumptions to show the shape, not measurements.
- Cost per task ≈ input tokens × input price + output tokens × output price + tool and sandbox costs. Prices vary, so state them as assumptions in an interview.
- A published data point on the multiplier: Anthropic reports agents using about 4 times and multi-agent systems about 15 times the tokens of a chat interaction (section 4c).
- Levers: fewer steps (better tools), smaller models for easy steps, prompt caching of the stable prefix, summarising old turns, stopping early.

---

## ⚠️ Reviewer notes

1. **Anthropic's post is guidance from one vendor's experience,** not a benchmark. It contains no measured platform design.
2. **ReAct's numbers are from 2022-era models** (the paper uses PaLM) and specific benchmarks; do not read them as current model performance.
3. **MCP is a living specification.** We read version 2025-06-18; later versions may differ.
4. **Platform pieces (state, sandbox, approvals, budgets, tracing) are industry practice,** not sourced claims. The sandbox policy (no network, no secrets, short lifetime) is our reasoning; Firecracker (section 4b) documents the isolation technology but not agent-specific policy.
5. **Not read:** other agent papers (Reflexion, Toolformer, SWE-agent), agent evaluation benchmarks beyond mentions, vendor agent SDK documentation, gVisor and container isolation documentation.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Our analysis, not from the cited sources. Vocabulary in [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **security**, **reliability** of long runs, **cost control**, **observability**, **extensibility**.
- **Style (Ch 13):** **orchestration-driven service-based:** a central orchestrator coordinating tool, model and sandbox services.
- **Quanta (Ch 7):** sandboxes and tool servers are separate quanta with their own failure and security boundaries; the orchestrator is the stateful coordinator.
- **Trade-off (First Law, Ch 1):** **autonomy vs control.** More model freedom handles open-ended work and raises cost, risk and unpredictability.
- **ADR sketch (Ch 19):** *"We will implement known task shapes as workflows and use a looping agent only for open-ended tasks, behind step, time and cost budgets and approvals for irreversible actions. We accept lower flexibility in exchange for predictability."*
- Plain English: an intern with a rulebook, a padded room and a logbook.

---

## Interview questions to practice

1. Design a platform that runs AI agents using tools. What is the core loop?
2. When would you use a fixed workflow instead of an agent?
3. How do you make a long-running agent survive crashes?
4. How do you run code that a model wrote?
5. How do you stop an agent from looping or spending too much?
6. How do you keep a tool result from hijacking the agent (prompt injection)?
7. How do you evaluate an agent, for example a coding agent?
8. What is MCP, and what are the security concerns of connecting third-party tools?

## Interview practice

These outlines are our own reasoning (`[INDUSTRY PATTERN]`), not statements from the cited sources.

**A 45-minute walkthrough**

1. Clarify: task types, tools and their risk, duration, tenants, approval needs.
2. Estimate: runs per day, steps per run, tokens per step, sandbox concurrency.
3. API: create run, stream events, approve or reject an action, cancel, fetch trace.
4. Design: session API, orchestrator, LLM gateway, tool gateway, sandbox pool, state store, approval service, tracing.
5. Deep dive: the loop and checkpointing; sandboxing; permissions and approvals.
6. Failure and scale: worker crash, loops, slow tools, injection, cost; scaling sandboxes.

**If it grows 10×**
- Sandbox capacity and cold starts: pools of pre-warmed unused sandboxes and snapshots of a clean base image, never of a used sandbox.
- Model cost: route steps to smaller models, cache prefixes, trim context.
- Observability volume: sample traces, store full detail for failures.

**Answer outlines** (try the questions above first)

<details><summary>How does a long-running agent survive a crash?</summary>

Persist the conversation, tool results and step number after every step. A new worker loads the last checkpoint and continues. Tool calls are idempotent or their results are stored, so a retry returns the recorded result instead of repeating a side effect.

</details>

<details><summary>How do you run model-written code safely?</summary>

In an isolated, short-lived sandbox with no network or an allow-list, limited CPU, memory and time, an ephemeral filesystem, and no platform credentials. The sandbox returns output only; anything that leaves it goes through the tool gateway.

</details>

<details><summary>How do you handle prompt injection?</summary>

Assume tool and web content is hostile. Keep the agent's permissions narrow so an injected instruction has little power, validate tool results, separate data from instructions in the prompt, and put irreversible actions behind human approval.

</details>

## 📚 Further reading

- The three sources listed under Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) for tool use basics.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secondary).
- Related in this repo: [22 LLM inference serving](22-llm-inference-serving.md), [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [10 Notification system](10-notification-system.md) and [17 Payment system](17-payment-system.md) for idempotency and retries.

## Sources and provenance

> **Kind:** reference design with real parts. The workflow and agent guidance, the MCP protocol and the ReAct method are published. How any vendor runs an agent platform is not, so the platform in section 5 is the standard design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Schluntz and Zhang, Anthropic, [*Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents) (19 December 2024; read through an Internet Archive copy) · Model Context Protocol, specification version 2025-06-18: [Architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture), [Lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) and [Tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) · Yao et al., [*ReAct: Synergizing Reasoning and Acting in Language Models*](https://arxiv.org/pdf/2210.03629) (ICLR 2023; PDF text extracted locally) · Agache et al., [*Firecracker: Lightweight Virtualization for Serverless Applications*](https://www.usenix.org/system/files/nsdi20-paper-agache.pdf) (NSDI 2020; PDF text extracted locally) · Anthropic, [*How we built our multi-agent research system*](https://www.anthropic.com/engineering/multi-agent-research-system) (June 2025; read through an Internet Archive copy).
> **Dated material:** guidance from December 2024, a protocol version from June 2025 and a 2022 paper. This field changes quickly.
> **Not read:** other agent research and benchmarks, vendor agent SDKs, gVisor and container isolation documentation.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source in full. Quotations are confirmed by `npm run verify`.*
- Verified in Anthropic's post: workflow and agent definitions, simplicity advice, the five workflow patterns, agent loop description, stopping conditions, sandbox and guardrail recommendation, framework caution, tool-design advice including absolute file paths and time spent on tools, coding agent verification by tests and human review.
- Verified in the MCP specification (2025-06-18): client-host-server architecture, host and client responsibilities, isolation principle, initialize and initialized handshake, timeout recommendation, tools capability and `tools/list`, `tools/call`, human-in-the-loop recommendation, `isError`, untrusted annotations, server and client security requirements.
- Verified in the ReAct paper: abstract claims, 34% and 10% gains, HotpotQA and Fever comparisons (27.4 vs 29.4, 60.9 vs 56.3), Table 2 failure shares (47%, 23%, 56%), repetition pattern, back-off at 7 and 5 steps.
- Verified in the Firecracker paper: the isolation trade-off statement, KVM with a replacement minimal VMM, about 50k lines of Rust (96% fewer than QEMU), under 5 MB memory overhead, boot under 125 ms, 150 MicroVMs per second per host, the jailer's chroot, namespaces, privilege drop and seccomp profile (24 syscalls, 30 ioctls).
- Verified in Anthropic's multi-agent post: the 4 times and 15 times token figures, 80% variance explained by token usage, 90.2% internal evaluation gain, resume-from-error and rainbow-deployment statements, synchronous-subagent limitation.
- Labelled industry pattern, not sourced: orchestrator state and checkpointing, tool gateway and credentials, sandbox design, budgets, approvals, injection defences, async execution, observability, evaluation harness, cost arithmetic.
- Not claimed: how any specific vendor's agent product is built.
