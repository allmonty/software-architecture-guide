# 03 — Distributed Key-Value Store (Dynamo-style)

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** O Dynamo é um key-value store sempre gravável. Ele posiciona as chaves num anel de consistent hashing com virtual nodes, replica cada chave em N nós e deixa você ajustar R e W. As escritas sobrevivem a falhas por meio de sloppy quorum e hinted handoff, os conflitos são detectados com vector clocks e reconciliados na leitura, e as réplicas convergem por read repair e anti-entropy com Merkle trees.

**Números principais**
- (N,R,W) = (3,2,2) é o comum `[CONFIRMED]`.
- Exemplo de SLA no percentil 99,9: 300 ms a 500 requisições/s `[CONFIRMED]`.
- 99,9995% de respostas bem-sucedidas nos dois primeiros anos, sem nenhum evento de perda de dados `[CONFIRMED]` (relato dos próprios autores).

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Sloppy quorum + hinted handoff | As escritas têm sucesso durante falhas | Garantias mais fracas: um 'quorum' pode incluir substitutos |
| Vector clocks, reconciliação no cliente | Nenhuma atualização perdida em silêncio | A aplicação precisa fazer o merge das versões |
| Zero-hop routing | Sem variação de latência de vários saltos | Todo nó precisa guardar o mapa do anel |

**Erros comuns**
- Dizer 'DynamoDB' e depois descrever os vector clocks do paper de 2007: são sistemas diferentes.
- Presumir que R+W>N significa consistência forte sob um sloppy quorum.
- Usar last-write-wins sem reconhecer que ele descarta uma de duas escritas concorrentes.


---

## 🧒 Non-technical explanation

Imagine uma **biblioteca sem bibliotecário-chefe**. Os livros (chaves) são atribuídos a estantes ao longo de um corredor circular por uma regra fixa, e cada livro é guardado em **três** cópias, em três estantes consecutivas. Qualquer bibliotecário pode receber seu pedido, e todos conhecem o mapa, então ninguém precisa perguntar a um chefe.

Se uma estante está fechada para reparos, o bibliotecário põe sua cópia na **próxima estante aberta com um post-it** ("pertence à estante A, devolver quando reabrir"). Dois visitantes podem, às vezes, atualizar cópias diferentes ao mesmo tempo. Em vez de recusar um deles, a biblioteca **guarda as duas versões** e deixa que uma pessoa (ou uma regra) faça o merge depois. Essa escolha, *nunca recusar uma escrita*, é toda a personalidade do sistema.

---

## TL;DR for engineers

- **Objetivo:** um key-value store "always writeable" que continua disponível durante falhas e partições, com a latência julgada no **percentil 99,9**, não na média `[CONFIRMED]` (paper §2.2, §4.5).
- **Particionamento:** consistent hashing com **virtual nodes** (tokens), de modo que a carga se espalha de forma uniforme e os nós podem ter capacidades diferentes `[CONFIRMED]` (§4.2).
- **Replicação:** cada chave é armazenada em **N** nós (sucessores no sentido horário, em nós físicos distintos). Uma leitura precisa de **R** respostas, uma escrita precisa de **W**. R + W > N dá um sistema parecido com quorum. A configuração comum era **(N,R,W) = (3,2,2)** `[CONFIRMED]` (§4.3, §6).
- **Disponibilidade sob falha:** um **sloppy quorum** mais **hinted handoff** mantém as escritas funcionando quando uma réplica está fora `[CONFIRMED]` (§4.6).
- **Conflitos:** **vector clocks** detectam versões concorrentes. As leituras podem devolver várias, e o **cliente** reconcilia `[CONFIRMED]` (§4.4). Alguns serviços da Amazon usaram, em vez disso, **last-write-wins por timestamp** `[CONFIRMED]` (§6).
- **Reparo:** **anti-entropy com Merkle trees** para divergência permanente e **read repair** de forma oportunista `[CONFIRMED]` (§4.7, §5). O **gossip** espalha a membership `[CONFIRMED]` (§4.8).
- **Zero-hop routing:** todo nó sabe o bastante para rotear uma requisição direto aos donos, evitando a variação de latência dos DHTs de vários saltos `[CONFIRMED]` (§2/§4).

