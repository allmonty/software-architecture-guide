# 21 — Online Game: Matchmaking + Lobby Chat

*Um reference design construído sobre building blocks verificados. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** O matchmaking coleta os jogadores em espera como tickets, forma grupos equilibrados com uma match function, aloca um servidor dedicado pronto e escreve os dados de conexão de volta em cada ticket. O Open Match fornece o framework, o Agones as frotas de servidores, e ratings no estilo TrueSkill acompanham a incerteza. O lobby chat e os eventos de push rodam em shards regionais, como nos designs publicados pela Riot.

**Números principais**
- A alocação do Agones move de forma atômica um servidor Ready para Allocated `[CONFIRMED]`.
- Clusters de chat da Riot com 6–12 nós por região, testados sob carga até 30+ servidores `[CONFIRMED]` (2015).
- O TrueSkill acompanha a incerteza e infere a habilidade individual a partir dos resultados de times `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Janelas de busca que se ampliam com o tempo de espera | Filas limitadas | Partidas menos equilibradas para quem espera muito |
| Frotas de servidores aquecidos | Alocação rápida | Capacidade ociosa |
| Shards regionais | Latência e isolamento | Sem jogo entre regiões por padrão |

**Erros comuns**
- Dizer 'use o Open Match' como se ele escolhesse quem joga contra quem: você é quem escreve a match function.
- Pôr atualizações de rating no caminho crítico da fila.
- Afirmar o matchmaking de um jogo específico a partir destes building blocks.


---

## 🧒 Non-technical explanation

O matchmaking é o **agendador de uma liga esportiva**. Centenas de milhares de jogadores chegam de uma vez e dizem "quero uma partida". O agendador precisa colocá-los rapidamente em **grupos justos e prontos para jogar** (habilidade parecida, perto o bastante para ninguém sofrer lag) e depois **entregar a cada grupo a chave de um campo** (um servidor de jogo). Esperar para sempre por uma partida perfeita é tão ruim quanto uma desequilibrada, então o agendador **afrouxa as regras quanto mais você espera**.

O lobby chat é a **sede do clube** ao lado do campo: os amigos conversam, formam grupos e são avisados "sua partida está pronta". Ele precisa funcionar esteja você jogando ou não, e para cada região por conta própria.

---

## TL;DR for engineers

- **Três trabalhos:** (1) **encontrar** partidas (um matchmaker sobre um pool de jogadores em espera), (2) **iniciá-las** (alocar um servidor de jogo dedicado pronto), (3) **conversar** (chat de lobby/grupo e eventos de push como "partida encontrada").
- **O modelo do Open Match:** um **Game Frontend** cria um **Ticket** por requisição. O **Director** pede ao backend partidas para cada **Match Profile**. Uma **Match Function (MMF)** consulta tickets e devolve **Matches**. Um **Evaluator** opcional deduplica propostas sobrepostas. O Director obtém um servidor de jogo, escreve uma **Assignment** em cada ticket, e o frontend a devolve ao cliente `[CONFIRMED]`.
- **Agones:** servidores de jogo dedicados em Kubernetes. Uma **Fleet** é "a set of warm GameServers that are available to be allocated from". Uma **GameServerAllocation** "atomically allocate[s]" um, o que o move para **Allocated** `[CONFIRMED]`.
- **Skill rating:** o TrueSkill "can be viewed as a generalisation of the Elo system", acompanha a **incerteza** sobre a habilidade de cada jogador, modela empates, lida com qualquer número de entidades competindo e infere habilidades individuais a partir de resultados de **times** `[CONFIRMED]`.
- **Chat na Riot (2015):** XMPP, um **processo de sessão por jogador**, implantado **por região ("shard")**, clusters de 6–12 nós compartilhando apenas algumas tabelas em memória totalmente replicadas `[CONFIRMED]`. O **RMS (2017)** empurra mudanças de estado do servidor aos clientes por WebSockets, com uma camada Edge e uma camada Routing `[CONFIRMED]`.
- **O trade-off central é qualidade da partida vs tempo de espera**, geralmente gerenciado ampliando os critérios de busca à medida que um ticket espera `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** entrar na fila de um modo de jogo (solo ou **grupo**) · achar uma partida com habilidade parecida e latência aceitável · aceitar/recusar ("ready check") · alocar um servidor e conectar · **chat de lobby/grupo** e convites de amigos · atualização de rating após a partida · **backfill** (preencher uma vaga quando alguém sai) · reconectar a uma partida em andamento.

