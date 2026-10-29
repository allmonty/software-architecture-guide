# W04 — Decision exercises

*Seis cenários de arquitetura que pedem uma decisão e sua justificativa — a parte do trabalho de um arquiteto que casos de design de sistemas raramente praticam.*

## How to use this page

Estes são cenários abertos sem uma única resposta correta. Para cada um, escreva um ADR de uma página ou uma seção de design-doc (template em [P09](P09-decisions-and-design-docs.md)), depois compare com a lista de pontos que uma boa resposta deve cobrir. Uma boa resposta declara premissas, compara opções reais, nomeia o que abre mão e diz o que mudaria a decisão.

## 1. Messaging between services

**Contexto.** Doze serviços internos precisam trocar eventos: pedido criado, pagamento concluído, estoque alterado. O volume é de cerca de 2.000 eventos por segundo, com picos de 20.000. Alguns consumidores precisam repetir o histórico após uma correção de bug. O time tem três engenheiros que já operaram uma fila.

**Tarefa.** Escolha a abordagem de mensageria e escreva o ADR (contexto, opções, decisão, consequências).

<details><summary>What a strong answer covers</summary>

- Distinguishes a queue (consume and delete) from a log (retain and replay) and ties the replay requirement to the choice ([04 Kafka](../systems/04-message-queue-kafka.md)).
- Addresses ordering scope (per key), delivery semantics and idempotent consumers ([P03](P03-distributed-transactions.md)).
- Considers operations and team skill (a managed service versus running brokers) and cost ([P08](P08-cost-as-a-design-input.md)).
- Names consequences: schema evolution, consumer lag monitoring, dead-letter handling.

**A typical weak answer:** Picks a technology by name without a requirement, or ignores replay.

</details>

## 2. Should we split the monolith?

**Contexto.** Um monolito de 10 anos com 60 engenheiros faz deploy semanalmente; as releases são lentas por causa de coordenação e de um banco de dados compartilhado. A liderança propõe migrar para microsserviços em um ano.

**Tarefa.** Argumente a favor ou contra, e proponha o que você faria primeiro.

<details><summary>What a strong answer covers</summary>