---

## 1. Requirements (as Dynamo's authors state them)

| Requisito | Detalhe | Fonte |
|---|---|---|
| Acesso simples | Key-value, blobs identificados por chave, sem operações com vários itens, sem schema relacional, objetos "usually less than 1 MB". A API é `get(key)` / `put(key, context, value)` | §2.1 `[CONFIRMED]` |
| Consistência fraca aceita | Abre mão do "C" do ACID quando isso compra disponibilidade | §2.1 `[CONFIRMED]` |
| Always writeable | Ex.: o carrinho de compras deve aceitar adições mesmo durante falhas | §2.3 `[CONFIRMED]` |
| SLA de latência na cauda | O SLA de exemplo do paper: uma resposta em **300 ms para 99,9%** das requisições num pico de 500 requisições/s | §2.2 `[CONFIRMED]` |
| Escalabilidade incremental | Adicionar um nó por vez | §2.3 `[CONFIRMED]` |
| Simétrico, descentralizado | "Every node in Dynamo should have the same set of responsibilities as its peers" (simetria), com a descentralização como sua extensão. Os seeds existem só para descoberta | §2.3 e §4.8 `[CONFIRMED]` |

**Resultados de produção relatados** (paper §6, "past two years" em 2007): respostas bem-sucedidas para **99,9995%** das requisições e **nenhum evento de perda de dados até o momento** `[CONFIRMED]` (os números são afirmações dos autores sobre o próprio sistema naquela época).

---

## 2. Partitioning: the ring with tokens `[CONFIRMED]` (§4.2)

O consistent hashing simples mapeia cada nó para um ponto no anel. A variante do Dynamo dá a **cada nó muitos pontos ("tokens")**, de modo que:
- quando um nó sai, sua carga é **espalhada entre os nós restantes**,
- quando um nó entra, ele pega uma **fatia aproximadamente igual de cada** um dos outros,
- máquinas mais fortes podem receber **mais tokens** (heterogeneidade).

O paper compara três estratégias de posicionamento de tokens (§6.2). A **Strategy 3** (Q partições de tamanho igual, Q/S tokens por nó) deu a **melhor eficiência de balanceamento de carga**, reduziu os dados de membership que cada nó carrega **em três ordens de grandeza** em comparação com a Strategy 1, e foi a que a Amazon adotou na migração.

A documentação do Cassandra descreve a mesma ideia (virtual nodes) e diz que eles "solve the problem by assigning multiple tokens in the token ring to each physical node" `[CONFIRMED]` (Cassandra docs).

---

## 3. Replication and quorums

```
ring:  A ── B ── C ── D ── E ── F ──┐
       └────────────────────────────┘
key k hashes between A and B → coordinator B, copies on C and D (N = 3)
preference list for k = [B, C, D, + extra nodes in case of failures]
```

- **N réplicas** por chave, escolhidas como o coordenador mais seus N−1 sucessores no sentido horário, **pulando posições para que todos sejam nós físicos distintos** `[CONFIRMED]` (§4.3).
- A **preference list** contém mais de N nós para dar conta de falhas `[CONFIRMED]`.
- **R** = mínimo de respostas para uma leitura, **W** = mínimo de acks para uma escrita. **R + W > N** dá um comportamento parecido com quorum. R e W costumam ser definidos **abaixo de N** porque a latência é determinada pela mais lenta das R (ou W) réplicas `[CONFIRMED]` (§4.5).
- **(3,2,2)** era a configuração comum `[CONFIRMED]` (§6). Outros padrões que o paper cita: R=1, W=N para serviços de muita leitura que funcionam como um "high performance read engine", e W=1 para máxima disponibilidade de escrita, embora "most Amazon services in production set a higher W" `[CONFIRMED]`.
- **Entre datacenters:** a preference list é construída para que as réplicas fiquem **espalhadas por vários data centers**, de modo que a perda de um data center inteiro não cause uma indisponibilidade `[CONFIRMED]` (§4.6).
- **Coordenador de escrita:** qualquer um dos N primeiros nós pode coordenar uma escrita, escolhido como o nó que **respondeu mais rápido à leitura anterior**. Os autores dizem que usar sempre o primeiro nó causou carga desigual e violações de SLA `[CONFIRMED]` (§5).