**Não funcionais:** **time-to-match** (segundos a dezenas de segundos) · **qualidade da partida** (justiça) · **escala** para um número muito grande de jogadores concorrentes · **isolamento regional** (latência) · **disponibilidade** (filas e chat no ar nos picos) · **justiça e anti-abuso**.

**Perguntas de esclarecimento:** tamanho do time e modo (1v1, 5v5, battle royale com 100)? A habilidade é oculta (MMR) ou visível no ranking? É permitido jogo entre regiões? Grupos podem misturar tamanhos? Há backfill? Qual é a espera máxima alvo?

---

## 2. Matchmaking with Open Match `[CONFIRMED]` (Open Match docs)

O Open Match se descreve como "an open-source game matchmaking framework that simplifies building a scalable and extensible Matchmaker", dando aos desenvolvedores "full control over how to make matches". A documentação afirma que a **lógica de matching é sua**: "The core matchmaking logic is implemented as a Match Function service." A visão geral não discute rating nem MMR, então as regras de habilidade vivem na sua match function.

| Componente | Papel (do guia do matchmaker) |
|---|---|
| **Game Frontend** | "Receives the matchmaking request from the game client", autentica o jogador, cria a requisição e depois recupera a **Assignment** |
| **Ticket** | "Open Match creates a Ticket and indexes its SearchFields." Cada ticket entra num pool de jogadores que o Open Match considera ativamente |
| **Match Profile** | Define os tipos de partida que o Director pode atender |
| **Match Function (MMF)** | Recebe profiles, consulta os tickets que se encaixam, devolve **Matches** |
| **Director** | "Understands the types of matches (MatchProfiles) that can be served." Pede partidas ao backend, **obtém servidores de jogo do sistema de alocação** e define as Assignments |
| **Evaluator** (opcional) | Match functions concorrentes podem produzir partidas **sobrepostas**, então o evaluator "deduplicate[s] Match proposals before returning results". Um evaluator padrão é fornecido |
| **Backfill** | Listado na navegação da documentação. Não descrito nas páginas que lemos |

**O fluxo:** (1) o frontend pede ao Open Match para criar um Ticket. (2) O Director chama periodicamente `FetchMatches` no backend para um profile. (3) O backend aciona a match function, que consulta tickets e monta um Match. (4) O backend devolve o Match ao Director. (5) O Director pede um servidor de jogo ao sistema de alocação e **cria uma Assignment** com os dados de conexão. (6) Ele chama `SetAssignment` para armazená-la em **todo ticket da partida**. (7) O frontend busca a Assignment e a devolve ao cliente, que se conecta e joga.

**O que o Open Match não te diz** (nossa leitura do que as páginas *não* dizem): se ele mesmo aloca servidores de jogo (o Director usa "the allocation system"), ou como ranquear jogadores. Essas são integrações suas.

---

## 3. Rating players: TrueSkill `[CONFIRMED]`

Do abstract do paper: "We present a new Bayesian skill rating system which can be viewed as a generalisation of the Elo system used in Chess. The new system tracks the uncertainty about player skills, explicitly models draws, can deal with any number of competing entities and can infer individual skills from team results. Inference is performed by approximate message passing on a factor graph representation of the model." Ele apareceu em *Advances in Neural Information Processing Systems 20*. O abstract diz que foi usado "in a large-scale commercial online gaming service under the name of TrueSkill" sem nomear o serviço.

**Por que importa para o design** (nossa leitura, `[INDUSTRY PATTERN]`):
- Um rating é uma **distribuição, não um número**: um jogador novo tem **alta incerteza**, então o sistema pode aprender rápido e o matchmaker pode tratá-lo de forma diferente.
- **Resultados de times** atualizam ratings **individuais**, o que importa para 5v5 e free-for-all.
- A atualização de rating é um **job assíncrono pós-partida** que lê o resultado e escreve os novos ratings. Ela não pertence ao caminho crítico da fila.
- O matchmaker geralmente precisa de **um único número comparável** por jogador. Escolher como combinar média e incerteza (ex.: uma estimativa conservadora) é uma escolha de design que as fontes que lemos não fixam, então declare a sua.

