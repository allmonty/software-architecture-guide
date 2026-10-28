# 26 — Recommendation System (Two-Stage ML Ranking)

*Partes de real-system do paper de recomendação do YouTube (2016) e do paper Monolith da ByteDance (2022), mais um reference design para a plataforma em volta. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um recomendador precisa escolher algumas dezenas de itens para um usuário entre milhões, em dezenas de milissegundos, e continuar aprendendo com o que os usuários fazem. A resposta padrão é de **dois estágios**: um modelo barato de **geração de candidatos** reduz milhões a centenas usando o histórico do usuário, depois um modelo de **ranking** mais rico pontua essas centenas com muitas features e as ordena; um passo final aplica regras de negócio. Em volta ficam o registro de eventos, uma feature store, pipelines de treinamento e experimentos. As partes difíceis são o **frescor** (itens novos e comportamento novo), os **feedback loops** (o que você mostra molda o que você aprende) e a **avaliação** (as métricas offline nem sempre preveem os resultados ao vivo).

**Números principais** (como publicados, com o ano)
- Os modelos do YouTube de 2016 aprendiam cerca de um bilhão de parâmetros e foram treinados com centenas de bilhões de exemplos `[CONFIRMED]`.
- A geração de candidatos reduz "milhões" de vídeos a "centenas", depois o ranking pontua essas centenas até "dezenas" `[CONFIRMED]`.
- O treinamento com negativos amostrados (vários milhares por exemplo) deu mais de 100 vezes de aceleração sobre um softmax completo `[CONFIRMED]`.
- O serving pontuou milhões de itens sob "a strict serving latency of tens of milliseconds" usando busca de vizinho mais próximo aproximada `[CONFIRMED]`.
- O Monolith sincronizou os parâmetros esparsos alterados do treinamento para o serving em intervalos de nível de minuto e fez snapshot dos servidores de treinamento uma vez por dia, aceitando até um dia de atualizações perdidas numa falha `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Dois estágios: recuperar e depois ranquear | Features ricas só em centenas de itens, não em milhões | O recall do primeiro estágio limita a qualidade do segundo |
| Ranquear por tempo de exibição esperado, não por clique | A taxa de cliques promove "clickbait" | Objetivo mais difícil, exige treinamento cuidadoso |
| Alimentar a idade do exemplo como feature | Corrige o viés para itens antigos e populares | Feature extra a definir corretamente no serving |
| Treinamento online com sync de nível de minuto | Se adapta ao feedback em tempo real | Mais partes móveis, garantias de confiabilidade menores |
| Decidir com testes A/B ao vivo | As métricas offline nem sempre se correlacionam com os resultados ao vivo | Lento, exige tráfego e cuidado |

**Erros comuns**
- Usar cliques como único alvo e obter clickbait.
- Treinar com todos os dados de modo uniforme, de forma que o modelo favorece o que foi popular no passado.
- Training/serving skew: features calculadas de forma diferente offline e online.
- Julgar uma mudança apenas por métricas offline.
- Ignorar o cold start de usuários novos e itens novos.

---

## 🧒 Non-technical explanation

Imagine um **atendente de livraria numa loja com milhões de livros**. Primeiro ele rapidamente separa um carrinho com algumas centenas de livros que parecem certos pelo que você comprou e perguntou antes; isso precisa ser rápido e mais ou menos certo. Depois, ao lado do carrinho, ele pensa com mais cuidado em cada um (seu humor, a hora do dia, o que você ignorou da última vez) e escolhe os melhores para pôr no balcão. Ele também continua aprendendo com o que você de fato leva para casa, e garante que o balcão não seja o mesmo a cada visita e que não tenha só best-sellers.

---

## TL;DR for engineers

- **Estágio 1, geração de candidatos:** um user embedding aprendido encontra item embeddings próximos por busca de vizinho mais próximo aproximada `[CONFIRMED]` (YouTube).
- **Estágio 2, ranking:** um modelo profundo com centenas de features pontua cada candidato, treinado para prever o tempo de exibição esperado por impressão `[CONFIRMED]`.
- **Frescor:** uma feature de "example age" corrige o viés para o passado `[CONFIRMED]`.
- **Aprendizado online:** passe os logs em stream por um joiner até o treinamento e empurre as mudanças de parâmetros ao serving em minutos `[CONFIRMED]` (Monolith).
- **Feature store, regras de re-ranking, cold start, experimentos, monitoramento:** as preocupações da plataforma `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** devolver uma lista ranqueada de itens para um usuário e contexto (página inicial, próximo item) · registrar impressões e ações · retreinar e reimplantar modelos · suportar experimentos · filtrar itens inelegíveis (bloqueados, já vistos, indisponíveis).