---

## 4. Surviving failures

### Sloppy quorum and hinted handoff `[CONFIRMED]` (§4.6)

As operações vão para "the first N healthy nodes from the preference list", que podem não ser os N primeiros do anel. Com N=3, o exemplo da Figure 2 do paper é: se o nó A está fora do ar durante uma escrita, a réplica que normalmente viveria em A vai para D com um **hint** que nomeia A. (Em geral o substituto é o próximo nó saudável depois dos N primeiros da preference list: com cópias em B, C e D, como no nosso exemplo de anel acima, uma falha de C mandaria a réplica dele para E com um hint nomeando C.) O D guarda as réplicas com hint num store separado, varre esse store periodicamente e devolve os dados quando A volta. Isso evita que leituras e escritas falhem por falhas temporárias, ao preço de garantias mais fracas, porque o "quorum" pode incluir nós que não são os donos habituais.

### Anti-entropy with Merkle trees `[CONFIRMED]` (§4.7)

O hinted handoff falha quando o nó com o hint também some. Para pegar divergências duradouras, cada nó mantém uma **Merkle tree por faixa de chaves** (uma hash tree cujas folhas são hashes de chaves individuais). Duas réplicas comparam as raízes e depois descem só pelos ramos que diferem, então pouquíssimos dados são transferidos.

### Read repair `[CONFIRMED]` (§5)

Depois que uma leitura retorna, o coordenador espera um pouco pelas outras respostas. As réplicas que devolveram versões desatualizadas recebem a mais recente. Isso "relieves the anti-entropy protocol from having to do it".

---

## 5. Versioning and conflicts

As atualizações se propagam de forma assíncrona, então um `get` pode devolver dados desatualizados (**eventual consistency**) `[CONFIRMED]` (§4.4).

**Vector clock** = lista de pares `(node, counter)` anexada a cada versão. Se todo contador do clock X é ≤ o contador correspondente do clock Y, então X é um **ancestral** de Y e pode ser descartado. Caso contrário, elas são **concorrentes** e ambas precisam ser mantidas `[CONFIRMED]`.

O exemplo resolvido do paper (Figure 3):

| Passo | Handler | Versão | Clock |
|---|---|---|---|
| Write | Sx | D1 | [(Sx,1)] |
| Update | Sx | D2 (sobrescreve D1) | [(Sx,2)] |
| Update | Sy | D3 | [(Sx,2),(Sy,1)] |
| Outro cliente lê D2, atualiza | Sz | D4 | [(Sx,2),(Sz,1)] |
| D3 e D4 são **concorrentes** → as leituras devolvem ambas | | | |
| O cliente faz o merge, Sx coordena | Sx | D5 | [(Sx,3),(Sy,1),(Sz,1)] |

**Truncamento do clock:** cada par carrega um timestamp. Quando um clock passa de um limite ("say 10"), o **par mais antigo é removido**. Os autores reconhecem que isso pode quebrar a detecção de descendentes, mas dizem que o problema "has not surfaced in production" `[CONFIRMED]` (§4.4).

**Quem reconcilia?** O paper lista três modos de uso `[CONFIRMED]` (§6): **reconciliação pela lógica de negócio** no cliente (o carrinho de compras faz o merge das versões), **last-write-wins baseado em timestamp** (informações de sessão) e a configuração de **high-performance read engine** descrita acima.

