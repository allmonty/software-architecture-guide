# 35 — Unique ID Generation

*Nota de sistemas reais do Twitter's Snowflake, dos servidores de tickets do Flickr e do padrão UUID (RFC 9562), além de um design de referência para escolher entre eles. Como foi obtido e o que não foi verificado está em **Sources and provenance** perto do final.*

## At a glance

**Em 60 segundos.** Sistemas distribuídos precisam de identificadores que sejam **únicos** sem uma sequência de banco de dados centralizada, e frequentemente **aproximadamente ordenados por tempo** (para que os índices permaneçam eficientes e consultas do tipo "mais novo que o id X" funcionem) e **compactos**. Existem três famílias: (1) **contadores coordenados**, como os servidores de tickets do Flickr, (2) **IDs baseados em tempo não coordenados**, como o Snowflake (timestamp + id da máquina + sequência em 64 bits), e (3) **UUIDs aleatórios ou ordenados por tempo** (128 bits, incluindo agora o UUIDv7). As questões de design são garantias de unicidade, ordenação, tamanho, comportamento do relógio (e se o tempo voltar?) e quem atribui os ids de máquina.

**Números-chave** (conforme publicado)
- IDs Snowflake: 41 bits de milissegundos desde um epoch personalizado (cerca de 69 anos), 10 bits de id de máquina (até 1.024 máquinas) e 12 bits de sequência (4.096 por milissegundo por máquina) `[CONFIRMED]`.
- Requisitos do Snowflake: pelo menos 10.000 IDs por segundo por processo, uma resposta em cerca de 2 ms, k-sorted dentro de 1 segundo (visando dezenas de milissegundos) `[CONFIRMED]`.
- Servidores de tickets do Flickr: dois servidores, um emitindo IDs ímpares e outro pares, em produção desde janeiro de 2006 `[CONFIRMED]`.
- UUIDv7: timestamp Unix de 48 bits em milissegundos, o restante aleatório ou um contador, em 128 bits `[CONFIRMED]`.

**Decisões e trade-offs**

| Option | Strength | Weakness |
|---|---|---|
| Single database sequence | Simples, estritamente crescente | Um único escritor; um gargalo e ponto único de falha |
| Ticket servers (odd/even) | Simples, sequencial por servidor, chaves pequenas | Não estritamente ordenado entre servidores; os servidores precisam estar em execução e ficam no caminho de escrita |
| Snowflake-style | Sem coordenação por ID, compacto em 64 bits, aproximadamente ordenável | Depende de relógios; requer ids de máquina únicos |
| Random UUIDv4 | Sem coordenação alguma | 128 bits, má localidade de índice |
| UUIDv7 | Sem coordenação, ordenado por tempo, padronizado | 128 bits; dependência do relógio para ordenação |

**Erros comuns**
- Supor que timestamps de máquinas diferentes fornecem uma ordem global estrita.
- Ignorar o que acontece quando o relógio de uma máquina volta no tempo.
- Reutilizar um id de máquina após uma reinicialização sem verificar se está livre.
- Escolher UUIDs aleatórios como chaves primárias clusterizadas para uma tabela com muitas escritas e depois se perguntar por que os inserts são lentos.

---

## 🧒 Non-technical explanation

Imagine muitas bilheterias emitindo tickets numerados **sem linha telefônica entre elas**. Se cada bilheteria simplesmente contasse a partir do 1, haveria duplicatas. Em vez disso, cada ticket é carimbado com *hora, número da bilheteria e um contador para tickets naquele mesmo momento*. Duas bilheterias nunca podem produzir o mesmo carimbo porque seus números diferem, e os tickets ficam em uma ordem de tempo quase correta. A única forma de quebrar isso é se o relógio de uma bilheteria saltar para trás, então uma bilheteria cuidadosa recusa emitir tickets até que seu relógio se atualize.

---

## TL;DR for engineers

