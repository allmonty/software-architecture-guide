# 29 — Live Streaming (Twitch)

*Partes de real-system dos próprios posts de engenharia da Twitch, mais um reference design para o que a Twitch não publica. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um streamer envia um único stream de vídeo (RTMP) a um point of presence próximo. A Twitch o carrega por um backbone privado até um data center de **origem**, onde ele é transcodificado em várias qualidades e empacotado como HLS. Os segmentos descem por uma árvore de data centers até os espectadores, que os puxam por HTTP comum. O chat é um sistema de tempo real separado: servidores de borda compatíveis com IRC aceitam as mensagens, um serviço de regras decide se as entrega, e uma camada de publish/subscribe faz o fan-out delas. As partes difíceis são o custo do transcoding, escolher qual origem trata cada stream, manter o atraso baixo e o fan-out numa sala de chat com uma audiência muito grande.

**Números principais** (todos como publicados, com o ano)
- Quase uma centena de points of presence no mundo todo, cada um conectado a um backbone privado `[CONFIRMED]` (post de 2022).
- As origens guardam "hundreds to thousands of servers" para transcoding `[CONFIRMED]` (post de 2023).
- A latência foi de cerca de 15 s para cerca de 10 s, depois para cerca de 3 s com o que o entrevistado chama de "low-latency HTTP live streaming" próprio da Twitch (não necessariamente o LL-HLS da Apple), e para 1,5 s em alguns casos na Coreia `[CONFIRMED]` (entrevista de 2021).
- O transcoding com a abordagem anterior alcançava apenas 2–3% dos canais; um transcoder em hardware visa 10× a capacidade por 2× o custo `[CONFIRMED]` (entrevista de 2021).
- Média de espectadores ativos acima de 2,5 milhões, 1,3 trilhão de minutos assistidos por ano, 7 milhões de streamers por mês `[CONFIRMED]` (post de 2023).
- O volume do chat é **inconsistente nos próprios posts da Twitch**: "over 10 billion messages a day" e "hundreds of billions of messages per day" aparecem no mesmo post de 2015. Tratamos isso como não resolvido.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Terminar os streams num PoP próximo, carregá-los num backbone privado | Os streamers se conectam rápido; evita a instabilidade da Internet pública | Ser dono de um backbone e operá-lo |
| Rotear cada stream a uma origem com um controlador central (Intelligest) | Usa bem a computação entre fusos horários e reroteia ao redor de uma origem com falha | Um serviço de roteamento que precisa continuar correto e disponível |
| Transcodificar em várias qualidades | Espectadores em qualquer dispositivo e rede conseguem assistir | O transcoding é computacionalmente caro; o principal fator de custo |
| HLS sobre HTTP, entregue por uma árvore de data centers | Cacheável, escala com os espectadores | A segmentação acrescenta atraso; menos atraso exige protocolos mais complexos |
| Chat como sistema próprio com Edge, Pubsub e um serviço de regras | Milhões de conexões e fan-out pesado, com moderação | Um segundo grande sistema de tempo real para operar |

**Erros comuns**
- Projetar um único pipeline para vídeo e chat. Eles têm modos de falha diferentes e escalam em eixos diferentes (banda e CPU versus conexões e fan-out).
- Esquecer que um stream vira muitos: cinco qualidades para cada um de 300.000 broadcasters são 1.500.000 streams a produzir, como o próprio exemplo da entrevista mostra.
- Citar volumes de chat da Twitch ou detalhes do transcoder com confiança. A Twitch não publica um número consistente nem os internals do transcoder.

---

## 🧒 Non-technical explanation

Imagine uma **emissora de TV local que qualquer pessoa pode operar de casa**. Um apresentador fala para uma câmera. O sinal vai até a torre de retransmissão mais próxima, depois pelos cabos da própria empresa até um grande estúdio. O estúdio faz várias cópias do programa: nítida para quem tem conexão rápida, mais grosseira para quem está num celular lento. As cópias são cortadas em clipes curtos e enviadas a escritórios regionais, e o player de cada espectador continua pedindo ao escritório mais próximo o próximo clipe.