**A escolha diferente do Cassandra** `[CONFIRMED]` (Cassandra docs): "Cassandra uses a simpler last-write-wins model where every mutation is timestamped", sem vector clocks. É mais simples de usar, e descarta em silêncio uma de duas escritas concorrentes.

---

## 6. Membership, discovery and routing `[CONFIRMED]` (§4.8)

- **Entradas e saídas são explícitas**, feitas por um administrador por meio de uma ferramenta. A mudança é persistida com o seu horário. Um **protocolo de gossip** espalha as mudanças de membership: cada nó contata um peer aleatório **a cada segundo** e os dois reconciliam seus históricos.
- As atribuições de tokens viajam do mesmo modo, então todo nó sabe quais peers são donos de quais faixas e pode **encaminhar uma requisição diretamente** (zero-hop).
- Os **seeds**, conhecidos de todos os nós por config ou por um serviço de configuração, evitam anéis logicamente particionados.
- A **detecção de falhas** é local: um nó percebe que um peer está inalcançável quando as próprias requisições falham. O paper diz que um desenho inicial e descentralizado de detector de falhas, que mantinha uma visão global das falhas, mostrou-se depois desnecessário, dado o join/leave explícito.
- O Cassandra, em contraste, roda um **Phi Accrual failure detector** em cada nó e faz gossip das informações de bootstrap do cluster uma vez por segundo `[CONFIRMED]` (Cassandra docs).

---

## 7. Implementation notes `[CONFIRMED]` (§5)

Cada nó tem três componentes: **coordenação de requisições**, **membership e detecção de falhas** e um **mecanismo de persistência local**. Escrito em Java. A camada de coordenação é orientada a eventos (estilo SEDA) e cria **uma máquina de estados por requisição de cliente**. Os storage engines eram plugáveis: Berkeley DB Transactional Data Store, BDB Java Edition, MySQL, ou um buffer em memória com um store persistente por trás. A maioria das instâncias em produção usava o BDB Transactional Data Store, escolhido pelo perfil de tamanho dos objetos (BDB para objetos tipicamente de "tens of kilobytes", MySQL para os maiores).

---

## 8. Cassandra vs the paper (per Cassandra's own docs) `[CONFIRMED]`

| Tópico | Paper do Dynamo | Cassandra |
|---|---|---|
| Tratamento de conflitos | Vector clocks, reconciliação no cliente (ou LWW por serviço) | Last-write-wins sobre um timestamp por mutação |
| Controles de consistência | (N,R,W) por instância | Consistency levels `ONE`, `QUORUM`, `ALL`… por requisição. Forte quando `W + R > RF` |
| Caminho de escrita | O coordenador envia para os N nós alcançáveis de maior ranking e espera W | "Write operations are always sent to all replicas, regardless of consistency level" |
| Reparo | Anti-entropy com Merkle trees | Merkle trees, mais reparo por sub-range e incremental, que segundo a documentação o paper não tem |
| Modelo de dados | Key-value opaco | "A storage interface that is more sophisticated" do que um key-value simples |
| Posicionamento em produção | N/A | Docs: "All production deployments should use the `NetworkTopologyStrategy`" |

---

## ⚠️ Reviewer notes