**Não funcionais:** **latência** (dezenas a centenas de milissegundos de ponta a ponta) · **escala** (milhões de itens, muitos usuários) · **frescor** dos itens e do comportamento · **qualidade** (engajamento, mas também diversidade e satisfação) · **robustez** (um componente que falha degrada com elegância) · **custo** (treinamento em GPU, armazenamento de features).

**Perguntas de esclarecimento:** o que é recomendado (vídeos, produtos, posts)? Tamanho e rotatividade do catálogo? Qual é o objetivo (tempo de exibição, compras, retenção)? Quão frescos os modelos precisam ser? Quais são as regras de negócio? Quantos experimentos rodam ao mesmo tempo?

---

## 2. The two-stage design `[CONFIRMED]` (Covington, Adams, Sargin, RecSys 2016)

O paper diz que o YouTube "represents one of the largest scale and most sophisticated industrial recommendation systems in existence" e divide o sistema "according to the classic two-stage information retrieval dichotomy". Ele nomeia três desafios: **escala**, **frescor** e **ruído** (o feedback implícito é esparso e a verdade sobre a satisfação raramente é observada).

### 2.1 Candidate generation

- **Papel:** recuperar um pequeno subconjunto (centenas) de vídeos de um corpus grande, "generally relevant to the user with high precision", fornecendo "broad personalization via collaborative filtering".
- **Modelo:** o problema é formulado como classificação multiclasse extrema: prever qual vídeo será assistido em seguida entre milhões, usando um user embedding calculado por uma rede neural a partir do histórico e do contexto do usuário, e embeddings de vídeos. As entradas incluem o histórico de exibição (uma sequência de tamanho variável de IDs de vídeos, com embedding e média), o histórico de busca tratado de forma parecida, dados demográficos, geografia e dispositivo.
- **Truque de treinamento:** classes negativas amostradas, vários milhares por exemplo, o que o paper diz ser "more than 100 times speedup over traditional softmax".
- **Serving:** como probabilidades calibradas não são necessárias, o problema se reduz a uma **busca de vizinho mais próximo no espaço do produto escalar**, com "general purpose libraries"; os autores constataram que os resultados dos testes A/B "were not particularly sensitive to the choice of nearest neighbor search algorithm". Veja [24 Vector / semantic search at scale](24-vector-semantic-search.md).
- **Rótulos de treinamento:** feedback implícito de exibições, não curtidas. Os autores preveem uma exibição futura em vez de uma retida aleatoriamente porque constataram que se saiu melhor nos testes A/B, e excluem informações do futuro do usuário que causariam vazamento.
- **Frescor, "example age":** os sistemas de machine learning têm um "implicit bias towards the past", então a idade do exemplo de treinamento é alimentada como feature durante o treinamento e definida como zero (ou levemente negativa) no serving.

### 2.2 Ranking

- **Papel:** com apenas algumas centenas de candidatos, usar "many more features describing the video and the user's relationship to the video" e pontuar cada impressão. O ranking também é crucial para fazer o ensembling de diferentes fontes de candidatos cujas pontuações não são diretamente comparáveis.
- **Modelo:** uma rede profunda "with similar architecture" pontuando cada impressão com regressão logística, usando centenas de features. O objetivo final de ranking é "generally a simple function of expected watch time per impression" porque ranquear pela taxa de cliques "often promotes deceptive videos that the user does not complete".
- **Features de impressão** (quantas vezes um vídeo foi mostrado a este usuário) introduzem "churn", de modo que requisições sucessivas não devolvem listas idênticas. Servir o histórico de impressões e de exibição atualizado ao segundo é chamado de "an engineering feat onto itself".

### 2.3 Evaluation

O paper usa métricas offline (precisão, recall, ranking loss) para guiar a iteração mas conta com **experimentos A/B ao vivo** para o julgamento final, porque "live A/B results are not always correlated with offline experiments". Os experimentos ao vivo medem taxa de cliques, tempo de exibição e outras métricas de engajamento.