Enquanto isso, uma **sala de bate-papo** separada funciona ao lado do programa. Cada mensagem passa por um porteiro que confere as regras, depois por um sistema de alto-falantes que a repete a todos na sala.

---

## TL;DR for engineers

- **Caminho do vídeo:** broadcaster → PoP (media proxy) → backbone → origem (transcode, package) → árvore de replicação → espectador `[CONFIRMED]`.
- **Roteamento:** um serviço central de roteamento decide qual origem recebe cada stream, usando dados de capacidade ao vivo. Ele substituiu a configuração estática do HAProxy `[CONFIRMED]`.
- **Entrega:** playlists e segmentos HLS sobre HTTP. O Low-latency HLS acrescenta segmentos parciais e requisições de playlist que esperam por dados novos `[CONFIRMED]` (spec).
- **Chat:** Edge compatível com IRC, Clue para regras, Pubsub para fan-out, Room para listas de espectadores `[CONFIRMED]`.
- **Não publicado:** internals do transcoder, a bitrate ladder, a criação de clips e taxas consistentes de chat `[SPECULATIVE]` onde preenchemos.

---

## 1. Requirements (design framing)

**Funcionais:** transmitir a partir de software de encoder · assistir ao vivo em muitos dispositivos · bate-papo com moderação · salvar uma gravação (VOD) e criar destaques ou clips · descoberta e notificações.

**Não funcionais:** **atraso glass-to-glass** baixo o bastante para conversa · **disponibilidade** quando uma origem ou link falha · **custo** do transcoding e da banda · **tolerância a picos** (um canal grande pode ir de poucos espectadores a milhões) · **chat** que pareça imediato.

**Perguntas de esclarecimento:** quantos streams e espectadores concorrentes? Atraso alvo (alguns segundos ou subsegundo)? Quais dispositivos? A interação (chat, enquetes) faz parte do produto? Gravação obrigatória? Orçamento para transcodificar todos os canais?

---

## 2. The video path `[CONFIRMED]`

**Ingest.** A visão geral de 2015 declara o primeiro passo de forma direta: "We take RTMP video in, and then transport it to the transcode system." O post de ingest de 2022 acrescenta que a Twitch "maintains nearly a hundred points of presence (PoPs) in different geographic regions around the world", que cada PoP "is connected to our private backbone network", e que os streams recebidos num PoP são enviados adiante às origens. Usar o backbone permite à Twitch "overcome the instability of the public Internet, especially when delivering time-sensitive data like live video".

**Transcoding e empacotamento.** As origens "host the resources that are needed to provide computationally intensive media transformations, like video transcoding". O post de 2023 diz que o sistema de transcoding "takes an incoming Real Time Messaging Protocol (RTMP) stream from the creator, and turns it into an HLS-compliant stream" com "several variations of the stream with a range of video resolutions and bitrates". Não sabemos a ladder exata (quais resoluções e bitrates); a Twitch não a publica nos posts que lemos.

**Distribuição.** Depois que um stream é transcodificado, o post de 2023 diz que a distribuição de vídeo garante a entrega "as quickly as possible" por "a network of data centers distributed across the world, which are organized in a directed graph hierarchy we call a Replication Tree". A requisição de um espectador vai ao datacenter mais próximo, que a encaminha árvore acima até a origem. Detalhes de caching e do formato da árvore não são dados.

**Gravação.** Se a gravação está ativada, o sistema "stores a copy of all generated segments, thumbnails, and playlists in one of our Simple Storage Service (S3) buckets" (post de 2023). Os streamers podem então cortar destaques da gravação.

---

## 3. Choosing an origin: Intelligest `[CONFIRMED]`

**Histórico.** A Twitch começou com uma origem no Vale do Silício, com o HAProxy em cada PoP terminando os streams e encaminhando-os. À medida que as origens se espalharam pelo mundo, cada PoP "still ran HAProxy and statically sent live video streams to only one of the origins". O post lista os problemas: a atividade de transmissão segue um ciclo diário, então cada origem precisava ser dimensionada para o pico da sua região em vez do pico global; a configuração estática dificultava tratar surtos e perda de capacidade; as origens têm tamanhos diferentes; e o HAProxy não conseguia detectar falhas complexas de origem, por exemplo "an outage in a control plane or loss of backbone capacity".

