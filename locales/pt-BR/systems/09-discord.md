# 09 — Discord

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** O núcleo em tempo real do Discord é em Elixir: um processo de sessão por usuário conectado e um processo por guild, com a guild publicando eventos para todas as sessões conectadas. As guilds grandes fizeram do fan-out o gargalo, e o Manifold, componentes em Rust e uma camada de data services com coalescing tratam disso. As mensagens saíram do Cassandra para o ScyllaDB, e a voz roda em servidores separados com um SFU.

**Números principais**
- Quase 5 milhões de usuários concorrentes em 2017; até 500.000 sessões por VM Erlang `[CONFIRMED]`.
- Cassandra 177 nós → ScyllaDB 72 nós; leituras p99 de 40–125 ms → ~15 ms `[CONFIRMED]` (2023).
- Mais de 2,6 milhões de usuários de voz concorrentes em mais de 850 servidores de voz (2018) `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Um processo por guild | Fan-out simples e consistente | Um único processo é um gargalo para guilds grandes |
| Request coalescing nos data services | Uma consulta para muitas leituras idênticas | Um salto extra e roteamento por consistent hash |
| Voz cliente-servidor com um SFU | Mais barato que peer-to-peer em escala, esconde IPs | Frota de servidores e capacidade regional |

**Erros comuns**
- Citar '11 million concurrent users' como um número declarado no corpo do post de 2019.
- Afirmar uma chave literal `(channel_id, bucket)` quando o post diz 'channel plus a bucket'.
- Aplicar os números de 2017 ao sistema de hoje.


---

## 🧒 Non-technical explanation

O Discord é uma **cidade de sedes de clube** (servidores, chamados *guilds*). Cada sede tem uma **recepcionista** (um processo de guild) que sabe quem está lá dentro. Quando alguém fala alguma coisa, a recepcionista grita para todo mundo que está na sala naquele momento. Cada membro também tem seu **assistente pessoal** (uma sessão) que segura a linha de telefone dele e repassa o que a recepcionista grita.

Três problemas dominam:
1. **Salas grandes:** se 30.000 pessoas estão lá dentro, gritar para todas leva muito tempo, então a recepcionista precisa ser esperta na forma de entregar.
2. **Uma sala de arquivo enorme:** toda mensagem já enviada precisa ser arquivada para você poder rolar anos para trás. O sistema de arquivamento precisa continuar rápido mesmo quando todo mundo pede a mesma página.
3. **Chamadas de voz:** o áudio não pode passar pelo mesmo escritório que o texto. Ele usa **centrais telefônicas** separadas, perto de quem fala.

---

## TL;DR for engineers

- **Camada em tempo real em Elixir/Erlang:** cada usuário se conecta por **WebSocket** e ganha um **processo de sessão**. Cada guild é um **processo de guild** em algum nó. As sessões assinam guilds, e uma guild publica eventos para todas as sessões conectadas `[CONFIRMED]` (post de 2017).
- **O fan-out era o gargalo.** Um único `send/2` levava 30–70 µs, então publicar para uma guild de 30.000 usuários podia levar de **900 ms a 2,1 s**. A biblioteca **Manifold** do Discord agrupa os envios por nó remoto e particiona o trabalho entre os núcleos `[CONFIRMED]`.
- **Rust onde Elixir/Go doíam:** NIFs em Rust para a lista de membros (**SortedSet**) e reescritas em Rust de serviços como o **Read States** (o GC do Go causava picos de latência de ~2 minutos) `[CONFIRMED]`.
- **Armazenamento de mensagens:** particionado por **canal + janela de tempo (bucket)**, os IDs são **Snowflakes** (ordenáveis por tempo). Migrou do **Cassandra (177 nós) → ScyllaDB (72 nós)** em 2022, atrás de **data services** em Rust que **coalescem requisições concorrentes idênticas** `[CONFIRMED]` (post de 2023).
- **Voz:** uma frota separada de servidores de voz, cada um com uma parte de **signaling** em Elixir e um **SFU** em C++, cliente-servidor (não peer-to-peer), áudio sobre UDP `[CONFIRMED]` (post de 2018).

---

## 1. Real-time core: sessions and guilds `[CONFIRMED]` (2017 post)

- Um usuário abre um **WebSocket** com o Discord. Isso inicia uma **sessão** (um GenServer do Elixir) que conversa com nós Erlang remotos que hospedam as **guilds** (também GenServers).
- O Discord é "mostly pub/sub": quando algo acontece numa guild, é publicado para **todas as sessões conectadas àquela guild**. Uma guild também publica atualizações de presença, por exemplo quando um usuário fica online.
- Um usuário médio está em cerca de **5 guilds**. Quase **5 milhões de usuários concorrentes** e "millions of events per second" na época, com até **500.000 sessões ativas por VM Erlang** tratando sessões.
- Request/reply entre processos Erlang custa cerca de 12 µs.

### Big guilds hurt `[CONFIRMED]`
Os servidores grandes chegaram a **30.000 usuários concorrentes** (o post cita um servidor de subreddit). No pico, os processos de guild ficavam para trás nas suas filas de mensagens e os engenheiros tinham de intervir manualmente e desligar funcionalidades que geravam mensagens para dar conta (paráfrase). A causa era o custo do fan-out: um `send/2` levava **30–70 µs**, e o post diz que publicar um evento de uma guild grande "could take anywhere from 900ms to 2.1s". Aplicar essa faixa ao exemplo de 30.000 usuários é inferência nossa (30.000 × 30–70 µs ≈ 0,9–2,1 s), não uma afirmação do post.

### Manifold `[CONFIRMED]`
O Manifold distribui o custo de envio. Ele **agrupa os PIDs destinatários por nó remoto**, envia uma mensagem por nó a um `Manifold.Partitioner`, que faz o hash dos PIDs (`:erlang.phash2/2`), os agrupa pela contagem de núcleos e os entrega a workers filhos para a entrega local. O processo remetente chama `send/2` no máximo uma vez por nó remoto envolvido, o que preserva a ordem das mensagens ("linearizability" nas palavras do post) e reduz o tráfego de rede entre nós.

### Other fixes from the same post `[CONFIRMED]`
- **FastGlobal:** uma consulta ao anel de consistent hash copiada do ETS custava ~7 µs por leitura, **17,5 s** no total numa tempestade de restart de sessões. Guardar o anel como dado constante de módulo (um truque no estilo mochiglobal) levou as consultas a 0,3 µs e o total a **750 ms**. Os restarts de sessão levavam ~30 s só em consultas ao anel.
- **Semaphore:** quase 5.000.000 de sessões martelando dez processos de registro de guilds causavam timeouts, acúmulo de retries e quedas em cascata. O Discord escolheu **não** usar um circuit breaker, porque uma rajada de timeouts poderia interromper todas as tentativas. Um semáforo baseado em contador, construído sobre `:ets.update_counter/4`, **falha cedo** quando há requisições demais em andamento.

---

## 2. Rust for the hot spots `[CONFIRMED]`

### Member list: SortedSet (2019 post)
O Discord mudou a lista de membros para enviar atualizações apenas da **parte visível**, o que exigia uma estrutura para **centenas de milhares** de entradas com muitas mutações. As estruturas imutáveis do Elixir faziam com que adicionar um membro a uma lista de 100.000 membros construísse uma nova lista de 100.001.

| Abordagem tentada | Resultado (do post) |
|---|---|
| `MapSet` | Descartado: sem garantia de ordem |
| Wrapper de lista ordenada | ~170.000 µs para acrescentar a uma lista de 250.000 itens |
| `ordsets` do Erlang | ~27.000 µs no pior caso com 250.000 itens |
| OrderedSet baseado em células | ~19.000 µs para inserir no início, levou a um redesign |
| OrderedSet dinâmico | ~4 µs no início, ~640 µs no fim com 250.000 itens. Limitou as guilds a 250.000 membros |
| **SortedSet em Rust NIF** | Melhor 0,61 µs, pior 3,68 µs (5.000 a 1.000.000 de itens). "Powers every single Discord guild" |

Construído com **Rustler**. O post diz que as operações ficam "well under the 1 millisecond threshold", então o time não precisou tratar reductions nem yielding. Aberto como código aberto em `sorted_set_nif`.

### Read States: Go → Rust (2020 post)
O serviço **Read States** acompanha quais canais e mensagens cada usuário leu, e é acionado a cada conexão, envio e leitura de mensagem. O garbage collector do Go forçava uma coleta pelo menos a cada 2 minutos, varrendo um cache LRU de "tens of millions" de entradas, causando "latency and CPU spikes roughly every 2 minutes". Reduzir o cache diminuía os picos, mas aumentava a latência p99. A versão em Rust "had no latency spikes", depois "beat Go on every single performance metric", e o cache foi elevado para 8 milhões de read states.

---

## 3. Message storage `[CONFIRMED]` (2023 post, Bo Ingram)

| Estágio | O que o post diz |
|---|---|
| 2017 | "We ran 12 Cassandra nodes, storing billions of messages" |
| Início de 2022 | "177 nodes with trillions of messages" |
| Depois da migração | "177 Cassandra nodes to just 72 ScyllaDB nodes", cada um com 9 TB de disco (acima da média de 4 TB por nó Cassandra) |

- **Particionamento:** as mensagens são particionadas por **canal mais um "bucket"**, "a static time window". (A chave CQL exata não aparece no texto, então não a declaramos.)
- **IDs:** "Every ID we use is a Snowflake, making it chronologically sortable."
- **Problemas no Cassandra:** **hot partitions** quando muitos usuários liam o mesmo canal ao mesmo tempo, **pausas de GC** (incluindo pausas consecutivas que exigiam reboots manuais) e a **"gossip dance"**: tirar nós de rotação para compactá-los e depois devolvê-los para pegarem os hints, repetido até o backlog acabar.
- **Data services (Rust):** serviços entre o monólito de API e os bancos. **Request coalescing:** "If multiple users are requesting the same row at the same time, we'll only query the database once." O **roteamento por consistent hash** por uma routing key (o ID do canal para as mensagens) envia as requisições de um canal para a mesma instância, para que o coalescing funcione.
- **Migração:** um plano baseado em Spark estimava ~3 meses. Um **migrator em Rust** reescrito, lendo faixas de tokens (com checkpoints em SQLite), levou isso a **"nine days"**, a até **3,2 milhões de mensagens por segundo**. Um último travamento em 99,9999% veio de grandes faixas de tombstones não compactadas. O cutover foi em **maio de 2022**.
- **Resultados:** fetch de mensagens históricas p99 de **40–125 ms → ~15 ms**. Inserts de mensagens de **5–70 ms → estáveis em 5 ms**.

---

## 4. Voice `[CONFIRMED]` (2018 post, Jozsef Vass)

- Os **servidores de voz** têm cada um um componente de **signaling** (Elixir) e um **media relay**, uma **selective forwarding unit (SFU)** caseira em C++ que encaminha áudio e vídeo dentro dos canais e faz a ponte entre clientes de navegador e nativos.
- **Descoberta:** os servidores de voz reportam saúde e carga ao **etcd**. O serviço de Guilds "assigns the least utilized voice server in the given region to the guild", e o cliente é informado de qual usar.
- **Caminho do cliente:** um WebSocket para o gateway e um **segundo WebSocket para o servidor de voz** para o signaling, com **áudio sobre UDP**.
- **Por que cliente-servidor:** o peer-to-peer "becomes prohibitively expensive as the number of participants increases", e o relay esconde os endereços IP dos usuários. Como todo cliente se conecta ao relay, o **ICE não é necessário**.
- **Outras decisões:** signaling customizado em vez de SDP (~1000 bytes para clientes nativos), **Salsa20** em vez de DTLS/SRTP por velocidade, **silence suppression**, uma build de WebRTC em C++ customizada para recursos nativos como push-to-talk, reconexão do cliente a um novo servidor de voz em caso de falha.
- **Escala na época:** **mais de 850 servidores de voz em 13 regiões (30+ data centers)**, **2,6 milhões+ de usuários de voz concorrentes**, egress acima de **220 Gbps**, ~120 milhões de pacotes/s.

---

## 5. How the parts fit (our synthesis)

Enviando uma mensagem, até onde os posts sustentam: o **WebSocket** do cliente chega a um processo de **gateway/sessão** `[CONFIRMED]`, uma mensagem é escrita pela API e pelos **data services** no message store `[CONFIRMED]` para armazenamento, e o **processo da guild** publica o evento para todas as sessões conectadas, usando o Manifold para agrupar a entrega `[CONFIRMED]`. Os posts não mostram a ordem exata desses passos (persistir primeiro ou publicar primeiro), nem como o monólito de API chama o processo da guild, então o fluxo do diagrama é marcado como `[INDUSTRY PATTERN]` onde preenche essa lacuna.

---

## ⚠️ Reviewer notes

1. **Vários números que as pessoas citam não estão nos posts que lemos.** O título do post de 2019 diz "11 million concurrent users", mas no texto que recuperamos o corpo não declara esse número, e não encontramos lá "26,000 events per second" nem o Read States (o Read States está no post separado de 2020). O número da maior guilda ali (200.000) é um exemplo, não um máximo declarado.
2. **Resumos de terceiros do post de storage acrescentam números que não verificamos.** Por exemplo, um texto secundário diz que o MongoDB bateu no limite por volta de 100 milhões de mensagens. Nossa extração do post primário não cobriu o MongoDB, então não fazemos nenhuma afirmação sobre o MongoDB.
3. **A partition key.** Muitos textos afirmam `(channel_id, bucket)` como a chave literal. O post diz "channel plus a bucket", então é isso que dizemos.
4. **A stack antiga não é a stack atual.** Os números do fan-out em Elixir são de 2017, e as mudanças para Rust e ScyllaDB vieram depois. Confira a data de qualquer número antes de citá-lo.
5. **"Discord Hammer"** e nomes parecidos circulam online mas não são explicados no post de 2017.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não dos posts. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **escalabilidade** (milhões de sessões concorrentes), **performance/latência** (fan-out, leituras p99), **disponibilidade**, **elasticidade** em torno de eventos, **operabilidade** (a dor da gossip dance foi uma falha de operabilidade).
- **Estilo (Ch 13/17):** **service-based**, com uma camada de API monolítica na frente de serviços especializados: gateway/guilds (Elixir), data services (Rust), voz (Elixir + C++), storage (ScyllaDB). Dentro da camada em tempo real é um design **actor-model**, pub/sub.
- **Quanta (Ch 7):** a voz é um quantum separado, com frota e failover próprios. O storage de mensagens e o fan-out em tempo real podem degradar de forma independente.
- **Trade-off (First Law, Ch 1):** **simplicidade do actor model vs custo do fan-out em escala.** Cada guild como um processo é simples e consistente, e também é um gargalo. O Manifold, o Rust e o sharding existem para amortizar esse custo.
- **Esboço de ADR (Ch 19):** *"Vamos colocar uma camada de data services com coalescing na frente do message store, roteada por canal. Aceitamos um salto extra para evitar que hot partitions cheguem ao banco."*
- Em linguagem simples: ponha uma recepção na frente da sala de arquivos para que cinquenta pessoas pedindo a mesma página causem uma única ida às prateleiras.

---

## Interview questions to practice

1. Uma guild tem 30.000 membros online. Descreva a entrega de uma mensagem. Onde aparece o primeiro gargalo?
2. Por que particionar as mensagens por canal **e** por um bucket de tempo, em vez de só por canal?
3. Como funciona o request coalescing, e por que ele precisa de roteamento por consistent hash na frente?
4. Por que um circuit breaker falha no caso de thundering herd do Discord, e o que eles usaram no lugar?
5. Voz: por que cliente-servidor em vez de peer-to-peer? O que faz um SFU?
6. Cassandra → ScyllaDB: o que o garbage collector tinha a ver com a latência p99?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: texto, voz, servidores grandes, histórico.
2. Estimar: usuários concorrentes, eventos/s.
3. API: gateway WebSocket mais REST.
4. Design: sessões, guilds, data services, message store.
5. Deep dive: fan-out, hot partitions, coalescing.
6. Falhas e escala: guilds grandes, pausas de GC, failover da voz.

**Se crescer 10×**
- Custo do fan-out: agrupe os envios por nó e mova os caminhos quentes para Rust.
- Canais quentes: coalesça as leituras e roteie por canal.
- Operação do storage: evite bancos pesados em GC para dados críticos em latência.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Uma guild tem 30.000 membros online. Descreva uma mensagem.</summary>

A API a aceita e armazena, o processo da guild publica o evento, e o Manifold agrupa as sessões destinatárias por nó, de modo que cada nó recebe uma mensagem e faz o fan-out localmente.

</details>

<details><summary>Por que particionar as mensagens por canal e bucket de tempo?</summary>

Mantém as mensagens recentes de um canal juntas para leituras rápidas, ao mesmo tempo em que limita o tamanho da partição ao longo do tempo.

</details>

<details><summary>Por que o coalescing precisava de roteamento por consistent hash?</summary>

As requisições do mesmo canal precisam chegar à mesma instância do serviço para que leituras concorrentes idênticas sejam fundidas em uma só consulta.

</details>

## 📚 Further reading

- Os cinco posts do Discord listados no topo.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (contexto sobre caching e consistência, secundária).
- Relacionado neste repositório: [03 Distributed KV store](03-distributed-kv-store.md) (a linhagem do Cassandra), [08 Chat (WhatsApp)](08-chat-whatsapp.md) (chat 1:1 e store-and-forward) e [`neokim-post/13` Slack](https://github.com/allmonty/study/blob/main/architecture/neokim-post/13-how-slack-works.md).

## Sources and provenance

> **Kind:** real-system. O blog de engenharia do Discord documenta sua camada em tempo real (sessões e processos de guild em Elixir), seus componentes em Rust, seu armazenamento de mensagens (Cassandra → ScyllaDB) e seus servidores de voz. Ele **não** publica um único diagrama de arquitetura completo, então o quadro abaixo é montado a partir de cinco posts e tem lacunas.
> **Sources read on 2026-10-27 (all Discord Engineering):** [How Discord Scaled Elixir to 5,000,000 Concurrent Users](https://discord.com/blog/how-discord-scaled-elixir-to-5-000-000-concurrent-users) (2017-07-06) · [Using Rust to Scale Elixir for 11 Million Concurrent Users](https://discord.com/blog/using-rust-to-scale-elixir-for-11-million-concurrent-users) (2019-05-17) · [How Discord Handles Two and Half Million Concurrent Voice Users using WebRTC](https://discord.com/blog/how-discord-handles-two-and-half-million-concurrent-voice-users-using-webrtc) (2018-09-10) · [Why Discord is switching from Go to Rust](https://discord.com/blog/why-discord-is-switching-from-go-to-rust) (2020-02-04) · [How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages) (2023-03-06).
> **Dated material:** cada post descreve o Discord na data de sua publicação. A arquitetura provavelmente evoluiu desde então. Não leia os números de 2017 como atuais.
> **Tags:** `[CONFIRMED]` afirmado num post do Discord · `[INDUSTRY PATTERN]` prática padrão, não declarada para o Discord · `[SPECULATIVE]` plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27, each post fetched and read. Numbers and quotes match the fetched text.*
- Verified (2017 post): date, GenServer sessions and guilds, mostly pub/sub, 30,000 concurrent users in large guilds, `send/2` 30–70 µs and 900 ms–2.1 s publish, Manifold mechanics, FastGlobal figures (7 µs, 17.5 s, 0.3 µs, 750 ms, ~30 s restarts), Semaphore design and the circuit-breaker reasoning, ~5 million concurrent users, 500,000 sessions per VM, ~5 guilds per user, 12 µs request/reply.
- Verified (2019 post): date, the SortedSet problem, each approach and its quoted timings, Rustler, "powers every single Discord guild", `sorted_set_nif`.
- Verified (2018 post): voice components, etcd discovery, least-utilised assignment, UDP audio, no ICE, Salsa20, silence suppression, 850 servers in 13 regions, 2.6 M concurrent voice users, 220 Gbps, 120 Mpps.
- Verified (2020 post): Read States role, Go GC spike every 2 minutes, LRU cache scan, Rust results, 8 million cache capacity.
- Verified (2023 post): date, 12 → 177 Cassandra nodes, 72 ScyllaDB nodes at 9 TB, channel + bucket partitioning, Snowflake IDs, hot partitions, GC pauses, gossip dance, Rust data services with coalescing and channel-based routing, nine-day Rust migrator at 3.2 M messages/s, tombstone stall, May 2022 cutover, latency numbers.
- Corrected/removed: the "11 million concurrent users", "26,000 events per second" and "Read States/Ring" attributions to the 2019 post (not found in the text we retrieved), "Discord Hammer" (not explained in the 2017 post), any MongoDB claim (not verified) and the literal `(channel_id, bucket)` key (the post only says channel plus bucket).
- Method note: the posts were fetched through a summarising tool, so "not found" means not found in the returned extract, not proven absent from the page.
- Scoped: the end-to-end send flow in section 5 is partly `[INDUSTRY PATTERN]` because no post shows the full path.
- Not verified: anything after 2023, current numbers, and whether the Elixir fan-out design is unchanged.