---

## 3. Learning from feedback in real time: Monolith `[CONFIRMED]` (ByteDance, 2022)

O Monolith argumenta que os frameworks de deep learning de propósito geral ficam aquém para recomendação: parâmetros estáticos e computação densa lhe servem mal, e o treinamento e o serving em batch são completamente separados, o que impede o modelo de interagir com o feedback do cliente em tempo real. O sistema dos autores é descrito como feito sob medida para **treinamento online**.

- **Tabela de embeddings sem colisão.** IDs esparsos são mapeados para embeddings por uma hash table construída com **cuckoo hashing** para que IDs distintos não colidam. Os IDs de features são filtrados antes da admissão (por contagem de ocorrências e um filtro probabilístico) e configurados para expirar após inatividade, para limitar a memória. Experimentos no MovieLens e num dataset interno mostraram que os modelos com a tabela sem colisão superaram consistentemente os com colisões.
- **Dois estágios de treinamento.** O *batch training* é uma passada normal sobre dados históricos (usada quando o modelo muda). Após o deploy, o *online training* consome dados em tempo real e atualiza os parameter servers de treinamento, que se sincronizam periodicamente com os parameter servers de serving.
- **Streaming engine.** Uma fila Kafka registra as ações dos usuários e outra registra as features; um job **Flink**, o online joiner, junta as features com os rótulos das ações para produzir exemplos de treinamento em outra fila Kafka, consumida diretamente para o treinamento online e despejada no HDFS para o treinamento em batch. Ações e features chegam sem ordem temporal, então cada requisição tem uma chave única; ações atrasadas (uma compra dias depois da impressão) são tratadas com um key-value store em disco atrás de um cache em memória.
- A **amostragem de negativos** mudaria a distribuição da saída, então uma **correção de log-odds** é aplicada no serving.
- **Sincronização de parâmetros.** Os modelos de produção costumam ter vários terabytes, então a substituição completa é inviável. Os parâmetros esparsos dominam o tamanho do modelo, e só um pequeno subconjunto de IDs muda numa janela curta, então o Monolith acompanha as chaves tocadas e empurra apenas essas em intervalos de **nível de minuto**; os parâmetros densos mudam mais devagar e se sincronizam cerca de uma vez por dia, em horários de baixo tráfego. O exemplo do paper: 100.000 IDs atualizados por minuto com 1.024 dimensões dão cerca de 400 MB por minuto.
- **Tolerância a falhas.** Os servidores de treinamento recebem **snapshot diário**; um servidor que falha perde até um dia de atualizações, e os autores constataram que a perda de qualidade é tolerável. Eles concluem que "system reliability could be traded-off for real-time learning".
- **Resultados.** No dataset de anúncios Criteo, um intervalo de sync menor deu melhor AUC online (5 horas 79,66, 1 hora 79,78, 30 minutos 79,80, contra cerca de 79,4 para batch). Num teste A/B ao vivo num modelo de anúncios, o treinamento online melhorou o AUC frente ao treinamento em batch em cada um de sete dias (a Tabela 3 do paper relata uma "AUC improvement" para cada dia; ele não define a unidade no texto que lemos, então não citamos nenhuma porcentagem).

São medições dos autores sobre seus dados; o sistema é descrito para o produto BytePlus Recommend deles.

---

## 3b. Offline, nearline and online computation: Netflix `[CONFIRMED]` (Amatriain and Basilico, March 2013)

Uma terceira fonte, o post "System Architectures for Personalization and Recommendation" do TechBlog da Netflix, dá o vocabulário mais limpo para onde o trabalho de recomendação roda. Seus três modos de computação:
- **Online:** responde a eventos recentes e ao contexto atual (por exemplo montar uma galeria de filmes de ação ordenados para o membro naquele momento), mas está "subject to an availability and response time Service Level Agreements (SLA)", o que limita o custo do algoritmo, então "it is always important to think of a fast fallback mechanism such as reverting to a precomputed result". Os componentes online também precisam que suas fontes de dados estejam disponíveis online.
- **Offline:** jobs em batch com latência relaxada, algoritmos complexos e muitos dados (por exemplo agregar estatísticas de popularidade a partir de milhões de eventos de reprodução); fáceis de implantar e de experimentar, já que um algoritmo experimental mais lento pode simplesmente receber mais instâncias. O custo é a obsolescência: ele "will not react quickly to changes in context or new data".
- **Nearline:** um meio-termo: a computação é feita como no caso online, mas os resultados são armazenados em vez de servidos imediatamente, disparada por eventos de usuário, por exemplo atualizar as recomendações logo depois que um membro começa a assistir a um filme. É também "a natural setting for applying incremental learning algorithms".