---

## 4. Allocating servers with Agones `[CONFIRMED]`

- "**Agones** is a library for hosting, running and scaling dedicated game servers on Kubernetes." Os recursos incluem executar e atualizar **Fleets** sem desligar servidores de jogo com jogadores ativos, um **SDK** integrado de servidor de jogo para gestão do ciclo de vida e **estratégias de alocação**.
- Um **GameServer** é um custom resource do Kubernetes que cria um **Pod** por trás. As páginas mostram-no chegando a **Ready** ("ready to accept connections") e **Shutdown** ("on the way to being deleted"), e `SDK.Shutdown()` desliga o servidor.
- Uma **Fleet** é "a set of warm GameServers that are available to be allocated from". `replicas` é "the number of GameServers to keep Ready or Allocated". Sob a estratégia de atualização `Recreate`, uma mudança de template "terminates all non-allocated GameServers".
- Uma **GameServerAllocation** "atomically allocate[s] a GameServer out of a set of GameServers" e devolve seus detalhes: **endereço e portas**, mais os nomes do servidor de jogo e do nó. O filtro de estado tem **Ready** como padrão. Uma alocação bem-sucedida define o estado como **Allocated**, "active and should not be removed until SDK.Shutdown() is called or it is manually deleted". Os seletores são uma **lista ordenada**: "If the first selector is not matched, the selection attempts the second selector, and so on."
- **Estratégias de scheduling:** **Packed** (padrão, "aimed at dynamic Kubernetes clusters", faz bin-packing de recursos) e **Distributed** ("aimed at static Kubernetes clusters", espalha pelo cluster).

**Consequência para o design** `[INDUSTRY PATTERN]`: mantenha um **buffer aquecido** de servidores Ready por região e modo para que a alocação seja uma consulta rápida, não um cold start. Faça autoscale da frota pela profundidade da fila e pela razão allocated/ready, e trate "nenhum servidor Ready" como um sinal de back-pressure para o matchmaker.

---

## 5. Lobby and chat: what Riot published `[CONFIRMED]`

### Chat service (2015)
- **Protocolo:** XMPP. Os servidores são escritos "primarily in Erlang" (90% Erlang, 10% C para parsing de XML, SSL e tratamento de strings).
- **Shards regionais:** "We deploy chat services on a per-region basis (we call them 'shards')". Jogadores não podem enviar mensagens entre shards, e os servidores não podem usar dados de outras regiões.
- **Cluster:** cada shard é um cluster de **seis a doze** máquinas, cada nó "fully autonomous and replaceable". Metade dos nós pode ser desligada para upgrades sem interromper o serviço.
- **Tratamento de sessões:** cada cliente que se conecta abre uma conexão TCP persistente e criptografada. Um load balancer escolhe um servidor (round-robin), que cria um **processo `c2s`** Erlang dedicado, segurando o socket, o parser, as listas de amigos e de ignorados, a última presença, o nome e a configuração de rate limit.
- **Estado compartilhado:** os servidores compartilham "only a few internal key-value tables that are fully replicated in-memory" via **Mnesia**, então as consultas de sessão são **leituras locais**. O custo é que toda atualização replica para todos os nós. A Riot diz que testes de carga mostraram clusters de pelo menos **30 servidores** sem degradação.
- **Netsplits:** os nós descartam as entradas de sessão de um nó que perdem e as baixam de novo quando ele volta, então o cluster **se cura sozinho**.
- **Caminho da mensagem:** o `c2s` do remetente valida (rate limit, checagem de spoof, listas de ignorados/amigos), consulta a sessão do destinatário na tabela de roteamento. Se estiver **offline**, a mensagem é **persistida** (MySQL para shards legados, Riak para os novos) até o próximo login. Se estiver online, vai ao processo `c2s` do destinatário por troca de mensagens do Erlang.
- Interfaces **REST internas** expõem coisas como o grafo social a outros serviços.