- Starts from the problem (deployment coupling, team contention) and the driving characteristics, not the style ([book summaries 17 and 18](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/18-choosing-architecture-style.md), [17 Microservices](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/17-microservices-architecture.md)).
- Considers intermediate options: a modular monolith, service-based architecture, extracting one high-churn capability.
- Proposes an incremental path with a seam, a façade and data ownership ([P10](P10-changing-systems-safely.md)).
- Names costs: distributed transactions ([P03](P03-distributed-transactions.md)), operations, observability, team structure (Conway's law).

**A typical weak answer:** Treats microservices as the goal or dismisses them without evidence.

</details>

## 3. Surviving a region failure

**Contexto.** Uma plataforma de e-commerce funciona em uma região com um banco de dados primário e réplicas. Após uma indisponibilidade, o negócio quer sobreviver à perda de uma região com no máximo 5 minutos de perda de dados e 30 minutos de downtime.

**Tarefa.** Projete a abordagem multi-região e declare o que você abre mão.

<details><summary>What a strong answer covers</summary>

- Turns the targets into RPO 5 minutes and RTO 30 minutes and tests each option against them.
- Compares active-passive with asynchronous replication, active-active with conflict handling, and partitioned ownership; names the consistency trade-offs ([03 Key-value store](../systems/03-distributed-kv-store.md)).
- Plans failover: who decides, automation limits, application latency, reconciliation of unreplicated writes ([C03 GitHub 2018](C03-github-2018.md)).
- Includes rehearsals, cost ([P08](P08-cost-as-a-design-input.md)) and dependencies such as DNS and identity ([C04 Facebook 2021](C04-facebook-2021.md)).

**A typical weak answer:** Says 'use multi-region' without recovery targets, failover decision or data reconciliation.

</details>

## 4. Build or buy semantic search

**Contexto.** Um time de produto quer busca semântica sobre 5 milhões de artigos de suporte em um trimestre. Opções: um banco de dados vetorial gerenciado, uma extensão do Postgres ou construir sobre uma biblioteca ANN de código aberto.

**Tarefa.** Recomende uma opção e declare o gatilho para revisitá-la.

<details><summary>What a strong answer covers</summary>

- Estimates scale (vectors, dimensions, memory) and query rate ([P01](P01-estimation.md), [24 Vector search](../systems/24-vector-semantic-search.md)).
- Considers filtering, freshness, hybrid keyword search and evaluation of retrieval quality ([23 RAG](../systems/23-rag-knowledge-assistant.md)).
- Weighs total cost including people, lock-in, data governance ([P08](P08-cost-as-a-design-input.md)); uses the boring-technology argument where it applies ([P09](P09-decisions-and-design-docs.md)).
- Defines when to change: scale, latency or recall thresholds.

**A typical weak answer:** Chooses on brand familiarity, or builds without justifying the maintenance cost.

</details>

## 5. SLOs for checkout

**Contexto.** Um serviço de checkout depende de um serviço de estoque, de um provedor de pagamento e de um serviço de impostos. O negócio diz que ele deve estar "sempre disponível".

**Tarefa.** Proponha SLIs, SLOs, uma política de error-budget e as mudanças de arquitetura que os alvos exigem.

<details><summary>What a strong answer covers</summary>

- Defines user-centred SLIs (successful checkouts, latency percentile) and explains why 100% is the wrong target ([P07](P07-slos-and-incidents.md)).
- Computes the combined availability of the dependency chain and shows which dependencies need fallbacks or asynchronous paths.
- States an error-budget policy: what happens when the budget is spent.
- Adds protection against cascades: timeouts, bounded retries, load shedding, degraded modes.

**A typical weak answer:** Promises 99.99% without looking at dependencies or cost.

</details>

## 6. An AI feature in the product

**Contexto.** O time de produto quer um assistente que responda às perguntas dos clientes sobre sua própria conta e possa executar ações como cancelar um pedido.

**Tarefa.** Decida entre prompting, retrieval, fine-tuning e um agent para cada parte, e liste os requisitos de segurança e de avaliação.

<details><summary>What a strong answer covers</summary>

- Uses the simplest approach that works for each need: retrieval for account facts ([23 RAG](../systems/23-rag-knowledge-assistant.md)), a constrained workflow or agent for actions ([25 AI agent platform](../systems/25-ai-agent-platform.md)), fine-tuning only for behaviour or format ([28 Fine-tuning](../systems/28-llm-finetuning-evaluation.md)).
- Puts permissions outside the model, approvals on irreversible actions, and treats retrieved text as untrusted ([P06](P06-security-threat-modeling.md)).
- Defines evaluation before launch: retrieval recall, answer groundedness, action success, safety, and a regression suite.
- Estimates cost per conversation and sets budgets and limits ([P08](P08-cost-as-a-design-input.md)).

**A typical weak answer:** Gives the model direct access to the account database, or skips evaluation.

</details>



**Related:** [P09 Decisions and design docs](P09-decisions-and-design-docs.md), [P10 Changing systems safely](P10-changing-systems-safely.md), the book summaries on [architecture decisions](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/19-architecture-decisions.md) and [choosing an architecture style](https://github.com/allmonty/study/blob/main/architecture/fundamentals-of-software-architecture/summaries/18-choosing-architecture-style.md).

## Sources and provenance

> **Kind:** practice material. The exercises, answer keys and rubrics are **our reasoning** `[INDUSTRY PATTERN]`. Where a fact is sourced it is linked to the atlas note or primer that cites the primary source.
> **Sources:** Exercises and rubrics are our own. Facts they rely on are sourced in the linked atlas notes and primers; each exercise links its evidence.
> **Not read:** Published interview-rubric research and company-specific hiring rubrics.

---
## ✅ Verification log

*Checked 2026-10-27.*
- The lists of points are our judgement of what a review would look for; they cite the notes and primers where the supporting facts are sourced.
- Links checked by `npm run validate`.