Os autores enfatizam que não é uma coisa ou outra: "All approaches can and should be combined", por exemplo pré-calcular parte de um resultado offline e deixar as partes mais baratas e sensíveis ao contexto para a computação online; e o treinamento de modelos pode ser dividido em um treinamento global pesado offline e atualizações por usuário mais leves online (a fatoração de matrizes é o exemplo deles). O post também separa três tipos de entrada de algoritmo: **models** (arquivos pequenos de parâmetros treinados offline), **data** (informação processada num banco) e **signals** (informação fresca de serviços ao vivo como o que o membro assistiu recentemente ou o dispositivo e o horário), e distingue **events** (pequenas unidades sensíveis ao tempo processadas com latência mínima) de **data** (unidades densas em que a qualidade importa mais que a latência). O fluxo de eventos quase em tempo real da Netflix rodava num sistema interno que ela chamava de Manhattan.

Isso se mapeia na plataforma da seção 4: o ranker e o retrieval são a parte online, o log de eventos e o joiner alimentam as atualizações nearline, e o retreinamento completo é offline. É uma descrição de 2013 de uma empresa; o post não é sobre o sistema de hoje.

## 4. The platform around the models `[INDUSTRY PATTERN]`

```
user ─► recommendation API ─► candidate generation ─► ranking ─► re-ranking rules ─► list
              │                  (ANN + other sources)   ▲             (diversity, filters)
              │                           ▲              │
              │                    feature store (online) ◄── streaming features
              └─► impressions + actions ─► event log ─► joiner ─► training ─► model store ─► serving
```

- **Múltiplas fontes de candidatos:** o retrieval por embeddings acima, mais populares, tendências, contas seguidas, assistidos recentemente, itens parecidos com o último. O paper do YouTube diz que o design de dois estágios também "enables blending candidates generated by other sources".
- **Feature store:** as mesmas definições de features usadas offline para o treinamento e online para o serving, para evitar training/serving skew; correção point-in-time para as features de treinamento.
- **Re-ranking e política:** remova itens inelegíveis ou já vistos, imponha diversidade, impulsione o frescor, acrescente exploração, aplique regras de negócio e de segurança.
- **Cold start:** itens novos não têm comportamento; use features de conteúdo, sinais do criador e exploração deliberada. Usuários novos não têm histórico; use contexto, popularidade e sinais rápidos de onboarding. O paper do YouTube enquadra o equilíbrio entre conteúdo novo e consolidado "from an exploration/exploitation perspective" `[CONFIRMED]`; as táticas são nossas.
- **Feedback loops:** o que é mostrado determina o que é aprendido, o que pode estreitar as recomendações e favorecer itens já populares. Combata com exploração, restrições de diversidade e tráfego holdout que não é personalizado `[INDUSTRY PATTERN]`.
- **Orçamento de latência:** divida o tempo entre retrieval, busca de features, ranking e re-ranking; guarde em cache user embeddings ou listas de candidatos onde a obsolescência é aceitável; defina timeouts e recorra a uma lista de populares se um estágio falhar.
- **Experimentação:** plataforma de A/B com métricas de guardrail (retenção, reclamações, latência) além da métrica de engajamento que está sendo otimizada.
- **Monitoramento:** deriva de features, distribuições de pontuação do modelo, taxas de candidatos vazios, latência por estágio.

---

## 5. Failure scenarios

