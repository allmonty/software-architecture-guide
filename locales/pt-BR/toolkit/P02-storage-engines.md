# P02 — Choosing a storage engine: B-tree, LSM and the rest

*Uma introdução ao trade-off por trás da maioria das escolhas de banco de dados. As descrições dos engines vêm da documentação do PostgreSQL e do RocksDB; o guia de decisão é nosso raciocínio e está devidamente rotulado.*

## At a glance

A maioria dos bancos de dados armazena dados de uma de duas formas. Uma **B-tree** mantém dados em páginas ordenadas que são atualizadas no lugar, o que torna as leituras pontuais e as varreduras por intervalo em dados ordenados eficientes `[INDUSTRY PATTERN]`. Uma **LSM tree** (log-structured merge tree) armazena temporariamente as escritas em memória e em um log, grava-as como arquivos imutáveis ordenados e mescla os arquivos em segundo plano (compaction). Os engines são comparados por **amplificação de escrita, leitura e espaço**: o guia de ajuste do RocksDB usa essas três proporções e afirma que a compaction altera o trade-off entre elas `[CONFIRMED]` (para o lado LSM); aplicar a mesma perspectiva às B-trees é prática padrão `[INDUSTRY PATTERN]`. Escolha o engine a partir do padrão de acesso, não por moda.

**Em 60 segundos:** B-tree para cargas OLTP com muitas leituras ou mistas, com consultas por intervalo e semântica transacional forte; LSM para ingestão sustentada com alto volume de escritas, onde o custo da compaction em segundo plano é aceitável; e nunca responda "qual banco de dados?" antes de declarar o padrão de acesso, a necessidade de consistência e a escala.

---

## 1. B-trees `[CONFIRMED]` (PostgreSQL documentation)

O PostgreSQL oferece vários tipos de índice (B-tree, Hash, GiST, SP-GiST, GIN, BRIN e outros), cada um adequado a diferentes tipos de cláusulas, e "by default, the CREATE INDEX command creates B-tree indexes, which fit the most common situations". B-trees "can handle equality and range queries on data that can be sorted into some ordering"; o planner considera um índice B-tree sempre que uma coluna indexada é comparada com `<`, `<=`, `=`, `>=` ou `>`. Outros tipos de índice respondem a perguntas diferentes: GIN é um índice invertido para valores com múltiplos componentes, como arrays; GiST é uma infraestrutura para estratégias como dados geométricos bidimensionais; SP-GiST suporta estruturas não balanceadas como quadtrees e k-d trees; e BRIN armazena resumos de intervalos de blocos consecutivos, o que funciona melhor quando os valores da coluna se correlacionam com a ordem física das linhas. Nossa nota [16 Reservation scheduler](../systems/16-reservation-scheduler.md) mostra índices B-tree e GiST aplicando correção com restrições de exclusão.

## 2. LSM trees `[CONFIRMED]` (RocksDB documentation)

As três construções básicas do RocksDB são a **memtable** (uma estrutura em memória que recebe novas escritas), o **sstfile** (arquivos ordenados no armazenamento) e o **logfile** (um write-ahead log para que uma reinicialização possa reproduzir o que estava apenas em memória). Todos os dados são mantidos em ordem ordenada, de modo que tanto as buscas pontuais quanto as varreduras por intervalo são suportadas, mas uma leitura pode precisar percorrer vários arquivos. Quando uma memtable fica cheia, ela é gravada como um arquivo ordenado, e a **compaction** mescla os arquivos em segundo plano para remover dados sobrescritos e excluídos e manter as leituras eficientes.

**As três amplificações** (guia de ajuste do RocksDB):
- **Write amplification:** bytes gravados no armazenamento em relação aos bytes escritos no banco de dados; o exemplo dado é 10 MB/s de escritas causando 30 MB/s de escritas em disco, uma amplificação de 3. Uma write amplification elevada pode ser um gargalo de throughput e reduz a vida útil de memórias flash.
- **Read amplification:** o número de leituras em disco por consulta.
- **Space amplification:** o tamanho dos arquivos em disco em relação ao tamanho dos dados.

**Os estilos de compaction fazem o trade-off entre eles** (página de compaction do RocksDB): a classic **leveled** compaction "minimizes space amplification at the cost of read and write amplification"; a **tiered** compaction "minimizes write amplification at the cost of read and space amplification"; a leveled-N fica no meio-termo. O RocksDB implementa um híbrido tiered+leveled (sua compaction "level" padrão), um estilo tiered que chama de universal, e FIFO. A tiered compaction também pode precisar de grande espaço transitório ao mesclar o maior sorted run.

## 3. Other families and where the atlas shows them `[INDUSTRY PATTERN]`