### Riot Messaging Service (RMS, 2017)
- Um serviço de backend para que outros serviços possam **publicar** mensagens e os clientes **recebê-las**, "specifically designed to handle service to client messaging", filosoficamente "similar to a mobile push notification service".
- **Duas camadas:** o **RMS Edge** hospeda as conexões **WebSocket criptografadas** dos clientes (servidores independentes, então "100% linearly scalable"), e o **RMS Routing** mantém "a global, distributed table mapping player identifiers to RMSE nodes". Os nós de edge informam ao routing cada sessão registrada ou encerrada. O routing também processa mensagens publicadas e acompanha a saúde do edge.
- As mensagens são pequenos documentos JSON nomeando um **resource**, um **service**, uma **version** e **recipients**, opcionalmente com um payload curto. O cliente então busca de novo o estado no serviço dono.
- O post diz que seu objetivo eram servidores capazes de suportar "10 million player connections on a single box" (uma meta na introdução. Não lemos os detalhes).

**O que isso dá a um lobby:** chat (pessoa a pessoa e em grupo), presença ("online no lobby", "numa partida"), convites de grupo e um **canal de push** para os eventos "partida encontrada", "ready check" e "assignment pronta", que são exatamente mensagens de serviço para cliente no estilo RMS `[INDUSTRY PATTERN]` (nossa aplicação do design publicado).

---

## 6. Putting it together `[INDUSTRY PATTERN]` unless tagged

```
Client ──► Game Frontend ──► create Ticket (mode, rating, region latencies, party)  ┐
   ▲                                                                                 │ pool
   │ "match found" / ready check (push)                       Director ◄─────────────┘
   │                                                              │ FetchMatches(profile) → Match Function → Evaluator [CONFIRMED]
Lobby chat + RMS-style push ◄──────────────── Assignment ◄── allocate Ready server (Agones) [CONFIRMED] ◄── Director
   │                                                                  │
   └──────────────► connect to Game Server (UDP, dedicated) ◄──────────┘
After match: result ──► rating service (TrueSkill-style) ──► profile store
```

- **Conteúdo do ticket:** modo de jogo, rating (e incerteza), **latência medida até cada região** (o cliente dá ping nas regiões candidatas), membros do grupo, preferências. Particione as filas por **região e modo**.
- **Match function:** colete tickets compatíveis, forme times e equilibre-os. **Amplie** as janelas aceitáveis de rating e latência à medida que o tempo de espera de um ticket cresce, trocando qualidade por velocidade.
- **Grupos:** case o grupo como uma unidade, usando um rating representativo (ex.: o mais alto ou uma mistura ponderada) e uma regra contra diferenças extremas de habilidade. Ambos são escolhas de política.
- **Ready check:** se alguém recusa, os outros voltam à fila com **prioridade** e o jogador que recusou é penalizado ou removido.
- **Backfill:** quando um jogador sai de uma partida, crie uma requisição de backfill para que o matchmaker possa preencher a vaga.
- **Reconexão:** mantenha a Assignment e o endereço do servidor na sessão do jogador para que ele possa reentrar dentro de uma janela.
- **Isolamento regional:** como os shards de chat da Riot, rode o matchmaker, a frota e o chat de cada região de forma independente, e mantenha assíncronas quaisquer funcionalidades entre regiões.

---

## ⚠️ Reviewer notes