- **Uma fonte de candidatos ou o serviço de ANN está fora do ar.** Recorra a outras fontes ou a uma lista de populares em vez de uma página vazia `[INDUSTRY PATTERN]`.
- **Um servidor de treinamento ou de parâmetros falha.** Recupere do snapshot mais recente; o Monolith aceita perder até um dia de atualizações `[CONFIRMED]`.
- **Rótulos atrasados.** Uma conversão chega dias depois da impressão; o joiner precisa consultar features antigas num store em disco `[CONFIRMED]` (Monolith).
- **Training/serving skew.** Perda de qualidade silenciosa; detecte comparando as features de serving registradas com as de treinamento `[INDUSTRY PATTERN]`.
- **O feedback loop estreita o feed.** Acrescente exploração e diversidade, e meça a retenção de longo prazo `[INDUSTRY PATTERN]`.
- **Uma atualização de modelo degrada a qualidade.** Teste num experimento ao vivo antes de ampliar e mantenha o modelo antigo para rollback `[INDUSTRY PATTERN]`.

---

## 6. Capacity reasoning (illustrative)

- **Funil:** milhões de itens para centenas de candidatos para dezenas exibidos, como no número do YouTube. Se o ranking leva 1 ms por 100 candidatos numa máquina (premissa nossa), 10.000 requisições por segundo precisam de máquinas suficientes para sustentar essa taxa com folga.
- **Tamanho da tabela de embeddings** = IDs distintos × dimensão × bytes. 1 bilhão de IDs com 64 dimensões em floats de 4 bytes dá cerca de 256 GB, o que explica por que o Monolith filtra e expira IDs. Os números são premissas nossas.
- **Volume de eventos** = requisições por segundo × itens exibidos por requisição. Registrar toda impressão é muito; amostre campos não críticos.

---

## ⚠️ Reviewer notes

1. **O paper do YouTube é de 2016.** A arquitetura certamente evoluiu; continua sendo o melhor exemplo documentado de dois estágios. Não afirmamos que descreve o YouTube de hoje.
2. **Os números de AUC do Monolith** vêm de uma simulação com dataset público e de um teste A/B ao vivo de anúncios; a Tabela 3 relata uma "AUC improvement" diária cuja unidade o paper não define no texto que lemos, então não citamos os números. Trate o resultado como indicativo.
3. **A descrição da Netflix é de 2013, e os recomendadores de produção do TikTok e do Spotify não são descritos aqui;** citamos apenas os papers e o post que lemos.
4. **Cold start, feedback loops, re-ranking e feature store são prática do setor,** não afirmações com fonte.
5. **Not read:** posts posteriores de engenharia de recomendação da Netflix, papers de retrieval two-tower, papers de ranking multitarefa, literatura de bandits/exploração e documentação de produtos de feature store.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (latência), **escalabilidade**, **frescor/atualidade dos dados**, **experimentabilidade**, **disponibilidade** (degradar, não falhar).
- **Estilo (Ch 13):** um **pipeline** para o serving (retrieve, rank, re-rank) sobre um loop de aprendizado **event-driven**.
- **Quanta (Ch 7):** serving, features em streaming e treinamento são quanta separados, ligados pelo model store e pelo log de eventos.
- **Trade-off (First Law, Ch 1):** **frescor vs confiabilidade e custo.** O aprendizado de nível de minuto se adapta mais rápido e acrescenta modos de falha.
- **Esboço de ADR (Ch 19):** *"Vamos recuperar candidatos por vizinhos mais próximos de embeddings, ranqueá-los com um modelo rico em features e aprender online a partir de um join em streaming. Aceitamos durabilidade reduzida do estado do modelo em troca de recomendações mais frescas."*
- Em linguagem simples: uma lista curta rápida, uma escolha cuidadosa e um caderno atualizado a cada poucos minutos.

---

## Interview questions to practice

1. Projete um sistema de recomendação para um app de vídeo. Por que dois estágios?
2. O que você otimizaria: cliques ou tempo de exibição? Por quê?
3. Como recuperar candidatos entre milhões de itens em dezenas de milissegundos?
4. Como recomendar vídeos novos que não têm histórico? E usuários novos?
5. Como manter o modelo fresco?
6. O que é training/serving skew e como evitá-lo?
7. Como avaliar mudanças? E se o offline e o online discordam?
8. Que feedback loops podem surgir, e o que você faria a respeito?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tipo de item, tamanho do catálogo, objetivo, meta de latência, necessidades de frescor.
2. Estimar: usuários e requisições por segundo, candidatos por estágio, armazenamento de embeddings e features, volume de eventos.
3. API: obter recomendações para um usuário e contexto; registrar eventos.
4. Design: geração de candidatos (embeddings mais outras fontes), ranker, re-ranker, feature store, log de eventos, treinamento e model store.
5. Deep dive: objetivo de treinamento, a correção por example-age ou frescor, cold start, exploração.
6. Falhas e escala: fallbacks de falha de estágio, rótulos atrasados, skew, feedback loops, experimentos.