**A substituição.** A Twitch aposentou o HAProxy e construiu o **Intelligest** com duas partes. O **media proxy** roda em todo PoP, termina o stream do broadcaster e "can terminate any number of media transport protocols (e.g., RTMP or WebRTC)", de modo que um único protocolo canônico pode ser usado dentro do backbone. O **Intelligest Routing Service (IRS)** roda na AWS e toma as decisões de roteamento; ele não controla o roteamento de Camada 3 do backbone.

**Como o IRS decide.** A fase um resolveu um problema de otimização offline (demanda por PoP na entrada, frações de streams por origem na saída, maximizando o uso de computação sob limites de links e de origens) e carregou o resultado no IRS. Isso era estático, então dois serviços foram acrescentados: o **Capacitor** "monitors the compute resources in every origin" e o **The Well** monitora o backbone. Com eles o IRS tem uma visão em tempo real e "uses a randomized greedy algorithm to compute routing decisions". O post relata que o Intelligest "is able to utilize 100% of the compute resources available to Twitch at the peak times", e que numa falha de origem o IRS "can automatically direct new live video streams to an unaffected origin".

**Regras.** O IRS é stateful e pode fixar certos canais numa origem específica, ou enviar um feed primário e um de backup do mesmo evento à mesma origem.

---

## 4. Transcoding cost and delay `[CONFIRMED]` (2021 interview, 2023 post)

- **Escala do problema.** A ilustração da entrevista: com cinco níveis de qualidade e 300.000 broadcasters, "that's 1,500,000 different streams". O entrevistado diz que tinham centenas de milhares de canais ao vivo a qualquer momento.
- **Custo.** "Transcoding is computationally very expensive." Quando esse engenheiro entrou, apenas 2–3% dos canais podiam receber transcoding. Um transcoder em hardware permite expandir a capacidade "by 10 times, at only two times the cost". Em 2023 o post diz que um servidor-protótipo com ASICs transcodifica "at over 10x the scale of our previous solution".
- **Atraso.** O player mantém um buffer para atravessar conexões ruins, e "buffers can increase latency". O atraso tinha ido de 15 s para cerca de 10 s antes de o entrevistado entrar; a Twitch então construiu o "low-latency HTTP live streaming" e o cortou para cerca de 3 s, e 1,5 s em alguns casos na Coreia.
- **Picos.** "When a big channel goes live, you suddenly have a few million people watching a channel", algo para "design for up front".

---

## 5. How HLS works and what low latency changes `[CONFIRMED]` (RFC 8216, HLS 2nd edition draft)

**HLS clássico (RFC 8216).** O stream é dividido em segmentos de mídia listados numa playlist. Um cliente "MUST periodically reload a Media Playlist file to learn what media is currently available". Para uma playlist ao vivo, o servidor precisa publicar uma nova versão com pelo menos um segmento novo "no earlier than one-half the target duration" e "no later than 1.5 times the target duration" depois da versão anterior. Um cliente que encontra uma playlist alterada precisa esperar pelo menos a target duration antes de recarregar; se não mudou, espera metade. A RFC diz "a typical target duration is 10 seconds"; o rascunho posterior da segunda edição, que esta seção também cita, diz que uma target duration típica é de 6 segundos, então trate os 10 s como o exemplo de 2017 e os 6 s como a orientação atual da Apple. O servidor não pode encolher uma playlist ao vivo abaixo de três target durations, porque isso "can trigger playback stalls". Esse design explica o atraso: o player começa algumas target durations atrás da borda ao vivo (a regra de playlist de três target durations acima aponta no mesmo sentido), então com segmentos de 6 segundos dezenas de segundos de atraso são normais.