1. **O Open Match é um framework, não um matchmaker.** A lógica de matching ("Match Function") é a parte que você escreve. Dizer "use o Open Match" não responde "como você decide quem joga contra quem".
2. **As fórmulas do TrueSkill não foram lidas.** O texto do PDF não decodificava, então citamos apenas o abstract. Por isso não declaramos como média e incerteza são combinadas, nem qualquer fórmula de qualidade de partida.
3. **Detalhes de resumos de busca não são afirmações.** Uma busca na web descreveu a migração de persistência da Riot do MySQL para o Riak com merge por CRDT para listas de amigos. Lemos o post *Servers*, que menciona MySQL e Riak para armazenamento de mensagens offline, mas não o post *Persistence*, então declaramos só o que o post Servers diz.
4. **As páginas da documentação do Agones são magras em alguns estados.** As páginas que lemos mencionam Ready, Shutdown e Allocated, mas não o ciclo de vida completo (ex.: Scheduled ou RequestReady), então não o listamos.
5. **Não afirme o matchmaking de um jogo específico.** Nenhuma das fontes descreve como um jogo nomeado (League, Valorant, Overwatch, Fortnite) casa jogadores. Elas descrevem os building blocks.
6. **Os números do chat são de 2015.** Os seis a doze nós, os testes de carga com 30 servidores e o número de 1,7M de amizades descrevem o sistema da Riot naquela época.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (time-to-match, latência do chat), **escalabilidade** e **elasticidade** (horários de pico, novos lançamentos), **disponibilidade**, **justiça** (uma qualidade específica do domínio) e **isolamento** entre regiões.
- **Estilo (Ch 13, 14, 17):** **service-based** (frontend, matchmaker, alocação, rating, chat) com um canal de push **event-driven**. O pipeline do Open Match (frontend → director → match function → evaluator) é, ele próprio, um pequeno pipeline.
- **Quanta (Ch 7):** **quanta** por região e por modo. Os shards de chat são quanta separados por design (os shards da Riot). Os servidores de jogo são **quanta efêmeros**, cada um com seu próprio tempo de vida.
- **Trade-off (First Law, Ch 1):** **qualidade da partida vs tempo de espera.** Uma match function mais rígida dá partidas mais justas e filas mais longas. A política de janelas que se ampliam é como você compra tempo.
- **Esboço de ADR (Ch 19):** *"Vamos rodar um matchmaker, uma frota de servidores de jogo e um cluster de chat independentes por região, e ampliar as janelas de rating e latência conforme os tickets envelhecem. Aceitamos que um jogador numa região pequena possa receber uma partida menos equilibrada em vez de esperar."*
- Em linguagem simples: um agendador que relaxa suas regras quanto mais você espera, um campo pronto antes de você chegar e uma sede de clube em cada cidade.

---

## Interview questions to practice

1. Projete o matchmaking para um jogo 5v5. O que vai num ticket, e como a match function forma times equilibrados?
2. Um jogador esperou 90 segundos. O que seu sistema faz de diferente do segundo 5?
3. Como alocar um servidor de jogo em menos de um segundo? E se nenhum estiver Ready?
4. Como tratar um grupo de três que entra na fila com outros dois solos?
5. Alguém sai 30 segundos depois do início da partida. Descreva o backfill.
6. Projete o lobby chat para 1M de usuários concorrentes. Como rotear uma mensagem para um amigo online e para um offline?
7. Por que usar shards regionais para chat e matchmaking, e o que se perde?
8. Como você atualizaria os ratings depois de uma partida em time, e onde isso roda?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: modo, tamanho do time, grupos, regiões, backfill.
2. Estimar: tamanho concorrente da fila e taxa de partidas.
3. API: entrar na fila, ready check, assignment.
4. Design: frontend, pool de tickets, match function, alocação, chat.
5. Deep dive: rating, ampliação, grupos, backfill.
6. Falhas e escala: nenhum servidor pronto, recusas, desconexões.

**Se crescer 10×**
- Tamanho da fila: particione por região e modo.
- Demanda de servidores: faça autoscale da frota aquecida pela profundidade da fila.
- Chat: mais nós por shard com leituras de sessão locais.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Um jogador esperou 90 segundos. O que muda?</summary>

A match function amplia as janelas aceitáveis de rating e latência para aquele ticket, trocando qualidade da partida por tempo.

</details>

<details><summary>Como alocar um servidor em menos de um segundo?</summary>

Mantenha um buffer aquecido de servidores Ready por região e modo, e aloque de forma atômica, tratando um buffer vazio como back-pressure.

</details>

<details><summary>Como os grupos entram na fila?</summary>

Como um único ticket com um rating representativo e uma regra contra diferenças extremas de habilidade, casado como uma unidade.

</details>

## 📚 Further reading