**Se crescer 10×**
- Retrieval: faça shard do índice ANN e acrescente fontes; mantenha as contagens de candidatos limitadas.
- Features: guarde em cache as features quentes, pré-calcule as pesadas, mantenha a correção point-in-time.
- Treinamento: mais dados por dia empurram para o treinamento incremental/online com o trade-off de confiabilidade.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Por que dois estágios?</summary>

Pontuar milhões de itens com um modelo rico é lento demais. Um modelo barato com poucas features reduz a centenas com recall alto; um modelo mais rico com muitas features ranqueia apenas esses. O custo é que o recall do primeiro estágio limita a qualidade final, então você o mede separadamente.

</details>

<details><summary>Como você trata o cold start?</summary>

Para itens novos, apoie-se em features de conteúdo e no histórico do criador e dê a eles impressões de exploração garantidas; para usuários novos, comece pelo contexto e pela popularidade e aprenda rápido com as primeiras interações. Meça os dois grupos separadamente porque as métricas médias os escondem.

</details>

<details><summary>As métricas offline melhoraram mas o teste A/B não. E agora?</summary>

Confie no teste ao vivo e depois investigue a lacuna: training/serving skew, um descompasso entre o rótulo offline e o objetivo do produto, viés de posição nos dados registrados, ou interferência com outras mudanças. Corrija a métrica offline para que ela preveja a ao vivo, em vez de ignorar a discordância.

</details>

## 📚 Further reading

- Os dois papers listados em Sources and provenance.
- Notas relacionadas neste repositório: [11 News feed](11-news-feed.md), [12 YouTube](12-youtube.md), [13 Netflix](13-netflix.md), [14 Spotify](14-spotify.md), [24 Vector / semantic search at scale](24-vector-semantic-search.md).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).

## Sources and provenance

> **Kind:** real system (YouTube 2016, ByteDance Monolith 2022) com um reference design para a plataforma em volta `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27 (texto dos PDFs extraído localmente):** Covington, Adams and Sargin, [*Deep Neural Networks for YouTube Recommendations*](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45530.pdf) (RecSys 2016) · Liu et al., [*Monolith: Real Time Recommendation System With Collisionless Embedding Table*](https://arxiv.org/pdf/2209.07663) (ByteDance, ORSUM no RecSys 2022) · Amatriain and Basilico, [*System Architectures for Personalization and Recommendation*](https://netflixtechblog.com/system-architectures-for-personalization-and-recommendation-e081aa94b5d8) (Netflix TechBlog, 27 de março de 2013; lido por uma cópia do Internet Archive).
> **Dated material:** papers de 2016 e 2022.
> **Not read:** posts posteriores de recomendação da Netflix, papers de ranking two-tower e multitarefa, literatura de bandits, documentação de feature store.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the YouTube paper: two-stage structure, scale figures (one billion parameters, hundreds of billions of examples), millions to hundreds to dozens funnel, extreme multiclass formulation, sampled negatives and the 100 times speedup, nearest-neighbour serving and insensitivity to the algorithm, example-age feature, ranking with logistic regression and expected watch time, click-through critique, impression features for churn, offline versus A/B statement, the exploration/exploitation remark.
- Verified in the Monolith paper: abstract claims, cuckoo hashmap, ID filtering and expiry, batch and online stages, Kafka and Flink streaming engine and online joiner, log-odds correction, minute-level sparse sync and daily dense sync, the 400 MB per minute example, daily snapshots, Criteo AUC table, Table 3 improvements, the reliability-for-realtime conclusion.
- Verified in the Netflix post: the online, offline and nearline definitions and their trade-offs, the fallback-to-precomputed advice, hybrid combination and hybrid modelling examples, models/data/signals and events/data distinctions, the Manhattan event flow.
- Labelled industry pattern, not sourced: multiple candidate sources beyond the papers, feature store, re-ranking policy, cold-start tactics, feedback-loop mitigations, latency budget, experiment guardrails, capacity arithmetic.
- Not claimed: how any current production recommender (YouTube, TikTok, Netflix, Spotify) works today.