| Need | Typical choice | Atlas note |
|---|---|---|
| Transações, joins, restrições, escala moderada | Banco de dados relacional com índices B-tree | [16 Reservations](../systems/16-reservation-scheduler.md), [17 Payments](../systems/17-payment-system.md) |
| Grande escala, acesso simples por chave, alta disponibilidade | Store key-value particionado (frequentemente baseado em LSM) | [03 Key-value store](../systems/03-distributed-kv-store.md), [09 Discord](../systems/09-discord.md) |
| Streams somente de acréscimo e reprodução | Log replicado | [04 Kafka](../systems/04-message-queue-kafka.md) |
| Grandes blobs | Object storage | [05 S3](../systems/05-object-storage-s3.md), [07 Photos](../systems/07-photo-upload-storage.md) |
| Busca em texto completo | Índice invertido | [20 Search](../systems/20-web-crawler-search.md) |
| Séries temporais | Store de séries temporais comprimido | [30 Monitoring](../systems/30-metrics-monitoring-alerting.md) |
| Busca por similaridade | Índice ANN | [24 Vector search](../systems/24-vector-semantic-search.md) |
| Agregações sobre eventos | Store de agregados versionados | [31 Ad clicks](../systems/31-ad-click-aggregation.md) |

## 4. How to answer "which database?" `[INDUSTRY PATTERN]`

1. Declare os **padrões de acesso**: leituras pontuais, varreduras por intervalo, escritas por segundo, proporção leitura/escrita, tamanho dos registros.
2. Declare as **necessidades de consistência e transação**: linha única ou múltiplas linhas, se você precisa de joins, restrições únicas ou restrições de exclusão.
3. Declare as necessidades de **escala e disponibilidade**: um nó com réplicas, ou particionamento entre muitos nós e entre regiões.
4. Nomeie o **padrão** (um banco de dados relacional é a resposta certa com mais frequência do que as entrevistas sugerem), depois indique o que faria você abandoná-lo: volume de escritas além de um primary, acesso key-value em escala muito grande, ou um tipo especial de consulta.
5. Diga o que você abre mão: para um engine LSM, read amplification, space amplification e ajuste de compaction; para um engine B-tree, write amplification para atualizações aleatórias e atualizações de página no lugar.
6. Mencione operações: backups e tempo de restauração (veja [C03 GitHub 2018](C03-github-2018.md)), mudanças de schema e a experiência da equipe.

---

## Questions to practise

1. Por que uma LSM tree consegue sustentar cargas de escrita mais pesadas do que uma B-tree no mesmo disco, e o que ela paga por isso?
2. O que são write amplification, read amplification e space amplification? Dê um exemplo de workload em que cada uma é mais relevante.
3. Quando você escolheria tiered em vez de leveled compaction?
4. Quando um banco de dados relacional ainda é a resposta certa em grande escala?
5. Uma tabela precisa de consultas por intervalo de timestamp e buscas pontuais por id. Quais índices você criaria?

## Practice

Para cada sistema na tabela do atlas acima, escreva uma frase sobre por que a escolha de armazenamento se encaixa no padrão de acesso e outra sobre o que faria você mudá-la.

**Related:** [03 Key-value store](../systems/03-distributed-kv-store.md), [09 Discord](../systems/09-discord.md), [16 Reservation scheduler](../systems/16-reservation-scheduler.md), [C03 GitHub 2018](C03-github-2018.md).

## Sources and provenance

> **Sources read on 2026-10-27:** PostgreSQL documentation, [11.2 Index Types](https://www.postgresql.org/docs/current/indexes-types.html) · RocksDB wiki, [RocksDB Overview](https://github.com/facebook/rocksdb/wiki/RocksDB-Overview), [Compaction](https://github.com/facebook/rocksdb/wiki/Compaction) and [Tuning Guide](https://github.com/facebook/rocksdb/wiki/RocksDB-Tuning-Guide) (read from the wiki's source text).
> **Dated material:** Documentation pages as of 2026-10-27; RocksDB's page cites the O'Neil et al. LSM paper and the Dostoevsky paper, which we did not read.
> **Not read:** The original LSM-tree paper, the Bigtable paper (its PDF text did not extract), Dostoevsky, and comparisons of storage engines on benchmark workloads.
> **Tags:** `[CONFIRMED]` stated by a primary source · `[INDUSTRY PATTERN]` standard practice · `[SPECULATIVE]` plausible or illustrative. Anything not tagged `[CONFIRMED]` is our reasoning.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the PostgreSQL page: the list of index types, B-tree as the default, and the equality and range statement.
- Verified in the RocksDB pages: memtable, sstfile and logfile, the three amplification definitions and example, and the leveled, tiered and RocksDB implementation statements.
- Not sourced (our reasoning): the decision guide, the table of needs, and the interview procedure.
