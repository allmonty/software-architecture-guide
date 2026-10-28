# 10 — Notification System

*Um reference design construído sobre building blocks verificados. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Uma plataforma de notificações aceita requisições, deduplica, verifica preferências, renderiza o conteúdo, enfileira por canal e prioridade e chama provedores como APNs e FCM. O design é moldado pelo comportamento dos provedores: prioridade, expiração, collapsing, higiene de tokens e rate limits, e por filas que entregam at-least-once, de modo que todo estágio precisa ser idempotente.

**Números principais**
- Limite de payload do APNs de 4 KB (5 KB para VoIP), `apns-priority` 10/5/1 `[CONFIRMED]`.
- TTL do FCM de 0–28 dias, padrão de 4 semanas; tokens ficam obsoletos após um mês `[CONFIRMED]`.
- As filas standard do SQS são at-least-once com possível reordenação `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Filas separadas por canal e prioridade | Um disparo de marketing não consegue deixar um alerta de segurança sem recursos | Mais filas e workers para operar |
| Idempotency key na ingestão | Retries do producer não duplicam envios | Um dedup store com TTL |
| Falhar em direção a uma duplicata rara | Sem transações distribuídas com um provedor | Notificação repetida ocasional |

**Erros comuns**
- Afirmar entrega exactly-once: a borda do provedor é best effort.
- Repetir erros que não podem ter sucesso (`BadDeviceToken`, `Unregistered` do APNs).
- Reportar 'delivered' quando o provedor apenas aceitou a requisição.


---

## 🧒 Non-technical explanation

Um sistema de notificações é uma **agência de correio com regras de triagem**. Muitos departamentos deixam cartas ("seu pedido foi enviado", "alguém curtiu sua foto"). A agência decide:
- **Esta carta deve sair?** (A pessoa optou por não receber? São 3 da manhã lá? Já mandamos exatamente esta carta?)
- **Por qual transportadora?** Push no celular, e-mail ou SMS, cada um com suas regras e preços.
- **Quão urgente é?** Um alerta de fraude fura a fila. Um resumo semanal pode esperar.
- **E se a transportadora recusar?** Tentar de novo mais tarde, tentar de outro jeito, ou desistir e anotar que este endereço está morto.

As transportadoras (Apple e Google) **não estão sob o seu controle**, e têm suas próprias regras sobre quanto tempo uma carta pode ficar parada e quantas você pode mandar.

---

## TL;DR for engineers

- **A plataforma é um pipeline:** aceitar → validar/deduplicar → verificar preferências → renderizar um template → enfileirar por canal e prioridade → workers de canal → provedor → tratar o feedback. Cada estágio pode falhar de forma independente `[INDUSTRY PATTERN]`.
- **Filas dão at-least-once, não exactly-once.** As filas standard do SQS "ensure at-least-once message delivery" e "more than one copy of a message might be delivered", então faça **dedupe** por um ID de notificação `[CONFIRMED]` (documentação do SQS).
- **Os provedores moldam o design.** APNs: prioridade 10 / 5 / 1, `apns-expiration`, `apns-collapse-id` (≤64 bytes), payload de 4 KB, códigos de erro específicos com regras de retry `[CONFIRMED]`. FCM: TTL de 0–28 dias (padrão 4 semanas), `collapse_key`, prioridade normal vs high, obsolescência de token de um mês `[CONFIRMED]`.
- **A higiene de tokens faz parte do sistema:** remova tokens em `410 Unregistered` do APNs e `UNREGISTERED` do FCM, guarde um timestamp por token, elimine os obsoletos `[CONFIRMED]`.
- **Faça retry com back-off, mande o resto para a dead-letter** e nunca repita erros que não podem ter sucesso (ex.: `BadDeviceToken`, `Unregistered`, `PayloadTooLarge` do APNs) `[CONFIRMED]`.

---

## 1. Requirements (design framing)

**Funcionais:** enviar mensagens transacionais (recibos, alertas) e de marketing · canais: push mobile, e-mail, SMS, in-app · preferências por usuário e opt-out · templates e localização · agendamento e horários de silêncio · bulk/broadcast para milhões · status de entrega e analytics.

**Não funcionais:** **confiabilidade** (um código de redefinição de senha precisa chegar) · **isolamento de prioridades** (um disparo de marketing não pode atrasar um alerta de segurança) · **sem duplicatas** onde importa · quase tempo real (segundos para transacionais) · escala para rajadas (um broadcast para dezenas de milhões) · **consciência dos limites dos provedores** · auditabilidade (por que isto foi ou não foi enviado?).

**Escala:** depende inteiramente do produto. Declare sua premissa e derive a partir dela, por exemplo 10M de usuários × 5 notificações/dia = 50M/dia ≈ 580/s em média, com rajadas de 10–100× na hora do broadcast `[SPECULATIVE]` (uma premissa ilustrativa, não um número com fonte).

---

## 2. Pipeline `[INDUSTRY PATTERN]`

```
producers (services, schedulers, campaigns)
        │  POST /notify { idempotency_key, user_id, type, data, priority }
        ▼
  ┌── Ingest API ──► validate, authz, rate-limit per producer
  │         │
  │         ▼
  │   Dedup store (idempotency_key)  ── already seen → return prior result
  │         │
  │         ▼
  │   Orchestrator: load preferences + device tokens + channel rules
  │         │   (opt-out? quiet hours? frequency cap? → drop / delay with reason)
  │         ▼
  │   Template render (locale, A/B)
  │         │
  │         ▼
  └─► per-channel, per-priority queues
          push-high | push-normal | email | sms | in-app
              │            │          │      │
          push workers  email wkrs  sms wkrs  ...  ──► providers (APNs, FCM, ESP, SMS gateway)
              ▲                                        │
              └──── retry w/ back-off, DLQ ◄── errors / receipts / feedback