**Low-latency HLS (rascunho da segunda edição).** O rascunho acrescenta três mecanismos. Os **segmentos parciais** (`EXT-X-PART`) deixam um cliente buscar pedaços de um segmento antes de ele estar completo. O **blocking playlist reload**: o servidor "MUST defer responding to the request until the Playlist contains" o segmento ou parte pedido, de modo que o cliente fica sabendo imediatamente da nova mídia em vez de fazer polling. Os **preload hints** (`EXT-X-PRELOAD-HINT`) deixam um cliente pedir um recurso "before the resource is available" para que o servidor segure a requisição até poder responder. O servidor também anuncia o `PART-HOLD-BACK`, a distância do fim da playlist em que os clientes devem começar, que "MUST be at least twice the Part Target Duration".

**Por que isso importa para o design.** Cada atalho move trabalho do cache da CDN em direção a estado do lado da origem: uma requisição bloqueante é mantida aberta, então a borda não consegue respondê-la com um cache hit comum e precisa coalescer muitos espectadores em espera numa única busca à origem (raciocínio de design nosso).

Não lemos a descrição da própria Twitch sobre seu HLS de baixa latência além da declaração da entrevista acima, então não afirmamos que a implementação da Twitch coincide com o rascunho em detalhe.

---

## 5b. A documented cousin of Twitch's stack: Amazon IVS, and the Clips API `[CONFIRMED]` with limits

**Amazon IVS.** O anúncio de lançamento da AWS de julho de 2020 diz que o Amazon IVS "ingests the video, then automatically transcodes and optimizes it, making live video streams available within seconds" usando "the same video technology Twitch uses for its live streaming service". Como a AWS documenta o IVS publicamente, seu guia do usuário é a descrição primária mais próxima do que tal stack expõe a um broadcaster (ele não nos diz as configurações da própria Twitch):
- **Ingest:** vídeo H.264 e áudio AAC (LC) sobre RTMPS (RTMP sobre TLS 1.2 ou posterior), RTMP, ou SRT, um protocolo aberto mais novo "designed to improve streaming over unreliable networks and protect against jitter, packet loss, and network bandwidth fluctuations".
- **Latência:** "Amazon IVS channels can deliver video with latency under 5 seconds"; uma camada separada de tempo real (stages) fica abaixo de 300 ms; e "for a traditional Over-The-Top (OTT) stream, latency may be as high as 30 seconds". Para a menor latência o player do IVS precisa ser usado porque players HLS de terceiros não são suportados.
- **Trade-off do intervalo de keyframe:** o guia manda os broadcasters definirem o intervalo de IDR/keyframe do encoder em 2 segundos (ou 1 segundo para latência ainda menor). Com 2 segundos, a latência de início do stream é de aproximadamente 6 a 7 segundos; com 1 segundo, de 3 a 4 segundos. A configuração de 1 segundo pode fazer o adaptive bitrate do player trocar de resolução com mais frequência e aumentar o buffering. Intervalos acima de 5 segundos são desencorajados porque os segmentos podem não começar com um keyframe, arriscando erros de decodificação quando os espectadores iniciam a reprodução ou mudam a qualidade. Isso mostra concretamente por que a segmentação e o alinhamento de keyframes (seção 7) determinam o atraso.
- **Restreaming:** o guia aconselha transmitir direto ao IVS porque serviços de restreaming de terceiros acrescentam latência.

**Clips (apenas comportamento documentado).** A documentação da Create Clip API da Twitch diz que a chamada "captures up to 90 seconds of the broadcaster's stream", abrangendo o ponto de quando a API foi chamada (cerca de 35 segundos antes a 5 segundos depois no exemplo dela); por padrão a Twitch publica até os últimos 30 segundos, e o clip pode ser editado para 5 a 60 segundos por uma URL válida por até 24 horas. A criação é **assíncrona**: a API devolve 202 Accepted, o cliente consulta o Get Clips e, se o Get Clips não devolveu o clip após 60 segundos, o cliente deve "assume it failed" (a página lida em 2026-10-27 diz 60 segundos; snapshots anteriores da mesma página diziam 15). Ela exige que o broadcaster esteja ao vivo e falha com 403 se o broadcaster restringiu a criação de clips a seguidores ou assinantes ou a desativou. Isso descreve a interface, não a implementação: é consistente com cortar um clip a partir de um buffer de segmentos recentes do stream ao vivo, mas nenhuma fonte que lemos diz como ele é construído.

