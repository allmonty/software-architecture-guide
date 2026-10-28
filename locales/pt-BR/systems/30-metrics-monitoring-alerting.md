# 30 — Metrics Monitoring and Alerting

*Partes de real-system do paper Gorilla do Facebook (2015), do paper Monarch do Google (2020) e da documentação do Prometheus, mais um reference design que as combina. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um sistema de monitoramento coleta medições numéricas (contagens de requisições, latências, CPU) de muitas máquinas, as armazena como séries temporais, deixa os engenheiros consultá-las e plotá-las e dispara alertas quando algo está errado. Sua própria regra de design é incomum: ele precisa ser **mais disponível que as coisas que observa**, então os sistemas publicados **trocam consistência e completude por disponibilidade**: aceitam descartar um pouco de dado em vez de bloquear. As outras grandes ideias são **comprimir as séries temporais** para que os dados recentes caibam em memória, **controle de cardinalidade** (toda nova combinação de labels é uma nova série) e **um pipeline de alertas** que avalia regras e depois agrupa, deduplica e roteia as notificações.

**Números principais** (como publicados, com o ano)
- Gorilla (Facebook, 2015): mais de 2 bilhões de séries temporais únicas, cerca de 12 milhões de pontos por segundo, mais de 1 trilhão de pontos por dia `[CONFIRMED]`.
- O Gorilla comprimiu um ponto de 16 bytes para uma média de 1,37 byte, uma redução de 12 vezes; cerca de 96% dos timestamps comprimem para um único bit `[CONFIRMED]`.
- O Gorilla guardava as últimas 26 horas em memória porque pelo menos 85% das consultas ao seu predecessor eram para essa janela `[CONFIRMED]`. A latência de consulta caiu 73 vezes e o throughput subiu 14 vezes frente a um store apoiado em HBase `[CONFIRMED]`.
- O Monarch (Google, 2020) guarda perto de um petabyte de dados comprimidos em memória, ingere terabytes por segundo e atende milhões de consultas por segundo `[CONFIRMED]`; até 95% das suas standing queries rodam inteiramente dentro de uma zona `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Manter os dados recentes em memória | A maioria das consultas é sobre o último dia; velocidade e poucas dependências | Custo de RAM; o histórico precisa de outro store |
| Comprimir as séries temporais (delta-of-delta, XOR) | 12 vezes menos memória | Custo de CPU, exige um design amigável a streaming |
| Descartar dados em vez de bloquear escritas | O monitoramento precisa continuar no ar quando o resto cai | Pequenas lacunas nos dados |
| Avaliar alertas perto dos dados | Os alertas continuam funcionando durante partições | Alertas entre regiões são mais difíceis |
| Agrupar, deduplicar e inibir alertas | Uma queda deve acionar uma vez, não milhares | Mais configuração, risco de esconder um alerta real |

**Erros comuns**
- Pôr valores ilimitados (IDs de usuário, IDs de requisição) em labels. Cada combinação vira uma nova série.
- Fazer o sistema de monitoramento depender dos sistemas que ele monitora (a dependência circular que o Monarch evita).
- Alertar em cada instância em vez do sintoma, causando tempestades de alertas.
- Usar um store de monitoramento para contagens exatas de faturamento. A documentação do Prometheus diz que ele não é uma boa escolha quando você precisa de 100% de exatidão.

---

## 🧒 Non-technical explanation

Imagine um **hospital com um posto de enfermagem observando os monitores cardíacos de mil pacientes**. Cada monitor envia um número a cada poucos segundos. O posto mantém na tela apenas o último dia porque é o que as pessoas olham, e arquiva as leituras mais antigas em outro lugar. Ele prefere perder uma batida no gráfico a congelar a tela inteira. Quando um número cruza uma linha de perigo por tempo suficiente, um alarme soa; se cinquenta pacientes de um andar o disparam ao mesmo tempo porque faltou energia, o posto envia **uma** mensagem "o andar 3 tem um problema de energia" em vez de cinquenta ligações.

---

## TL;DR for engineers

- **Modelo de dados:** uma série temporal é identificada por um nome de métrica e labels; cada nova combinação de labels é uma nova série `[CONFIRMED]` (Prometheus).
- **Coleta:** pull (o Prometheus faz scrape por HTTP; push via um gateway para jobs de curta duração) ou push para ingestion routers (Monarch) `[CONFIRMED]`.
- **Storage:** dados recentes em memória com compressão mais um log e blocos periódicos em disco `[CONFIRMED]` (Gorilla, Prometheus).
- **Disponibilidade acima da consistência:** descarte escritas atrasadas, devolva dados parciais, replique para uma segunda região sem garantir consistência `[CONFIRMED]`.
- **Alertas:** regras avaliadas periodicamente (com um estado pending antes de disparar), depois um alert manager agrupa, deduplica, inibe, silencia e roteia `[CONFIRMED]` (Prometheus).
- **Scale-out, camadas de retenção, multi-tenancy:** do Monarch e da prática do setor `[CONFIRMED]` / `[INDUSTRY PATTERN]` conforme marcado.

---

## 1. Requirements (design framing)

**Funcionais:** ingerir métricas de serviços · armazenar como séries temporais com labels · consultar e agregar (taxas, percentis, somas por label) · dashboards · regras de alerta com roteamento de notificações · retenção e rollups.

**Não funcionais:** **disponibilidade** (maior que a dos sistemas monitorados) · **throughput de escrita** (milhões de pontos por segundo) · **latência de consulta** (de dezenas de milissegundos a segundos) · **frescor** (alertas em segundos a um minuto) · **custo** (memória) · **escalabilidade em número de séries** · **tolerância a desastres**.

**Perguntas de esclarecimento:** quantas séries e quantos pontos por segundo? Qual cardinalidade é esperada, e quem controla os labels? Retenção e resolução por camada? Meta de latência de alerta? Região única ou multi-região? Multi-tenant?

---

## 2. Data model and collection `[CONFIRMED]` (Prometheus documentation)

O Prometheus "fundamentally stores all data as time series: streams of timestamped values belonging to the same metric and the same set of labeled dimensions". Cada série é identificada por seu nome de métrica e labels chave-valor opcionais; "the change of any label's value, including adding or removing labels, will create a new time series". A orientação de nomes é explícita: "Do not use labels to store dimensions with high cardinality (many different label values), such as user IDs, email addresses, or other unbounded sets of values".

**Arquitetura do toolkit.** O servidor Prometheus faz scrape de métricas de jobs instrumentados, "either directly or via an intermediary push gateway for short-lived jobs", guarda amostras localmente e executa regras sobre elas para registrar séries derivadas ou gerar alertas; um Alertmanager trata os alertas. A coleta acontece "via a pull model over HTTP", os alvos são encontrados por service discovery ou configuração estática, e cada nó servidor é "autonomous": não depende de storage distribuído. A documentação apresenta isso como um recurso de confiabilidade: ele deve ser o sistema ao qual você recorre durante uma queda.

**Onde não se encaixa.** Para necessidades como faturamento por requisição que exigem 100% de exatidão, a documentação diz que o Prometheus não é uma boa escolha porque os dados coletados provavelmente não serão detalhados e completos o bastante.

**Storage local.** As amostras são agrupadas em blocos de duas horas, cada um com chunks, um índice (mapeando nomes de métricas e labels para séries) e metadados. O bloco atual é mantido em memória e protegido por um **write-ahead log** reproduzido após um restart. O storage local "not clustered or replicated", então não é arbitrariamente escalável nem durável contra a perda do nó e deve ser gerenciado como qualquer banco de nó único; existem integrações de storage remoto.

---

### Push or pull?

Os dois designs publicados diferem aqui, e cada escolha tem seus motivos:
- **Pull (Prometheus):** o servidor faz scrape dos alvos por HTTP, descobrindo-os por service discovery ou configuração estática, com um push gateway só para jobs de curta duração `[CONFIRMED]`. Consequências (nossas): o coletor controla a taxa e sabe quando um alvo está fora (um scrape que falha é, ele próprio, um sinal); os alvos precisam de um endpoint HTTP alcançável pelo coletor; jobs de curta duração e redes com firewall se encaixam mal.
- **Push (Monarch):** "a client sends data to one of the nearby ingestion routers", geralmente por uma biblioteca de instrumentação que escreve na frequência necessária para a política de retenção `[CONFIRMED]`. Consequências (nossas): funciona através de firewalls e para tasks de curta duração; o cliente decide a taxa, então o backend precisa de limites de ingestão, e um alvo silencioso é mais difícil de distinguir de um morto sem heartbeats extras.
- **Tirar a média de percentis está errado.** As distribuições de latência devem ser guardadas como histogramas ou outros resumos mesclável e combinadas antes de tirar um percentil; o percentil 99 dos percentis 99 por instância não é o percentil 99 da frota (raciocínio nosso). O modelo de dados do Monarch tem séries temporais de tipo distribuição de primeira classe, e descreve o suporte abrangente a elas como um objetivo de design `[CONFIRMED]`.

## 3. A hyperscale in-memory design: Gorilla `[CONFIRMED]` (Pelkonen et al., VLDB 2015)

**Requisitos e insight.** Os autores do Gorilla argumentam que os usuários de monitoramento se importam com a **análise agregada**, não com pontos individuais, e que os dados recentes importam muito mais que os antigos. O banco deles otimiza "for remaining highly available for writes and reads, even in the face of failures, at the expense of possibly dropping small amounts of data on the write path". Como o sistema não guarda dados de usuários, as garantias ACID não são um requisito central. Eles também queriam transições de estado (um release ruim, uma mudança de configuração) visíveis em dezenas de segundos, e a maioria das consultas rodando em dezenas de milissegundos.

**Design.** O Gorilla é um banco de séries temporais em memória que funciona como um **write-through cache** dos dados recentes na frente do store persistente HBase. Pela análise do sistema antigo, pelo menos 85% das consultas eram sobre as últimas 26 horas, então o Gorilla mantém 26 horas em memória. Cada dado é uma chave string, um timestamp de 64 bits e um valor de precisão dupla. Os dados têm sharding por chave entre hosts de forma share-nothing; no lançamento, 26 horas cabiam em 1,3 TB de RAM em 20 máquinas, e o cluster depois dobrou duas vezes até 80 máquinas.

**Compressão.** Os timestamps são guardados como **delta-of-delta** (intervalos regulares comprimem para quase nada; cerca de 96% dos timestamps viram um único bit). Os valores recebem **XOR** com o valor anterior e os zeros à esquerda e à direita são codificados (cerca de 51% dos valores são idênticos ao anterior e ocupam um único bit). A média cai de 16 bytes para 1,37 byte por ponto. O esquema funciona sobre um stream, ponto a ponto, e é por isso que combina com um caminho de escrita em memória.

**Persistência.** As escritas são anexadas a um log por shard que **não** é um write-ahead log: os dados são mantidos em buffer até 64 kB, cerca de um ou dois segundos, antes de descarregar, então um crash pode perder um pouco de dado; os autores julgaram que a maior disponibilidade de escrita valia a pena. A cada duas horas o bloco comprimido é copiado para o disco, um arquivo de checkpoint o marca como completo e os logs são apagados.

**Tratamento de falhas.** Cada série temporal é escrita em **dois hosts em regiões separadas**, sem tentar garantir consistência entre eles. As leituras vão para a instância disponível mais próxima e fazem failover para a outra região quando necessário. Um ShardManager baseado em Paxos reatribui shards quando um nó falha; durante a movimentação, os clientes de escrita mantêm em buffer um minuto de dados, descartando pontos mais antigos. Se o resto do cluster está saudável, a movimentação de shards termina em 30 segundos ou menos sem perda de dados. Depois de uma falha em nível de região, as leituras são desligadas para essa região até o cluster ficar saudável por pelo menos 26 horas.

**Resultado.** Comparado ao store apoiado em HBase, a latência de consulta caiu 73 vezes e o throughput subiu 14 vezes, o que "unlocked new monitoring and debugging tools" como a busca por correlação de séries temporais.

---

## 4. A planet-scale design: Monarch `[CONFIRMED]` (Adams et al., VLDB 2020)

**Princípios.** O Monarch "readily trades consistency for high availability and partition tolerance": ler ou escrever num banco fortemente consistente "may block for a long time", o que aumentaria o tempo para detectar e mitigar quedas, então o Monarch "drops delayed writes and returns partial data for queries if necessary", com mecanismos para indicar que os dados podem estar incompletos. Ele também precisa ter **poucas dependências** no caminho de alerta: os sistemas de storage do Google dependem do Monarch para monitoramento, então o Monarch guarda os dados em memória e evita usá-los, para evitar uma dependência circular.

**Estrutura.** O princípio organizador é o **monitoramento local em zonas regionais com gerenciamento e consulta globais**. Cada zona é autônoma, feita de clusters que são domínios de falha independentes, e pode continuar funcionando durante quedas de outras zonas ou de componentes globais. Componentes: **leaves** (store em memória), **recovery logs** (os mesmos dados em disco), um servidor de configuração, **ingestion routers** e **leaf routers**, **range assigners** que balanceiam dados entre os leaves, **mixers** que dividem uma consulta em subconsultas e fazem o merge dos resultados, **index servers** que limitam o fan-out e **evaluators** que executam as standing queries.

**Consultas.** As consultas ad hoc vêm dos usuários; as **standing queries** são consultas periódicas de materialized view cujos resultados são escritos de volta, usadas para condensar dados e gerar alertas. As consultas globais rodam por uma árvore de três níveis (root mixer, zone mixers, leaves), restringida pelos index servers. Por análise estática a maioria das standing queries é avaliada pelos zone evaluators, até 95% das standing queries são totalmente avaliadas no nível da zona, o que os autores dizem aumentar muito a tolerância a partições de rede e reduzir a latência.

**Escala.** Em operação desde 2010; perto de um petabyte de séries temporais comprimidas em memória; terabytes ingeridos por segundo; milhões de consultas por segundo; um modelo de dados relacional com schema.

---

## 5. The alert pipeline `[CONFIRMED]` (Prometheus documentation)

**Regras.** As regras de alerta são expressões avaliadas periodicamente; um elemento que satisfaz a expressão mas ainda não a manteve pela duração configurada (a cláusula `for`) está no estado **pending**, e depois disso está **firing**. Um `keep_firing_for` opcional mantém um alerta disparado por um período depois que a condição se manteve pela última vez, para evitar flapping.

**Alertmanager.** Ele "takes care of deduplicating, grouping, and routing" alertas para receptores como e-mail, PagerDuty ou OpsGenie, e trata silenciamento e inibição:
- **Agrupamento:** muitos alertas parecidos viram uma notificação. O exemplo da documentação: uma partição de rede faz centenas de instâncias não alcançarem o banco; o operador quer um único acionamento mas ainda ver quais instâncias foram afetadas, então os alertas são agrupados por cluster e nome do alerta.
- **Inibição:** suprimir notificações de alguns alertas se certos outros alertas já estão disparados (por exemplo, silenciar tudo sobre um cluster quando um alerta de cluster-inalcançável dispara).
- **Silences:** silenciar alertas que casam com determinados matchers por um tempo.
- **Alta disponibilidade:** o Alertmanager pode rodar como cluster. A documentação alerta para não fazer load balancing entre o Prometheus e seus Alertmanagers; aponte o Prometheus para a lista completa deles.

---

## 5b. Long-term storage and a global view: Thanos `[CONFIRMED]` (Thanos design documentation)

O storage local do Prometheus é de nó único (seção 2). O Thanos, um conjunto de componentes de código aberto, é a forma documentada de acrescentar storage durável de longo prazo e uma camada de consulta entre servidores sem mudar o modelo de dados. Sua página de design diz que seus objetivos são "operation simplicity and retaining of Prometheus's reliability properties".
- **Fontes:** um **sidecar** ao lado de cada servidor Prometheus expõe seus dados por uma Store API gRPC, e **rule nodes** avaliam regras; ambos anunciam quais dados guardam.
- **Backup para object storage:** o motor de storage do Prometheus produz periodicamente **blocos imutáveis** para uma faixa de tempo fixa (um diretório com arquivos de chunks, um índice e um `meta.json`); os sidecars os enviam a um bucket de object storage à medida que são criados, acrescentando labels externos aos metadados para que os blocos possam depois ser filtrados "without accessing their data files".
- **Store nodes:** um gateway para os blocos no bucket que implementa a mesma Store API, sincroniza quais blocos existem, filtra os blocos relevantes por faixa de tempo e labels, e guarda em cache as consultas ao índice. Como os dados de amostras de uma série ficam dispostos sequencialmente, uma requisição é traduzida num número mínimo de leituras de object storage, cada uma buscando até centenas de milhares de chunks. Os dados de chunks não são guardados em cache porque, como diz a página de design, buscá-los "already only accounts for a small fraction of end-to-end latency".
- **Queriers:** instâncias stateless e horizontalmente escaláveis que implementam PromQL sobre as Store APIs, minimizando o fan-out com os metadados de cada nó.
- **Compactor:** um singleton que mescla blocos pequenos em maiores, reduzindo o tamanho do storage e o número de requisições por consulta, e também faz **downsampling e retenção**.
- **Escala:** "none of the Thanos components provides any means of sharding"; apenas os queriers são explicitamente escaláveis, com a capacidade escalando por meio do object store externo.

Esta é uma resposta diferente para o mesmo problema que o Gorilla e o Monarch resolvem. O Gorilla e o Monarch mantêm a janela quente em memória distribuída com replicação e regiões embutidas; o Thanos mantém os coletores simples de servidor único do Prometheus e acrescenta um bucket para o histórico e uma camada de consulta para uma visão global, trocando velocidade em tempo de consulta por simplicidade. Ele se encaixa no bullet de camada de retenção da seção 6, e seu downsampling e sua retenção vivem no compactor.

## 6. Reference design `[INDUSTRY PATTERN]` (combining the above)

```
services/exporters ─(scrape or push)─► collectors ─► sharded TSDB (in-memory recent data + log + blocks)
                                           │                  │ replicate to second region
                                           ▼                  ▼
                                    shard manager      long-term store (rollups)