1. **"Dynamo" é um nome sobrecarregado.** As respostas de entrevista costumam dizer "como o DynamoDB" e depois descrevem vector clocks e reconciliação no cliente. Isso vem do **paper de 2007**. Não verificamos o que o serviço DynamoDB faz internamente, então não o afirme.
2. **"Consistent hashing" sozinho não dá balanceamento.** A própria evolução do paper (Strategy 1 → 3) mostra que tokens aleatórios simples produziram um balanceamento pior e um estado de membership maior. Diga "virtual nodes com partições de tamanho igual" se perguntarem dos detalhes.
3. **A flexibilidade de R/W do paper costuma ser reduzida a "sistema AP".** Os autores dizem que os clientes ajustam N, R, W para trocar disponibilidade, durabilidade e consistência, e que "low values of W and R can increase the risk of inconsistency". É um botão de ajuste, não um ponto fixo.
4. **Os números medidos são dos próprios autores e vêm de hardware de 2006–2007** (os números de latência foram tirados de um sistema (3,2,2) em produção com "a couple hundred nodes"). Não os cite como desempenho atual.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não do paper. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **disponibilidade** (always writeable), **escalabilidade** (incremental), **performance na cauda** (percentil 99,9), **durabilidade**. A **consistência** é a que foi deliberadamente sacrificada.
- **Estilo (Ch 9–10):** **peer-to-peer / shared-nothing**, **sem camada de coordenação**. O mais próximo entre os estilos do livro é o pensamento **space-based** (dados particionados e replicados entre unidades de processamento, Ch 15), sem um data grid central.
- **Quanta (Ch 7):** um quantum **por anel**: todo nó é simétrico e compartilha o mesmo destino quanto à membership.
- **Trade-off (First Law, Ch 1):** **disponibilidade vs consistência.** O Dynamo empurra a resolução de conflitos para o momento da leitura e para a aplicação. O custo é a complexidade na aplicação, que os autores reconhecem.
- **Esboço de ADR (Ch 19):** *"Vamos aceitar escritas com um sloppy quorum e reconciliar na leitura. Aceitamos que os clientes possam ver versões desatualizadas ou conflitantes e precisem fornecer a lógica de merge."*
- Em linguagem simples: a biblioteca nunca recusa um livro, e o preço é que às vezes você recebe duas versões para juntar você mesmo.

---

## Interview questions to practice

1. Descreva `put(k, v)` com N=3, W=2 quando uma réplica está fora do ar. Para onde vai a terceira cópia?
2. R=1, W=1, N=3: o que pode dar errado? O que muda com R=2, W=2?
3. Dois clientes atualizam a mesma chave ao mesmo tempo por coordenadores diferentes. Mostre os vector clocks e o que a próxima leitura devolve.
4. Por que não usar sempre last-write-wins? Dê um caso em que ele perde dados.
5. Um nó ficou fora do ar por um dia. Como ele se atualiza (hints, read repair, anti-entropy)?
6. Por que gossip, e o que pode dar errado com um anel "logicamente particionado"?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: disponibilidade vs consistência, tamanho dos objetos, escala.
2. Estimar: chaves, fator de replicação, número de nós.
3. API: `get(key)` e `put(key, context, value)`.
4. Design: anel com virtual nodes, preference list, coordenador.
5. Deep dive: quorums, hinted handoff, vector clocks.
6. Falhas e escala: perda de nó, divergência permanente, adição de nós.

**Se crescer 10×**
- Mais nós significam mais estado de gossip: mantenha os dados de membership compactos (as partições de tamanho igual fizeram isso).
- Hot keys: o tráfego de uma única chave não se espalha só com hashing. Respostas comuns (raciocínio nosso, não do paper do Dynamo): dividir ou aplicar salt a uma hot key em várias subchaves e fazer o merge na leitura, servir leituras de caches ou de réplicas de leitura extras e coalescer no cliente requisições idênticas concorrentes. Ajustar N, R e W muda os trade-offs de consistência e latência; não cura uma hot key.
- Multi-datacenter: espalhe a preference list entre os sites.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Descreva um put com N=3, W=2 e uma réplica fora do ar.</summary>

O coordenador escreve localmente, envia aos outros nós alcançáveis, e um nó substituto fica com a cópia da réplica que está fora, junto com um hint. Dois acks atendem W, então o cliente recebe sucesso. O substituto devolve a réplica na recuperação.

</details>

<details><summary>Por que não usar sempre last-write-wins?</summary>