- **Snowflake:** geração não coordenada de ids de 64 bits, aproximadamente ordenados por tempo, a partir de timestamp, número do worker e sequência por thread; números de worker atribuídos na inicialização via ZooKeeper `[CONFIRMED]`.
- **Ticket servers:** `REPLACE INTO` em uma tabela de uma única linha fornece um auto-increment atômico; dois servidores dividem ímpares e pares `[CONFIRMED]`.
- **UUIDs:** identificadores de 128 bits; RFC 9562 recomenda UUIDv7 para novos sistemas que não precisam de UUIDv1 legado `[CONFIRMED]`.
- **Segurança do relógio, esgotamento de id, ids que codificam shard:** orientação de referência `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcional:** gerar um id único sob demanda · (frequentemente) ordenável por tempo de criação · utilizável como chave primária · utilizável entre shards e data centers.

**Não-funcional:** **throughput** (milhares a milhões por segundo) · **latência** (uma chamada local, idealmente) · **availability** (a geração de id não deve ser ponto único de falha) · **tamanho** (cabe em 64 bits para índices compactos, ou aceitar 128) · garantia de **ordenação** (nenhuma, k-sorted, estrita) · **segurança** (os ids devem ser adivinháveis?).

**Perguntas de esclarecimento:** a ordenação é necessária e quão estrita? Qual é o limite de tamanho do id? Quantos escritores? Os ids são expostos aos usuários (risco de enumeração)? A geração pode depender de um serviço?

---

## 2. Snowflake (Twitter, 2010) `[CONFIRMED]`

O Twitter estava migrando do MySQL para Cassandra ou MySQL com sharding, nenhum dos quais tem uma forma integrada de gerar ids únicos, e precisava gerar "dezenas de milhares de ids por segundo de forma altamente disponível", o que os levou a "uma abordagem não coordenada". Os requisitos no README do projeto: pelo menos 10.000 ids por segundo por processo; uma resposta em 2 ms mais a latência de rede; geração **não coordenada** entre máquinas, para disponibilidade dentro e entre data centers; **aproximadamente ordenado por tempo**, com ids k-sorted dentro de um limite prometido de 1 segundo (visando dezenas de milissegundos), porque os recursos de API assumem uma ordenação; **diretamente ordenável**; **compacto** (abaixo de 64 bits; esquemas de 128 bits foram rejeitados, em parte porque aumentar os bits usados para ids de tweets havia sido doloroso antes); e **altamente disponível**.

**Opções que consideraram:** servidores de tickets MySQL "como o Flickr usa", que não forneciam as garantias de ordenação que precisavam sem uma rotina de ressincronização; UUIDs, onde "todos os esquemas que encontramos exigiam 128 bits"; e nós sequenciais do ZooKeeper, que não conseguiram fazer funcionar com performance suficiente, e "temíamos que a abordagem coordenada baixasse nossa disponibilidade sem benefício real".

**Layout:** um servidor Thrift escrito em Scala; cada id é composto por **tempo, 41 bits** (precisão de milissegundo com um epoch personalizado, "69 anos"), **id de máquina configurado, 10 bits** (até 1.024 máquinas), e **número de sequência, 12 bits** (reinicia a cada 4.096 por máquina, com proteção para evitar reinício no mesmo milissegundo). Os números de sequência são por thread; os números de worker são escolhidos na inicialização via ZooKeeper (substituível na configuração).

**Dependência do relógio:** o README diz para usar NTP e observa que o Snowflake protege contra relógios não monotônicos: se o relógio voltar, o Snowflake "se recusará a gerar ids até um momento posterior ao último momento em que gerou um id". Também sugere executar o NTP em um modo que nunca move o relógio para trás.

Nossa aritmética: 2^41 ms ≈ 2,2 × 10^12 ms ≈ 69,7 anos, e 4.096 ids por ms por máquina são cerca de 4,1 milhões de ids por segundo por máquina no máximo, bem acima do requisito de 10.000 por segundo.

## 3. Flickr ticket servers (2010) `[CONFIRMED]`

O Flickr precisava de inteiros globalmente únicos como chaves primárias em bancos de dados MySQL com sharding construídos como pares master-master; o auto-increment do MySQL não pode garantir unicidade entre bancos de dados. Eles rejeitaram GUIDs "principalmente porque GUIDs são grandes e têm má indexação no MySQL", e rejeitaram consistent hashing como mais adequado para ambientes de escrita barata como LSM-trees. Sua solução: um servidor de banco de dados dedicado com uma tabela por sequência (por exemplo, `Tickets64`) contendo uma única linha; `REPLACE INTO Tickets64 (stub) VALUES ('a'); SELECT LAST_INSERT_ID();` produz atomicamente um novo id auto-incrementado. Para evitar um ponto único de falha, executam **dois servidores de tickets**, um com auto-increment-increment 2 e offset 1, o outro com offset 2 (ids ímpares e pares), e fazem round-robin entre eles; os dois ficam ligeiramente fora de sincronia (algumas centenas de milhares a mais de ids ímpares que pares na época), "mas isso não prejudica ninguém". Mantêm sequências separadas para fotos, contas, tarefas offline e grupos. O design estava em produção desde 13 de janeiro de 2006 e o autor o descreve como um ótimo exemplo do princípio de design "coisa mais simples possível que funcione" da engenharia do Flickr.

## 4. UUIDs (RFC 9562) `[CONFIRMED]`

UUIDs são identificadores de 128 bits. O RFC diz que o UUIDv6 é uma reordenação compatível de campos do UUIDv1 para melhor localidade de banco de dados, e que sistemas que não envolvem UUIDv1 legado "SHOULD usar UUIDv7". O UUIDv7 "apresenta um campo de valor ordenado por tempo derivado da fonte de timestamp Unix Epoch amplamente implementada e bem conhecida", com um timestamp Unix em milissegundos nos 48 bits mais significativos e os 74 bits restantes (excluindo bits de versão e variante) preenchidos com bits aleatórios, ou alternativamente com sub-campos como um contador para garantir monotonicidade. A ordenação por tempo é o que resolve a reclamação de localidade de índice que o Flickr fez sobre GUIDs.

---

## 5. Choosing and operating `[INDUSTRY PATTERN]`

| Need | Reasonable choice |
|---|---|
| Baixo volume, um escritor | Sequência de banco de dados |
| Chaves de 64 bits compactas, muitos escritores, ordenação aproximada | Snowflake-style |
| Formato padrão, sem coordenação, 128 bits aceitável | UUIDv7 |
| Ids que não devem ser adivinháveis | Aleatório (UUIDv4) ou um mapeamento opaco; não expor ids sequenciais |
| Ids conscientes de shard | Reserve bits para o shard, como o Instagram fez (41 bits de tempo, 13 bits de shard, 10 bits de sequência; veja [11 News feed](11-news-feed.md)) para que o shard de um registro seja derivável de seu id |

**Operando um serviço no estilo Snowflake.**
- **Machine ids:** atribua de forma única e verifique na inicialização (um serviço de coordenação, uma tabela de lease ou um sistema de configuração; veja [33 Coordination](33-distributed-coordination-locks.md)). Reutilizar um id enquanto o processo antigo ainda está em execução gera duplicatas.
- **Relógios:** use NTP; em um passo para trás, recuse emitir ids ou aguarde, como o Snowflake faz; alerte sobre desvio de relógio. O "smearing" de segundos intercalares mantém o tempo monotônico.
- **Esgotamento:** a parte de sequência limita ids por milissegundo por máquina; quando esgotada, aguarde o próximo milissegundo. A parte de tempo tem um horizonte fixo (cerca de 69 anos a partir do epoch).
- **Bibliotecas locais versus serviço:** incorporar o gerador em cada aplicação evita um salto de rede, mas espalha a atribuição de machine-id; um pequeno serviço a centraliza.
- **Expectativas de ordenação:** ids são apenas aproximadamente ordenados entre máquinas; não os use para inferir causalidade exata.

---

## 6. Failure scenarios

- **O relógio volta.** Recuse emitir ids até que o tempo passe do último timestamp usado `[CONFIRMED]` (Snowflake).
- **Dois workers compartilham um machine id.** Duplicatas são possíveis; a atribuição deve ser exclusiva `[INDUSTRY PATTERN]`.
- **Um servidor de tickets está fora do ar.** O outro continua e ids continuam vindo de sua paridade; os clientes fazem round-robin ao redor dele `[CONFIRMED]` (Flickr).
- **Overflow de sequência dentro de um milissegundo.** Bloquear até o próximo milissegundo `[CONFIRMED]` (proteção do Snowflake) / `[INDUSTRY PATTERN]` para a regra geral.
- **Serviço de ID inacessível.** Clientes com um gerador embutido continuam funcionando; clientes que dependem de um serviço precisam de buffering de blocos pré-alocados `[INDUSTRY PATTERN]`.

---

## 7. Capacity reasoning (illustrative)

- Um worker Snowflake pode emitir até 4.096 ids por milissegundo, cerca de 4,1 milhões por segundo; uma frota precisa de poucos workers para qualquer carga de trabalho realista.
- Tamanho do índice: ids de 8 bytes versus UUIDs de 16 bytes. Para uma tabela com 1 bilhão de linhas, a coluna de chave sozinha ocupa 8 GB versus 16 GB, e cada índice secundário repete a chave (nossa aritmética).
- O risco de colisão para UUIDs aleatórios de 122 bits é negligenciável em escalas práticas (uma propriedade padrão de UUIDs aleatórios; não computado aqui).

---

## ⚠️ Reviewer notes

1. **O post de blog e o README do Snowflake são de 2010** e descrevem software de qualidade alfa que o Twitter disse que ainda não estava executando em produção naquela época; o layout é amplamente copiado, mas detalhes posteriores do Twitter não foram lidos.
2. **Os números do servidor de tickets do Flickr** (mais de 60 fotos por segundo, desvio de algumas centenas de milhares) são de 2010.
3. **O layout 41/13/10 do Instagram** é citado da nota 11; o post original não pôde ser obtido nesta sessão.
4. **Not read:** orientação completa da RFC 9562 sobre retrocesso de relógio e monotonicidade, especificações de ULID e KSUID, sequências nativas de banco de dados em sistemas SQL distribuídos.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Nossa análise, não proveniente das fontes. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Driving characteristics (Ch 4–5):** **availability**, **performance**, **scalability**, **data locality** (compatibilidade com índices).
- **Style (Ch 13):** uma **biblioteca embutida ou serviço minúsculo sem estado**; o único estado compartilhado é a atribuição de machine-id.
- **Quanta (Ch 7):** cada worker é independente assim que tem seu id.
- **Trade-off (First Law, Ch 1):** **coordenação vs ordenação e tamanho.** Remover a coordenação custa a ordenação estrita e vincula a correção aos relógios.
- **ADR sketch (Ch 19):** *"We will generate 64-bit time-based ids in each service instance with a machine id leased at startup, and refuse to issue ids when the clock moves backwards. We accept rough ordering and clock dependence in exchange for no per-id coordination."*
- Em termos simples: carimbe cada ticket com hora, bilheteria e contador.

---

## Interview questions to practice

1. Projete um gerador de IDs únicos para um sistema distribuído.
2. Por que não usar auto-increment de banco de dados? Por que não UUIDv4?
3. Quais são as partes de um id Snowflake e o que cada uma limita?
4. O que acontece se o relógio do sistema voltar?
5. Como você atribui machine ids com segurança?
6. Os ids Snowflake são estritamente ordenados? O que você garante?
7. Como você geraria ids que codificam o shard?

## Interview practice

Esses esboços são nosso próprio raciocínio (`[INDUSTRY PATTERN]`), não declarações das fontes.

**Um guia de 45 minutos**

1. Esclarecer: ordenação, tamanho, exposição, volume, disponibilidade.
2. Estimar: ids por segundo, pico por máquina, tamanho da chave e do índice ([P01](../toolkit/P01-estimation.md)).
3. API: `nextId()` (chamada local ou serviço), batch opcional.
4. Design: layout dos bits, atribuição de machine-id, tratamento de relógio, tratamento de sequência.
5. Aprofundamento: tempo voltando, unicidade do machine-id, promessa de ordenação.
6. Falha e escala: ids de worker duplicados, serviço fora do ar, taxa 10×, horizonte do epoch.

**Se crescer 10×**
- A sequência de 12 bits limita a taxa por máquina; adicione workers ou mova bits da parte da máquina.
- Reavalie a divisão de bits se a frota ultrapassar 1.024 workers.
- Mantenha os ids opacos para os clientes para que o layout possa mudar.

**Esboços de resposta** (tente as perguntas acima primeiro)

<details><summary>What if the clock moves backwards?</summary>

O gerador poderia repetir um timestamp e, com o mesmo machine id e sequência, repetir um id. Lembre-se do último timestamp utilizado; se o relógio estiver atrás dele, aguarde até que passe (ou falhe a requisição) e alerte sobre o desvio. Prefira configurações de NTP que não avançam para trás.

</details>

<details><summary>How do you assign machine ids safely?</summary>

Use um lease de um serviço de coordenação ou uma linha de banco de dados com uma atualização condicional, mantido pelo tempo de vida do processo, e recuse iniciar sem um. Nunca dependa apenas de hostnames ou IPs, pois eles podem ser reutilizados enquanto uma instância antiga ainda está em execução.

</details>

<details><summary>Snowflake or UUIDv7?</summary>

Se as chaves devem ter 64 bits e você consegue operar a atribuição de machine-id, o estilo Snowflake. Se você quer um formato padrão, sem etapa de atribuição e pode tolerar 128 bits, UUIDv7, que tem o mesmo benefício de ordenação por tempo para índices.

</details>

## 📚 Further reading

- As fontes listadas em Sources and provenance.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundário).
- Relacionados neste repositório: [01 URL shortener](01-url-shortener.md) (geração de chave), [11 News feed](11-news-feed.md) (ids com bits de shard), [33 Coordination](33-distributed-coordination-locks.md), [03 Distributed key-value store](03-distributed-kv-store.md), [P02 Storage engines](../toolkit/P02-storage-engines.md).

## Sources and provenance

> **Kind:** sistemas reais (Snowflake, Flickr) e um padrão (UUID), com um design de referência `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Twitter Engineering, [*Announcing Snowflake*](https://blog.twitter.com/engineering/en_us/a/2010/announcing-snowflake) (1 June 2010; Internet Archive copy) · Twitter, [Snowflake README](https://raw.githubusercontent.com/twitter-archive/snowflake/snowflake-2010/README.mkd) (2010 branch) · Flickr, [*Ticket Servers: Distributed Unique Primary Keys on the Cheap*](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/) (8 February 2010) · IETF, [RFC 9562, Universally Unique IDentifiers (UUIDs)](https://www.rfc-editor.org/rfc/rfc9562.txt).
> **Material datado:** posts de engenharia de 2010; o RFC é recente.
> **Not read:** o post do Instagram sobre sharding e IDs (bloqueado), descendentes posteriores do Snowflake, ULID e KSUID, e a orientação completa da RFC 9562.
> **Tags:** `[CONFIRMED]` declarado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each source. Quotations are confirmed by `npm run verify`.*
- Verified in the Snowflake post and README: the motivation, requirements, options considered, the 41/10/12 layout, ZooKeeper machine ids, and the clock-backwards behaviour.
- Verified in the Flickr post: the reasons against GUIDs and consistent hashing, the `REPLACE INTO` mechanism, the odd/even pair, drift, separate sequences and the 2006 start.
- Verified in RFC 9562: UUIDv7's definition and layout, the UUIDv6 statement and the SHOULD recommendation.
- Not sourced (our reasoning): the choice table, operating guidance, capacity arithmetic and interview outlines.
- Not claimed: Twitter's or Instagram's current id generation.