- As fontes listadas no topo. Também as páginas iniciais da documentação do Open Match e do Agones, e [*Chat Service Architecture: Protocol* e *Persistence* da Riot](https://technology.riotgames.com/news/chat-service-architecture-protocol) (o último não lido aqui).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [08 Chat (WhatsApp)](08-chat-whatsapp.md), [09 Discord](09-discord.md) (voz e fan-out em tempo real), [10 Notification system](10-notification-system.md), [15 Uber](15-uber-proximity-dispatch.md) (matching em lotes), [02 Rate limiter](02-rate-limiter.md).

## Sources and provenance

> **Kind:** reference design construído sobre componentes verificados. Os estúdios raramente publicam como seu matchmaker decide *quem joga contra quem*, mas há bom material público sobre as **peças**: o **Open Match** (framework de matchmaking) e o **Agones** (frotas de servidores de jogo em Kubernetes) de código aberto do Google/Unity, o paper de skill rating **TrueSkill** da Microsoft e os posts de engenharia da Riot Games sobre seu **chat service** e seu **messaging service**. O resto (ajuste de filas, tratamento de grupos, ponderação de latência) é prática padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** documentação do Open Match: [Overview](https://open-match.dev/site/docs/overview/) e [Matchmaker guide](https://open-match.dev/site/docs/guides/matchmaker/) · documentação do Agones: [Overview](https://agones.dev/site/docs/overview/), [GameServerAllocation reference](https://agones.dev/site/docs/reference/gameserverallocation/), [Fleet reference](https://agones.dev/site/docs/reference/fleet/), [Create a GameServer](https://agones.dev/site/docs/getting-started/create-gameserver/) · Herbrich, Minka, Graepel, [*TrueSkill: A Bayesian Skill Rating System*](https://www.microsoft.com/en-us/research/publication/trueskilltm-a-bayesian-skill-rating-system/) (NIPS 2006; lemos o abstract da página do Microsoft Research, porque o texto do PDF não decodificava) · Riot Games Tech Blog: [Chat Service Architecture: Servers](https://technology.riotgames.com/news/chat-service-architecture-servers) (2015-09-23) e [Riot Messaging Service](https://technology.riotgames.com/news/riot-messaging-service) (2017-02-28).
> **Not read:** internals de matchmaking de estúdios, material da Blizzard/Valve/Epic, netcode, anti-cheat, o post *Persistence* da Riot (apareceu só num resumo de busca) e as fórmulas do TrueSkill. Não fazemos afirmações sobre esses.
> **Dated material:** os posts da Riot são de 2015 e 2017. A documentação do Open Match mostra a release 1.8.0 e foi modificada pela última vez em 2025-06-17 (um novo "Open Match 2" é referenciado).
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária que lemos · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível, ou uma escolha de ajuste.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Open Match, Agones and Microsoft Research pages were fetched. The two Riot posts were downloaded and read as text.
- Verified in Open Match docs: the framework description, Game Frontend, Ticket and SearchFields, Match Profile, Match Function, Director, optional Evaluator and its default, and the seven-step ticket-to-assignment flow. Backfill is only listed. The overview says nothing about rating or whether it allocates servers. Release 1.8.0 and the 2025-06-17 modification date.
- Verified in Agones docs: the library description, Fleets as "a set of warm GameServers", `replicas` meaning, `Recreate` terminating non-allocated servers, GameServerAllocation atomic allocation, default Ready filter, Allocated semantics, ordered selectors, Packed vs Distributed strategies, response fields. The GameServer page shows Ready and Shutdown only.
- Verified in Microsoft Research's page: the TrueSkill abstract sentences (Elo generalisation, uncertainty, draws, any number of entities, team results, message passing on a factor graph), venue NIPS 20. The abstract does not name Xbox Live or Halo 2, so we do not state them.
- Verified in Riot's *Servers* post (2015-09-23): XMPP, Erlang 90% / C 10%, per-region shards, six to twelve nodes, c2s session processes and their contents, Mnesia-replicated tables with local reads, 30-server load-test claim, netsplit recovery, the message path including offline persistence in MySQL (legacy) or Riak (new shards).
- Verified in Riot's *Messaging Service* post (2017-02-28): the problem, the push-notification analogy, Edge (WebSocket) and Routing (global player-to-node table) tiers, linear scalability of Edge, the message format, and the "10 million player connections on a single box" goal in the intro.
- Removed: any claim about TrueSkill formulas, a specific game's matchmaking, Valorant/Overwatch/Blizzard internals, and the Riot *Persistence* post's contents (read only in a search summary).
- Labelled industry pattern: ticket contents, widening windows, party rules, ready check, backfill and reconnect design, warm-fleet sizing, and the end-to-end architecture sketch.