```

Pontos de design:
- **Filas separadas por prioridade e canal** para que um disparo de marketing não deixe um alerta de segurança sem recursos, e para que uma queda do provedor de SMS não trave o push.
- **Idempotency key** na ingestão: os producers fazem retry, e as filas entregam at-least-once, então a mesma notificação lógica pode chegar duas vezes. Mantenha um registro com TTL das chaves já vistas.
- **Preferências e caps** são verificados em um só lugar, de modo que todo producer herda as mesmas regras, e a decisão (enviada / descartada / adiada e por quê) é registrada para auditoria.
- **Fan-out para broadcasts:** um job de campanha percorre a audiência por páginas e enfileira notificações individuais, em vez de uma mensagem gigante. Isso permite fazer throttle, pausar e retomar.
- **Abstração de provedor:** uma interface por canal, com failover para um segundo provedor de e-mail/SMS quando disponível.

---

## 3. What the push providers actually do

### APNs (Apple) `[CONFIRMED]`
- Exige **HTTP/2 e TLS 1.2+**. Você pode abrir várias conexões para aumentar o throughput.
- **Limite de payload de 4 KB (4096 bytes)**, 5 KB (5120 bytes) para VoIP. Maior que isso devolve `413 PayloadTooLarge`.
- **`apns-priority`:** `10` envia imediatamente (o padrão se omitido), `5` envia "based on power considerations on the user's device", `1` prioriza a energia sobre todos os outros fatores e evita acordar o dispositivo. Notificações de prioridade 5 e 1 "might get grouped and delivered in bursts" e podem sofrer throttling ou não ser entregues.
- **`apns-expiration`:** uma época UNIX em segundos. **Diferente de zero:** o APNs guarda a notificação e tenta de novo até essa data. **`0`:** o APNs tenta **uma vez** e não a guarda. O APNs afirma que respeita a expiração em regime best-effort, sem garantia.
- **Armazenamento:** "APNs stores only one notification per bundle ID" para um dispositivo offline, e "in most cases, the latest notification is stored", embora isso não seja garantido.
- **`apns-collapse-id`:** funde várias notificações em uma para o usuário. Máximo de 64 bytes.
- **`apns-id`:** um UUID. O APNs o devolve nos relatórios de erro e cria um se você o omitir.
- **Erros e retries:** `410 Unregistered` ("no need to send further pushes to the same device token, unless your application retrieves the same device token") e `410 ExpiredToken`. `429 TooManyRequests` ("too many requests were made consecutively to the same device token"). `503 Shutdown`, após o qual, segundo a Apple, "After 15 minutes, you can retry JSON payloads that receive response status codes that begin with 5XX". Repita 5xx com back-off. **Não repita** `BadDeviceToken`, `DeviceTokenNotForTopic`, `Forbidden`, `ExpiredToken`, `Unregistered` nem `PayloadTooLarge`. Você pode repetir `TooManyRequests` depois de um atraso.
- **Tokens de autenticação:** se você usa autenticação baseada em token, não renove com mais frequência que uma vez a cada 20 minutos (uma renovação frequente demais devolve um erro).

### FCM (Google/Firebase) `[CONFIRMED]`
- **TTL:** "a duration from 0 to 2,419,200 seconds (28 days)". **Padrão: quatro semanas.** TTL 0 significa que uma mensagem que não pode ser entregue imediatamente é descartada.
- **`collapse_key`:** se já há uma mensagem com a mesma chave esperando, "the old message is discarded and then new message takes its place." Sem ela, as mensagens antiga e nova são ambas guardadas.
- **Prioridade:** **normal** é o padrão, e é "delivered immediately when the device is not sleeping", mas no Doze "delivery may be delayed". **High** é para "time sensitive, user visible content", e em geral "should result in user interaction". Usá-la para tudo anula o seu propósito.
- **Tokens:** um registro está **obsoleto** se a instância do app "hasn't connected for a month". Guarde um **timestamp** com cada token, renove aproximadamente todo mês (mais que semanalmente não traz benefício), elimine tokens obsoletos de forma agendada e apague em `UNREGISTERED` (HTTP 404) e, uma vez confirmado que o payload é válido, em `INVALID_ARGUMENT` (HTTP 400).

**Lição para o design:** a expiração e as collapse keys decidem se uma notificação obsoleta deve algum dia ser exibida. Um push "sua corrida está chegando" não vale nada 30 minutos depois, então dê a ele um TTL curto (ou `apns-expiration: 0`) e uma collapse key `[INDUSTRY PATTERN]`, aplicando a semântica dos fornecedores acima.

---

## 4. Reliability: retries, duplicates, dead letters

- **Semântica de fila** `[CONFIRMED]` (SQS): as filas standard dão entrega **at-least-once** e ordenação best-effort, então duplicatas e reordenação são possíveis. O SQS também "redundantly stores the message in multiple availability zones" antes de confirmar um envio.
- **Dead-letter queues** `[CONFIRMED]` (SQS): uma fila de origem pode enviar mensagens que não foram processadas com sucesso a uma DLQ após `maxReceiveCount` recebimentos. Defina-o alto o bastante para permitir retries de verdade. Defina a retenção da DLQ como maior que a da fila de origem, porque o timestamp original de enfileiramento é mantido.
- **Workers idempotentes** `[INDUSTRY PATTERN]`: registre `(notification_id, channel)` como enviado antes de chamar o provedor, ou de forma atômica com a chamada, e verifique isso primeiro. A chamada ao provedor é o efeito colateral que você não consegue desfazer, então você escolhe entre uma duplicata rara (registrar depois do envio) e uma perda rara (registrar antes do envio). Para a maioria das notificações, uma duplicata rara é a melhor falha.
- **Back-off com jitter** nos erros que admitem retry, por provedor e por token, para que uma região com falha não martele o provedor. Respeite a orientação de 15 minutos do APNs após um shutdown `[CONFIRMED]`.
- **Faça circuit-break de um provedor** que esteja devolvendo erros, e faça failover ou estacione a fila. `[INDUSTRY PATTERN]`

---

## 5. Data model `[INDUSTRY PATTERN]`

| Tabela | Chave | Notas |
|---|---|---|
| `notification` | `notification_id` | type, user_id, payload, priority, created_at, idempotency_key (única) |
| `delivery` | `(notification_id, channel)` | status (queued / sent / delivered / failed / dropped), provider id, error, attempts |
| `device_token` | `(user_id, token)` | platform, app version, timestamp de **last_seen**, flag active |
| `preference` | `(user_id, type, channel)` | opt-in/out, quiet hours, frequency cap |
| `template` | `(type, locale, version)` | |

As entregas têm muita escrita e são ordenadas por tempo, então um store wide-column ou particionado por tempo é adequado. As preferências têm muita leitura e são pequenas, então use cache.

---

## 6. Scale and abuse

- **Fan-out de broadcast:** percorra a audiência por páginas, enfileire por usuário, faça throttle até a taxa aceita pelo provedor e torne o job retomável. `[INDUSTRY PATTERN]`
- **Frequency caps por usuário** protegem os usuários do excesso de notificações e protegem você das respostas `429`. O APNs devolve `429` para requisições consecutivas demais ao mesmo token `[CONFIRMED]`.
- **Isolamento de prioridade:** filas e pools de workers separados por prioridade, com capacidade reservada para a classe alta `[INDUSTRY PATTERN]`.
- **Aplique rate limit nos producers** para que um serviço com bug não crie uma tempestade de notificações. Veja [02 Rate limiter](02-rate-limiter.md).
- **Privacidade:** não ponha dados sensíveis no payload do push. Busque os detalhes depois que o usuário abrir o app `[INDUSTRY PATTERN]`.

---

## ⚠️ Reviewer notes

1. **"Exactly-once delivery" não é oferecido pela borda de entrega.** O APNs e o FCM são best-effort ("without any guarantee" para a expiração, nas palavras do próprio APNs). O que você pode prometer é at-least-once a partir da sua fila mais deduplicação, e best effort no dispositivo.
2. **Um push não é um recibo de entrega.** O APNs aceitar uma requisição não significa que o usuário viu. Não reporte "delivered" a menos que você tenha um recibo no nível do app `[INDUSTRY PATTERN]`.
3. **O armazenamento de uma notificação por bundle no APNs** significa que um dispositivo offline pode receber só a mais recente entre vários pushes enfileirados. Projete o conteúdo para que o mais recente seja autossuficiente, ou use collapse IDs de forma deliberada.
4. **Nosso fetch da página de documentação da Apple devolveu apenas um título.** Os fatos do APNs acima vêm do arquivo de dados da documentação da Apple (o mesmo conteúdo que a página renderiza) e foram lidos por inteiro. Um fetch anterior, com resumo, tentou preencher a lacuna com a própria memória. Descartamos isso e usamos apenas o texto do arquivo de dados.
5. **Não verificamos** os limites de tamanho de payload do FCM, os limites de fan-out por tópico nem as cotas de throughput do APNs/FCM, então nenhum é declarado.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não da documentação dos fornecedores. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **confiabilidade**, **disponibilidade** do caminho de ingestão, **elasticidade** (rajadas de campanhas), **interoperabilidade** (muitos provedores) e **isolamento** entre prioridades.
- **Estilo (Ch 14):** **event-driven, broker topology**: os producers emitem, as filas armazenam em buffer, os workers de canal reagem. O orquestrador no meio é mais próximo de um **mediator** para o workflow por notificação (preferências → render → roteamento). É um híbrido.
- **Quanta (Ch 7):** cada canal (push, e-mail, SMS) é o seu próprio **quantum**, com fila, workers e provedor separados. Esse é o objetivo do isolamento.
- **Trade-off (First Law, Ch 1):** **at-least-once com dedup vs a complexidade do exactly-once.** Aceite uma duplicata rara em vez de construir transações distribuídas com um provedor terceiro que não as suporta.
- **Esboço de ADR (Ch 19):** *"Vamos separar as filas por canal e prioridade, deduplicar por uma idempotency key e registrar o envio antes de chamar o provedor apenas para notificações críticas quanto ao opt-in. Aceitamos duplicatas ocasionais no restante."*
- Em linguagem simples: uma agência de correio com pistas separadas para a correspondência urgente, e um livro de registro para que a mesma carta não seja carimbada duas vezes.

---

## Interview questions to practice

1. Projete uma plataforma que envia 50M de notificações em uma hora sem atrasar one-time passwords. Quais são as suas filas?
2. Um producer faz retry e um worker cai depois da chamada ao provedor. Como evitar enviar duas vezes?
3. O APNs devolve `410 Unregistered` para 8% dos tokens. O que você faz, e o que isso diz sobre a higiene de tokens?
4. Qual deveria ser o TTL e a collapse key para "motorista chegando em 2 minutos"? E para "resumo semanal"?
5. Como você implementa horários de silêncio por usuário entre fusos horários para um broadcast?
6. Como você provaria ao suporte por que um usuário não recebeu uma notificação?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: canais, volume, prioridades, preferências, agendamento.
2. Estimar: notificações/dia e tamanho da rajada.
3. API: enviar com uma idempotency key.
4. Design: ingestão, preferências, filas, workers, provedores.
5. Deep dive: retries, dedup, limpeza de tokens, TTL e collapse keys.
6. Falhas e escala: queda de provedor, broadcasts, DLQ.

**Se crescer 10×**
- Broadcasts: percorra a audiência por páginas e faça throttle até os limites do provedor.
- Usuários quentes: frequency caps por usuário e tratamento de 429 do APNs.
- Queda de provedor: circuit-break e failover quando possível.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Enviar 50M de notificações em uma hora sem atrasar OTPs?</summary>

Use filas de prioridade e pools de workers separados, com capacidade reservada para a classe urgente, e faça throttle da fila em massa até os limites do provedor.

</details>

<details><summary>Um producer faz retry e um worker cai depois da chamada ao provedor. Como evitar enviar duas vezes?</summary>

Faça dedup na ingestão por uma idempotency key e registre o envio por notificação e canal. Aceite uma duplicata rara em vez de uma notificação perdida.

</details>

<details><summary>Qual TTL e collapse key para 'motorista chegando'?</summary>

Um TTL curto (ou expiration 0 no APNs) e uma collapse key, porque um aviso de chegada obsoleto não tem valor e os mais novos devem substituir os mais antigos.

</details>

## 📚 Further reading

- A documentação dos fornecedores listada no topo.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária; tópicos de assincronismo e filas de mensagens).
- Relacionado neste repositório: [04 Message queue / log](04-message-queue-kafka.md), [02 Rate limiter](02-rate-limiter.md), [08 Chat](08-chat-whatsapp.md) (wake-ups por APNs/FCM para usuários offline).

## Sources and provenance

> **Kind:** reference design. Nenhuma empresa publica uma arquitetura completa de plataforma de notificações que pudéssemos verificar, então a plataforma no meio é o design padrão de entrevista `[INDUSTRY PATTERN]`. O que **tem** fonte em documentos primários é a borda do sistema: como o APNs da Apple e o FCM do Google se comportam (prioridade, expiração, collapsing, erros, higiene de tokens) e o que uma fila padrão como o Amazon SQS garante e não garante.
> **Sources read on 2026-10-27:** Apple, [Sending notification requests to APNs](https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns) e [Handling notification responses from APNs](https://developer.apple.com/documentation/usernotifications/handling-notification-responses-from-apns) (obtidos do JSON da documentação da Apple) · Firebase: [Setting the lifespan of a message](https://firebase.google.com/docs/cloud-messaging/customize-messages/setting-message-lifespan), [Message priority](https://firebase.google.com/docs/cloud-messaging/android-message-priority), [Manage FCM registration tokens](https://firebase.google.com/docs/cloud-messaging/manage-tokens) · AWS: [SQS standard queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues.html), [SQS dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html).
> **Not read:** a documentação de provedores de e-mail e SMS, então as afirmações sobre esses canais são apenas `[INDUSTRY PATTERN]`.
> **Tags:** `[CONFIRMED]` afirmado por uma documentação de fornecedor · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* APNs: read in full from Apple's documentation data files. FCM and SQS: fetched pages, quotes checked against the returned text.
- Verified in Apple docs: HTTP/2 + TLS 1.2; 4 KB / 5 KB payload limits; `apns-priority` 10/5/1 meanings and default 10; `apns-expiration` semantics (0 = single attempt, non-zero = stored, best effort); one stored notification per bundle ID; `apns-collapse-id` ≤64 bytes; `apns-id` behaviour; status codes 410, 413, 429, 500, 503 and the reason strings; the "do not retry" list; retry after 15 minutes for 5xx shutdown; 20-minute minimum between auth-token refreshes.
- Verified in FCM docs: TTL 0–2,419,200 s, default four weeks, TTL 0 behaviour; `collapse_key` semantics; normal as default priority, Doze delay, high-priority guidance; one-month staleness, monthly refresh and no benefit under weekly, `UNREGISTERED` (404) and `INVALID_ARGUMENT` (400) handling, timestamps and pruning.
- Verified in SQS docs: at-least-once, possible duplicates and reordering, multi-AZ storage before ack; DLQ redrive with `maxReceiveCount`; DLQ retention should exceed source queue retention.
- Discarded: an unverified paraphrase from memory that a summarising fetch produced for the Apple page. Only the documentation-data text was used.
- Not verified: FCM payload size, FCM/APNs throughput limits, email and SMS provider behaviour, and anything about how any named company builds its notification platform. The platform pipeline and data model are `[INDUSTRY PATTERN]`, and the scale figure is `[SPECULATIVE]`.