Ele descarta em silêncio uma de duas escritas concorrentes. O merge do carrinho de compras precisa das duas. Os vector clocks detectam a concorrência para que a aplicação possa fazer o merge.

</details>

<details><summary>Um nó ficou fora por um dia. Como ele se atualiza?</summary>

As réplicas com hint são entregues primeiro, o read repair corrige réplicas desatualizadas de forma oportunista, e o anti-entropy com Merkle trees repara divergências duradouras a baixo custo.

</details>

## 📚 Further reading

- [Dynamo paper (SOSP 2007)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Cassandra docs: Dynamo](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html)
- [Amazon DynamoDB, ATC '22](https://www.usenix.org/conference/atc22/presentation/elhemali) (o serviço, não o sistema de 2007)
- [System Design Primer: key-value store for a search engine, and the real-world architecture list](https://github.com/donnemartin/system-design-primer) (secundária)
- Relacionado neste repositório: [`neokim-post/04` Kafka](https://github.com/allmonty/study/blob/main/architecture/neokim-post/04-how-apache-kafka-works.md) para replicação via ISR, uma abordagem diferente para a mesma questão de disponibilidade/consistência.

## Sources and provenance

> **Kind:** real-system. Este é o design do paper do Dynamo da Amazon, de 2007, comparado com o que a documentação do Apache Cassandra diz que ele manteve e mudou.
> **Sources read on 2026-10-27:** [DeCandia et al., *Dynamo: Amazon's Highly Available Key-value Store*, SOSP 2007](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf) (texto completo, 16 páginas) · [Apache Cassandra docs: Dynamo](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html) · [USENIX ATC '22, *Amazon DynamoDB: A Scalable, Predictably Performant, and Fully Managed NoSQL Database Service*](https://www.usenix.org/conference/atc22/presentation/elhemali) (apenas o abstract).
> **Not the same thing:** *Dynamo* (o paper de 2007, um sistema interno da Amazon) e *DynamoDB* (o serviço da AWS lançado em 2012 `[CONFIRMED]` pelo abstract do ATC '22) são sistemas diferentes que compartilham um nome e algumas ideias. Esta nota descreve o paper. Não lemos o paper do DynamoDB por inteiro, então não afirmamos nada sobre como os dois diferem internamente.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão, sem autoridade única · `[SPECULATIVE]` escolha de design plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27. The paper text was extracted from the PDF and each quoted claim was located in it.* No claim was changed, and four were softened or scoped (listed last).
- Verified in the paper: 99.9th-percentile SLA rationale and the 300 ms/500 rps example; "always writeable"; zero-hop DHT; virtual nodes and their three advantages; preference list with distinct physical nodes; R/W definitions and R+W>N; coordinator replicates to N−1 successors; sloppy quorum and hinted handoff mechanics with the A/D example; multi-datacenter preference lists; Merkle trees per key range; read repair; vector-clock rules, the Figure 3 example (re-derived by hand), truncation threshold "say 10"; gossip every second and reconciliation of membership histories; seeds; local failure detection; the three §6 usage modes; (3,2,2); Strategy 3 findings; 99.9995% and "no data loss event"; storage engines and Java implementation; write coordinator choice by fastest previous read.
- Verified in the Cassandra docs: tokens/vnodes quote; `NetworkTopologyStrategy` advice; `ONE`/`QUORUM`/`ALL`; `W + R > RF`; writes always sent to all replicas; LWW; Merkle trees; sub-range and incremental repair; Phi Accrual failure detector and one-second gossip; the stated differences from the paper.
- Verified in the ATC '22 abstract: DynamoDB launched in 2012.
- Softened: any statement on how DynamoDB's internals differ from Dynamo was **not made**, because the abstract does not say.
- Softened: the Figure 4 latency chart was **not quoted numerically**, since only the caption was read, not the plotted values.
- Scoped: the 99.9995% figure is attributed to the authors' own report for their first two years, not stated as a property of the design.
- Scoped: Architecture lens is explicitly our analysis.