## 6. Chat `[CONFIRMED]` (2015 and 2023 posts, developer docs)

**Componentes.** O chat "is a highly scalable real-time distributed system written in Go" (2015). O post de 2015 nomeia quatro partes:
- **Edge** "Receives and distribute messages between clients and backend services" e "speaks the IRC protocol over both raw TCP and WebSockets".
- **Pubsub** "Distributes messages internally across Edge nodes", e junto com o Edge forma "a hierarchical message distribution system which executes massive fanout".
- **Clue** faz "analysis on user actions" num pipeline de lógica de negócio, por exemplo se o usuário está banido ou é assinante.
- **Room** agrega dados de listas de espectadores entre todos os edges.

O post de 2023 descreve o caminho de envio: o Edge aceita uma mensagem de um cliente e a encaminha ao Clue para processamento; **Clue e Zuma** "evaluate viewer messages against existing rules, like the channel's automod settings, to determine if a message should be delivered or rejected"; as mensagens aceitas são entregues por Pubsub e Edge aos clientes inscritos. Um sistema **Pubsub** relacionado (Edge, Control, Broker) publica eventos de backend como contagens de espectadores e status de enquetes; o Broker "fans the message out to all edges with a subscription to the message's topic".

**Limites.** A documentação para desenvolvedores limita o que um chatbot pode enviar: 20 mensagens por 30 segundos, e 1 mensagem por segundo por canal a menos que a conta seja o broadcaster, um moderador ou um VIP (que recebem 100 por 30 segundos). Se um bot excede os limites, a Twitch ignora suas mensagens por 1 hora, exceto em chats em que a conta do bot é o broadcaster, um moderador ou um VIP. O servidor IRC envia `PING` e o cliente precisa responder `PONG`, senão o servidor encerra a conexão (descrito na [página de documentação do IRC](https://dev.twitch.tv/docs/chat/irc/)).

**O que não é publicado.** A mecânica de fan-out por canal (como uma sala muito grande é particionada entre nós Edge), o armazenamento do histórico do chat e taxas consistentes de mensagens. O post de 2015 diz tanto "over 10 billion messages a day" quanto "hundreds of billions of messages per day", e o post de 2023 repete o número maior. Não use nenhum dos dois como entrada de design; derive seus próprios números a partir de premissas.

---

## 7. Reference design for what Twitch does not publish `[INDUSTRY PATTERN]`

```
broadcaster ─RTMP─► PoP media proxy ─► ingest router (capacity-aware) ─► origin: transcoder ─► packager
                                                                             │
 viewer ◄─HLS/LL-HLS─ CDN / replication tree ◄──────────────────────────────┘ ─► VOD store (object storage)
 viewer ◄─WebSocket/IRC─ chat edge ◄─ pubsub ◄─ moderation ◄─ chat edge ◄─ viewer
```

- **Autenticação do broadcaster:** uma stream key secreta conferida no PoP antes de aceitar o vídeo.
- **Segmentação:** o encoder envia keyframes em um intervalo regular para que os segmentos de cada qualidade se alinhem e o player possa trocar de qualidade nas fronteiras de segmento.
- **Adaptive bitrate:** o player mede o throughput e escolhe uma qualidade por segmento.
- **Canais quentes:** coalesça as requisições em cada nível da árvore para que uma busca à origem sirva muitos espectadores; faça pre-warm de capacidade quando um grande evento está agendado.
- **Fan-out do chat:** faça shard das salas entre nós edge; para salas muito grandes, amostre ou agregue para exibição e aplique o slow mode, porque nem todo espectador consegue ler toda mensagem. É a mesma família de problema de [09 Discord](09-discord.md) e [08 WhatsApp](08-chat-whatsapp.md).
- **Clips:** mantenha uma janela rolante de segmentos recentes para que um clip possa ser cortado do buffer ao vivo. A Twitch documenta a interface de clips (seção 5b: assíncrona, janela de captura de 90 segundos, 5 a 60 segundos publicados) mas nenhuma fonte que lemos descreve a implementação, então o design do buffer é nosso.
- **Atraso versus resiliência:** um buffer maior no player sobrevive a redes ruins; um menor reduz o atraso. Ofereça um modo de latência e recorra a um fallback automaticamente.

Para a mecânica de distribuição de vídeo e caches veja [12 YouTube](12-youtube.md) e [13 Netflix](13-netflix.md).

---

## 8. Failure scenarios

- **Uma origem perde computação ou capacidade de backbone.** O Intelligest lê isso do Capacitor e do The Well e direciona os novos streams para outro lugar `[CONFIRMED]`. Os streams que já estão nessa origem não são cobertos pelo post, então não afirmamos como se recuperam; um reference design faz o encoder do broadcaster reconectar e ser roteado de novo `[INDUSTRY PATTERN]`.
- **Um PoP é perdido.** Não descrito nos posts. Os broadcasters reconectam a outro PoP por DNS ou anycast; isso depende do design de rede e é `[SPECULATIVE]`.
- **Um pico em um canal.** A árvore de replicação absorve a carga de espectadores; a carga de chat precisa de rate limits e slow mode `[INDUSTRY PATTERN]`.
- **Serviço de chat degradado.** O vídeo continua funcionando porque o chat é um sistema separado `[INDUSTRY PATTERN]`.

---

## 9. Capacity reasoning (illustrative)

- Streams a produzir = broadcasters × qualidades. O exemplo da entrevista dá 300.000 × 5 = 1.500.000.
- O fan-out do chat são entregas = mensagens por segundo × espectadores na sala. Um canal com 100.000 espectadores e 10 mensagens por segundo precisaria de 1.000.000 de entregas por segundo (ilustrativo; não são dados da Twitch).
- Banda de egress = espectadores concorrentes × bitrate médio. Com 2,5 milhões de espectadores ativos em média (o número de 2023) a um bitrate assumido de 4 Mbit/s o número seria cerca de 10 Tbit/s, mas o bitrate é premissa nossa e a Twitch não publica um número de banda nos posts que lemos.

---

## ⚠️ Reviewer notes

1. **Os volumes de chat publicados pela Twitch discordam.** A visão geral de 2015 diz 10 bilhões por dia em um lugar e centenas de bilhões por dia em outro, e o post de 2023 diz centenas de bilhões. Não resolvemos isso.
2. **Os bullets de escala de 2015 são ambíguos.** "Over 30,000 people streaming video" ao lado de "over 2 million concurrent video streams" não podem descrever a mesma grandeza; o segundo provavelmente significa espectadores concorrentes. Não usamos nenhum dos dois como entrada de design.
3. **A entrevista de 2021 contém uma afirmação de "more than 1.5 million people"** transmitindo a qualquer momento, o que entra em conflito com o próprio "hundreds of thousands of live channels". Não a usamos.
4. **Os posts são de 2015 a 2023.** A arquitetura pode ter mudado desde então; os posts não dizem.
5. **O low-latency HLS é descrito a partir do rascunho da especificação,** não da implementação da Twitch.
6. **O IVS é um produto relacionado,** e a declaração da AWS de que ele usa a mesma tecnologia da Twitch (2020) não significa que a Twitch use as mesmas configurações ou que não tenha mudado desde então. **Not read:** detalhes de WebRTC, CMAF e qualquer palestra sobre a árvore de replicação.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não dos posts da Twitch. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (atraso glass-to-glass), **elasticidade** (picos em canais individuais), **disponibilidade**, **eficiência de custo** (transcoding e banda), **escalabilidade** do fan-out.
- **Estilo (Ch 13):** **service-based** com dois subsistemas muito diferentes, vídeo (um pipeline) e chat (fan-out event-driven), unidos pela identidade do canal.
- **Quanta (Ch 7):** ingest/transcode de vídeo, entrega de vídeo, chat e VOD são quanta separados, e é por isso que o chat pode falhar sem parar o vídeo.
- **Trade-off (First Law, Ch 1):** **atraso vs resiliência e custo.** Segmentos curtos e buffers pequenos reduzem o atraso e aumentam a carga na origem e o risco de travamentos.
- **Esboço de ADR (Ch 19):** *"Vamos rotear cada stream de ingest a uma origem escolhida por um controlador que enxerga a capacidade ao vivo. Aceitamos um serviço central de roteamento em troca do uso eficiente de computação e da fuga automática de origens com falha."*
- Em linguagem simples: uma emissora com um despachante esperto para seus estúdios e uma sala de bate-papo separada com porteiros.

---

## Interview questions to practice

1. Descreva como um stream ao vivo chega de um streamer a um espectador.
2. Por que fazer transcoding, e o que o torna a parte cara?
3. Como você escolheria qual data center processa um determinado stream?
4. Por que o HLS tem vários segundos de atraso, e como reduzi-lo?
5. Como você projetaria o chat para um canal com um milhão de espectadores?
6. O que acontece quando uma origem falha no meio de um stream?
7. Como você acrescentaria clips e uma gravação (VOD)?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: streams e espectadores concorrentes, atraso alvo, dispositivos, funcionalidades de chat, gravação.
2. Estimar: streams × qualidades, banda de egress dos espectadores, entregas de chat por segundo.
3. API: stream key e endpoint de ingest; reprodução por URL de playlist; chat por WebSocket.
4. Design: ingest em PoP, roteamento ciente de capacidade até as origens, transcoder e packager, árvore de CDN, VOD store, chat edge e pubsub.
5. Deep dive: segmentação e atraso (HLS versus low-latency HLS), fan-out do chat e moderação.
6. Falhas e escala: perda de origem, canal quente, sobrecarga do chat, custo de transcodificar todos os canais.

**Se crescer 10×**
- O custo de transcoding domina: encoders em hardware, e transcodificar apenas canais com espectadores suficientes.
- Origens e backbone: acrescente roteamento ciente de capacidade e mais origens perto dos streamers.
- Chat: faça shard das salas, limite as taxas e amostre salas muito grandes.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Como você escolheria qual data center processa um stream?</summary>

Um serviço de roteamento enxerga a computação livre de cada origem e a carga de cada link de backbone, e envia os novos streams aonde há espaço, com regras para canais especiais. A versão da Twitch primeiro resolveu isso offline a partir de padrões diários de demanda, depois acrescentou feeds de capacidade ao vivo para poder evitar uma origem com falha.

</details>

<details><summary>Por que o HLS tem atraso, e como reduzi-lo?</summary>

O player trabalha com segmentos inteiros, de vários segundos cada, e mantém vários em buffer. Reduza com segmentos mais curtos e segmentos parciais, e com requisições de playlist bloqueantes para que o player saiba de dados novos na hora. Cada passo custa mais requisições e carga na origem.

</details>

<details><summary>Como você projeta o chat para um canal com um milhão de espectadores?</summary>

Aceite mensagens em servidores edge, confira as regras uma vez, publique num topic do canal e deixe cada edge fazer o fan-out para seus próprios clientes conectados. Faça shard da sala entre os edges, acrescente slow mode e rate limits por usuário, e para exibição amostre ou agrupe mensagens porque ninguém consegue ler todas.

</details>

## 📚 Further reading

- Os posts da Twitch e as especificações listados em Sources and provenance.
- Notas do [`neokim-post`](https://github.com/allmonty/study/blob/main/architecture/neokim-post) sobre chat e vídeo para noções básicas.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [08 WhatsApp](08-chat-whatsapp.md), [09 Discord](09-discord.md), [12 YouTube](12-youtube.md), [13 Netflix](13-netflix.md), [21 Game matchmaking and lobby chat](21-game-matchmaking-lobby-chat.md).

## Sources and provenance

> **Kind:** real system, em parte reference design. Os posts abaixo descrevem componentes reais da Twitch. Os internals do transcoder, a bitrate ladder, os clips, o detalhe do fan-out do chat e as taxas atuais de mensagens **não** são publicados no que lemos, então a seção 7 é um reference design `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Twitch Engineering, [*Twitch Engineering: An Introduction and Overview*](https://medium.com/twitch-engineering/twitch-engineering-an-introduction-and-overview-36ceeb8875de) (dez 2015) · Twitch, [*Ingesting Live Video Streams at Global Scale*](https://blog.twitch.tv/en/2022/04/26/ingesting-live-video-streams-at-global-scale/) (abr 2022) · Twitch, [*Low Latency, High Reach: Creating an Unparalleled Live Video Streaming Network at Twitch*](https://blog.twitch.tv/en/2021/10/25/low-latency-high-reach-creating-an-unparalleled-live-video-streaming-network-at-twitch/) (out 2021, uma entrevista) · Twitch, [*Twitch State of Engineering 2023*](https://blog.twitch.tv/en/2023/09/28/twitch-state-of-engineering-2023/) (set 2023) · [Documentação para desenvolvedores da Twitch, Chat](https://dev.twitch.tv/docs/chat/) · Pantos and May, [RFC 8216, HTTP Live Streaming](https://www.rfc-editor.org/rfc/rfc8216) (2017) · Pantos, [HTTP Live Streaming 2nd Edition, draft-pantos-hls-rfc8216bis-22](https://www.ietf.org/archive/id/draft-pantos-hls-rfc8216bis-22.txt) (1 de maio de 2026; as afirmações de baixa latência também foram conferidas na revisão -17).
> **Also read on 2026-10-27:** o [guia do usuário](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/what-is.html) do Amazon IVS Low-Latency Streaming e as páginas [Reducing Latency](https://docs.aws.amazon.com/ivs/latest/LowLatencyUserGuide/streaming-config.html) · AWS, [Introducing Amazon Interactive Video Service](https://aws.amazon.com/about-aws/whats-new/2020/07/introducing-amazon-ivs/) (15 de julho de 2020) · documentação para desenvolvedores da Twitch, [Create Clip](https://dev.twitch.tv/docs/api/reference/#create-clip).
> **Dated material:** os posts vão de 2015 a 2023. As páginas da Twitch são renderizadas por scripts, então as lemos por uma cópia do Internet Archive.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading the full text of each source (Archive copies for the Twitch pages, local copies of the RFC and draft). Quotations are confirmed by `npm run verify`.*
- Verified in the 2015 post: RTMP in, transcode to multiple HLS streams, distribution to PoPs, VOD archive; chat in Go with Edge (IRC over TCP and WebSockets), Pubsub, Clue, Room; both chat-volume statements; the ambiguous scale bullets.
- Verified in the 2022 post: nearly a hundred PoPs, private backbone, origins, HAProxy history and its five problems, Intelligest media proxy and IRS, offline optimisation, Capacitor and The Well, randomized greedy algorithm, 100% compute use at peak, automatic redirect on origin failure.
- Verified in the 2021 interview: 1,500,000 streams example, transcoding reach of 2–3% of channels, hardware transcoder 10× capacity for 2× cost, delay history (15 s, 10 s, 3 s, 1.5 s in Korea), buffer trade-off, surge remark; and the 1.5 million statement that conflicts with other figures.
- Verified in the 2023 post: viewer, minutes and streamer figures, hundreds to thousands of servers per origin, RTMP to HLS-compliant stream, ASIC prototype, Replication Tree, VOD to S3, chat send path with Clue and Zuma, Pubsub Edge, Control and Broker.
- Verified in the chat documentation: send limits and the PING/PONG rule.
- Verified in RFC 8216 and the 2nd-edition draft: reload and playlist rules, partial segments, blocking reload, preload hints, `PART-HOLD-BACK`.
- Labelled industry pattern or speculative: stream key authentication, segmenting alignment, adaptive bitrate, request coalescing, chat sharding and sampling, clips, failure recovery for streams already on a failed origin, PoP loss.
- Verified in the Amazon IVS pages and the Create Clip documentation: the quoted ingest, latency and keyframe-interval statements, the 2020 announcement wording, and the clip window, publish length, asynchronous flow and error conditions. The IVS settings are not claimed for Twitch itself.
- Not read: WebRTC details, CMAF, replication-tree talks, the chat documentation's join limits beyond the sending limits.
- Corrected (independent review, 2026-10-27): the Create Clip timeout is 60 seconds in the live API reference, not 15; an older version of the page said 15. The quotation check did not catch it because the number sits outside the quoted words.