rule evaluators ─ query ─► TSDB ─ firing alerts ─► alert manager ─► notification channels ─► on-call
dashboards/query API ─────► TSDB (closest healthy replica)
```

- **Camada de coleta:** coletores stateless fazem scrape ou recebem métricas, impõem regras e limites de labels e roteiam cada série ao seu shard fazendo o hash da sua identidade.
- **Limites de séries:** limite as séries por tenant e por métrica; rejeite ou descarte séries que excedam os limites e alerte o dono. Explosões de cardinalidade são a forma mais comum de um sistema de monitoramento cair.
- **Camadas de retenção:** dados brutos por horas ou dias em memória ou em disco rápido, rollups com downsampling (por exemplo médias de 5 minutos) por meses ou anos em storage mais barato. Os rollups perdem detalhes como picos; mantenha sketches de máximo e de percentil onde necessário.
- **Avaliação de alertas perto dos dados:** como no Monarch, rode as regras na mesma região dos dados para que uma partição não as silencie.
- **Meta-monitoramento:** monitore o monitor com um sistema independente e mais simples e um alerta de "dead man's switch" que dispara se os alertas param de chegar.
- **Qualidade dos alertas:** alerte sobre sintomas que os usuários sentem (taxa de erro, latência) em vez de cada causa; todo alerta precisa de um dono e de um runbook.
- **Multi-tenancy:** cotas por tenant, isolamento de consultas pesadas e controle de acesso.

---

## 7. Failure scenarios

- **Um coletor ou shard de ingestão falha.** As escritas são mantidas brevemente em buffer e os shards reatribuídos, com os pontos mais antigos descartados em vez de bloquear `[CONFIRMED]` (Gorilla).
- **Uma região é perdida.** As leituras fazem failover para a cópia da outra região `[CONFIRMED]` (Gorilla); as zonas do Monarch continuam funcionando de forma independente `[CONFIRMED]`.
- **Uma partição de rede.** A avaliação de regras local à zona mantém os alertas funcionando `[CONFIRMED]` (Monarch).
- **Explosão de cardinalidade.** Um label ruim cria milhões de séries e esgota a memória; limites por tenant e a rejeição protegem o resto `[INDUSTRY PATTERN]`; a causa está documentada na orientação do Prometheus `[CONFIRMED]`.
- **Tempestade de alertas.** Agrupamento e inibição reduzem os acionamentos `[CONFIRMED]`.
- **O próprio sistema de monitoramento está fora do ar.** Meta-monitoramento independente e um dead man's switch `[INDUSTRY PATTERN]`.
- **Um crash perde dados recentes.** Aceito: o log do Gorilla pode perder um ou dois segundos, enquanto o WAL do Prometheus protege o bloco em memória `[CONFIRMED]`.

---

## 8. Capacity reasoning (illustrative)

- **Memória ≈ séries ativas × bytes por ponto × pontos retidos.** Os números publicados do Gorilla: 12 milhões de pontos por segundo são cerca de 1 trilhão por dia; a 16 bytes por ponto são 16 TB, contra aproximadamente 1,4 TB a 1,37 byte. O paper deles diz que 16 TB de RAM eram impraticáveis, o que motivou a compressão.
- **Uma conta de padaria para o seu próprio sistema:** 1 milhão de séries coletadas a cada 15 segundos são cerca de 67.000 pontos por segundo (1.000.000 ÷ 15), ou cerca de 5,8 bilhões de pontos por dia. A 1,37 byte por ponto (a média do Gorilla, que será diferente nos seus dados) isso dá cerca de 8 GB por dia de dados comprimidos. Estas são premissas e aritmética nossas.
- O **throughput do coletor** escala com o número de séries dividido pelo intervalo de scrape; os shards escalam com a memória total.

---

## ⚠️ Reviewer notes

1. **Três sistemas diferentes.** O Gorilla (2015, Facebook), o Monarch (2020, Google) e o Prometheus (código aberto) fazem escolhas diferentes. Em particular o Prometheus é de nó único por design, enquanto os outros são sistemas distribuídos em escala planetária; não misture as garantias deles.
2. **Os números são datados.** Os números do Gorilla são da primavera de 2015; os do Monarch são do paper de 2020. Os sistemas das duas empresas certamente mudaram.
3. **A documentação do Prometheus é específica de versão e evolui** (por exemplo, nomes UTF-8 chegaram na v3.0). Lemos as páginas em 2026-10-27.
4. **A orientação de design de alertas (alertas de sintoma, runbooks, dead man's switch) é prática do setor,** não vem destas fontes.
5. **Not read:** os papers posteriores Beringei ou Scuba do Facebook, os designs Cortex ou Mimir (o Thanos é coberto a partir de sua página de design, seção 5b), VictoriaMetrics, OpenTelemetry, sistemas de logging e tracing, e detecção de anomalias.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **disponibilidade** (acima da de seus clientes), **performance** (ingestão e consulta), **escalabilidade**, **eficiência de custo**, **atualidade dos dados**.
- **Estilo (Ch 13):** um **pipeline** (coletar, armazenar, avaliar, notificar) sobre um store **share-nothing com sharding**, com autonomia regional.
- **Quanta (Ch 7):** cada zona ou região é seu próprio quantum, de modo que uma falha em outro lugar não para o alerta local.
- **Trade-off (First Law, Ch 1):** **consistência/completude vs disponibilidade.** Os sistemas publicados escolhem a disponibilidade e aceitam lacunas.
- **Esboço de ADR (Ch 19):** *"Vamos manter os dados recentes em memória com cópias regionais replicadas, avaliar os alertas na mesma região dos dados e descartar escritas atrasadas em vez de bloquear. Aceitamos pequenas lacunas ocasionais nos dados em troca de um monitoramento que continua no ar durante incidentes."*
- Em linguagem simples: mantenha o gráfico de hoje na parede, nunca congele a tela e acione uma vez por incêndio.

---

## Interview questions to practice

1. Projete um sistema de monitoramento de métricas e alertas para milhares de serviços.
2. Como armazenar séries temporais com eficiência? Como funciona a compressão?
3. Coleta por push ou pull? Trade-offs?
4. O que é cardinalidade, e como se proteger de explosões?
5. Um banco de monitoramento deve ser consistente ou disponível? Por quê?
6. Como projetar o pipeline de alertas para evitar tempestades de alertas e alertas perdidos?
7. Como manter anos de histórico a um custo acessível?
8. Como monitorar o próprio sistema de monitoramento?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: número de séries, pontos por segundo, retenção, latência de alerta, regiões, tenants.
2. Estimar: pontos por dia, bytes por ponto, memória para a janela quente, storage para rollups.
3. API: escrita (push ou scrape), linguagem de consulta, definição de regra de alerta.
4. Design: coletores, TSDB com sharding e log e blocos, replicação entre regiões, avaliadores de regras, alert manager, store de longo prazo.
5. Deep dive: compressão, sharding e reatribuição de shards, limites de cardinalidade, rollups.
6. Falhas e escala: falha de nó e de região, partição, tempestade de alertas, monitorar o monitor.

**Se crescer 10×**
- Memória: compressão mais forte, janela quente mais curta, storage em camadas.
- Número de séries: imponha limites, pré-agregue nos coletores, faça shard do índice.
- Carga de alertas: avaliação local à zona, standing queries que pré-agregam.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Push ou pull?</summary>

O pull dá ao coletor o controle da taxa e um sinal de liveness embutido, mas precisa de endpoints alcançáveis e trata mal jobs de curta duração (um push gateway os cobre). O push serve a firewalls, tasks efêmeras e frotas muito grandes com ingestion routers regionais, mas precisa de limites de ingestão e de verificações de liveness separadas. Sistemas grandes costumam misturar os dois; diga qual falha você está otimizando.

</details>

<details><summary>Consistência ou disponibilidade para um banco de monitoramento?</summary>

Disponibilidade. Se o banco bloqueia durante uma queda, os engenheiros perdem a visão de que mais precisam e os alertas atrasam. Descarte escritas atrasadas, sirva dados parciais com um indicador e replique para uma segunda região sem consistência estrita. Não o use onde contagens exatas são necessárias, como faturamento.

</details>

<details><summary>Como impedir uma explosão de cardinalidade?</summary>

Revise e restrinja nomes e valores de labels na hora da instrumentação, nunca ponha valores ilimitados em labels, imponha limites de séries por tenant nos coletores, descarte ou rejeite séries em excesso e alerte o dono com a métrica infratora.

</details>

<details><summary>Como evitar tempestades de alertas?</summary>

Alerte sobre sintomas, agrupe alertas relacionados numa notificação, iniba alertas de nível mais baixo quando um de nível mais alto dispara, acrescente uma duração de pending para evitar flapping e roteie ao time dono com um link para o runbook.

</details>

## 📚 Further reading

- Os papers e a documentação listados em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [03 Distributed key-value store](03-distributed-kv-store.md) para sharding e replicação, [04 Kafka](04-message-queue-kafka.md) para fazer buffer da ingestão, [10 Notification system](10-notification-system.md) para entregar alertas, [02 Rate limiter](02-rate-limiter.md) para limites por tenant.

## Sources and provenance

> **Kind:** reference design com partes reais. O Gorilla e o Monarch descrevem sistemas reais de produção no Facebook e no Google; o Prometheus é um toolkit de código aberto com documentação pública. O design combinado da seção 6 é nosso `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Pelkonen et al., [*Gorilla: A Fast, Scalable, In-Memory Time Series Database*](https://www.vldb.org/pvldb/vol8/p1816-teller.pdf) (VLDB 2015) · Adams et al., [*Monarch: Google's Planet-Scale In-Memory Time Series Database*](https://www.vldb.org/pvldb/vol13/p3181-adams.pdf) (VLDB 2020) · documentação do Prometheus: [Overview](https://prometheus.io/docs/introduction/overview/), [Data model](https://prometheus.io/docs/concepts/data_model/), [Storage](https://prometheus.io/docs/prometheus/latest/storage/), [Alertmanager](https://prometheus.io/docs/alerting/latest/alertmanager/), [Alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) e [Metric and label naming](https://prometheus.io/docs/practices/naming/) · [documentação de design](https://thanos.io/tip/thanos/design.md/) do Thanos. Texto dos PDFs extraído localmente.
> **Dated material:** os números do Gorilla são da primavera de 2015; os do Monarch de 2020; a documentação do Prometheus vale para esta data.
> **Not read:** Cortex, Mimir, VictoriaMetrics, OpenTelemetry, o trabalho de continuação do Facebook, sistemas de tracing e logging.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source in full. Quotations are confirmed by `npm run verify`.*
- Verified in the Gorilla paper: abstract claims (10 times, 73 times, 14 times), requirements, 85% of queries within 26 hours, Spring 2015 scale (2 billion series, 12 million points per second, over 1 trillion per day), 16 bytes to 1.37 bytes (12 times), 1.3 TB on 20 machines growing to 80 machines, delta-of-delta (96% of timestamps to one bit) and XOR (51% of values to one bit), log that is not a write-ahead log (64 kB buffer), two-hour blocks with checkpoint file, two regions without consistency, ShardManager (Paxos-based), one-minute write buffers, thirty-second shard movement, 26-hour region recovery rule.
- Verified in the Monarch paper: abstract and scale claims, consistency-for-availability principle, circular-dependency argument, zonal autonomy, component list, standing queries and the 95% zone-level figure, three-level query tree.
- Verified in the Prometheus documentation: data model and label rule, cardinality warning, architecture and components, pull model and push gateway, autonomy and non-fit statement, two-hour blocks and WAL, non-clustered storage limitation, pending and firing states and `keep_firing_for`, Alertmanager grouping, inhibition, silences and high-availability guidance.
- Verified in the Thanos design page: sidecar and rule sources, immutable blocks uploaded to object storage with external labels, store nodes filtering by metadata and caching only index data, stateless queriers, the compactor's merging, downsampling and retention, and the no-sharding scaling statement.
- Labelled industry pattern, not sourced: the combined reference design, series limits, retention tiers, meta-monitoring, alert-quality advice, capacity arithmetic.
- Not claimed: how any specific current monitoring product works.
