# 17 — Payment System

*Um reference design construído sobre building blocks verificados. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um serviço de pagamentos nunca movimenta dinheiro sem uma idempotency key, modela cada pagamento como uma máquina de estados, trata os webhooks do provedor como at-least-once e sem ordem garantida, e registra cada movimentação num ledger imutável de partidas dobradas. Uma reconciliação noturna contra o provedor pega o desvio. O comportamento documentado do Stripe e o Books do Square são os building blocks verificados.

**Números principais**
- O Stripe v1 salva a primeira resposta, incluindo 500s; as chaves são removidas após pelo menos 24 horas `[CONFIRMED]`.
- Retries de webhook por até três dias com exponential back-off; sem garantia de ordem `[CONFIRMED]`.
- O Books do Square: cerca de 20 TB, construído e operado por três pessoas `[CONFIRMED]` (2019).

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Idempotency keys | Um retry não consegue cobrar duas vezes | A chave precisa ser estável e sobreviver a restarts |
| Webhook como fonte da verdade | Trata métodos assíncronos e redirecionamentos | Duplicatas e reordenação para tratar |
| Ledger imutável de partidas dobradas | Trilha de auditoria, correções seguras | Mais storage e código que uma coluna de saldo |

**Erros comuns**
- Tratar um timeout como falha e criar um novo pagamento.
- Entregar o pedido com base no redirecionamento do navegador em vez de um estado confirmado.
- Atualizar um saldo no lugar em vez de acrescentar um lançamento no journal.


---

## 🧒 Non-technical explanation

Um sistema de pagamentos é um **caixa mais um contador**. O caixa (o seu checkout) pede ao agente do banco (o provedor de pagamento) "por favor, cobre £25 deste cartão", e **nunca pode cobrar duas vezes**, mesmo que a linha do telefone caia no meio da ligação. O contador registra cada movimentação num **livro-razão que nunca pode ser apagado**: cada lançamento é "dinheiro saiu daqui e foi para lá", então os livros sempre fecham. Se há um erro, você não o rabisca. Você escreve um novo lançamento corretivo.

Como as linhas de telefone caem e os bancos levam dias, o sistema precisa tratar bem três coisas: **retries seguros**, **respostas que chegam tarde ou duas vezes** e uma **conferência diária** de que os seus livros batem com os do banco.

---

## TL;DR for engineers

- **Nunca movimente dinheiro sem uma idempotency key.** O cliente gera uma chave única por operação lógica. O servidor guarda o primeiro resultado e o devolve nos retries. Stripe: a v1 salva "the status code and body of the first request", incluindo `500`s. Chaves de até 255 caracteres, removidas após pelo menos 24 horas. Uma chave reutilizada com parâmetros diferentes dá erro `[CONFIRMED]`.
- **Modele o pagamento como uma máquina de estados**, não como um booleano. O PaymentIntent do Stripe vai de `requires_payment_method → requires_confirmation → requires_action → processing → succeeded` (ou `canceled`, ou `requires_capture` para authorise-then-capture) `[CONFIRMED]`. Métodos assíncronos como débitos bancários podem levar dias.
- **Webhooks são at-least-once e sem ordem.** O Stripe repete a entrega por até **três dias** com exponential back-off em modo live, pode enviar duplicatas e não garante ordenação. Registre os IDs dos eventos, verifique a `Stripe-Signature`, devolva `2xx` rápido e processe de forma assíncrona `[CONFIRMED]`.
- **Mantenha um ledger imutável de partidas dobradas** (toda transação fecha em zero). O Books do Square: lançamentos de journal e de book append-only, correções como novos lançamentos, no Cloud Spanner `[CONFIRMED]`.
- **Reconcilie** o seu ledger com os relatórios do provedor de forma agendada, porque retries, timeouts e webhooks vão, de vez em quando, discordar `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** criar um pagamento para um pedido · suportar cartões mais pelo menos um método assíncrono · autorizar e capturar (ex.: holds de hotel ou marketplace) · reembolsos e reembolsos parciais · status do pagamento visível para o sistema de pedidos · repasses a vendedores (marketplace) · recibos e notificações.

**Não funcionais:** **correção primeiro** (sem cobrança dupla, sem cobrança perdida) · **auditabilidade** (cada centavo rastreável) · disponibilidade do checkout · segurança e minimização do escopo PCI · eventual consistency com partes externas é esperada, mas internamente o ledger é fortemente consistente.

**Fora do escopo desta nota:** modelos de fraude, regras das bandeiras de cartão, impostos, câmbio.

---

## 2. The payment state machine `[CONFIRMED]` (Stripe PaymentIntents)

A documentação do Stripe descreve o ciclo de vida de um PaymentIntent. Usando-o como modelo de referência:

| Estado | Significado (da documentação) |
|---|---|
| `requires_payment_method` | Criado, aguardando um método de pagamento. O Stripe aconselha criar o intent assim que o valor a cobrar é conhecido, para que o Stripe possa registrar todas as tentativas de pagamento (parafraseado da página em locale português). **Uma tentativa que falha devolve o intent a este estado** para poder ser repetida |
| `requires_confirmation` | Informações de pagamento fornecidas, pronto para confirmar. A maioria das integrações pula isto enviando o método na hora de confirmar |
| `requires_action` | Passo extra necessário, como 3D Secure |
| `processing` | Depois das ações, para métodos **assíncronos** como débitos bancários, que podem levar até vários dias para confirmar e não podem ser garantidos nesse meio-tempo. Com authorise e capture separados, pode passar antes por `requires_capture` |
| `succeeded` | O fluxo foi concluído. Segundo a documentação, os fundos já estão na sua conta e é seguro entregar o pedido. Reembolsos usam a Refunds API |
| `canceled` | Possível antes de `processing` ou `succeeded`. Invalida o intent, libera quaisquer fundos retidos e **não pode ser desfeito** |

**Lições de design:**
- **Um payment intent por pedido**, reutilizado entre as tentativas, para que o provedor possa acompanhar todas as tentativas e você possa consultar o estado sem adivinhar.
- **Entregue em um `succeeded` confirmado**, idealmente a partir do webhook (ou de um status buscado), não do redirecionamento do navegador, que pode ser pulado ou falsificado `[INDUSTRY PATTERN]`.
- Trate **`processing`** como um estado real no seu fluxo de pedidos. O pedido está "aguardando pagamento", não "pago" `[INDUSTRY PATTERN]`.
- Nota: a documentação do Stripe agora recomenda a Checkout Sessions API em vez de PaymentIntents puros para a maioria das integrações. O modelo de estados continua sendo como os pagamentos se comportam por baixo.

---

## 3. Idempotency: the core safety mechanism `[CONFIRMED]` (Stripe docs)

- O cliente gera a chave. O Stripe sugere UUIDs V4, de até **255 caracteres**, e alerta contra dados sensíveis em chaves.
- **API v1:** o Stripe "saves the status code and body of the first request made with a given idempotency key after endpoint execution begins", e "retries with the same key return the saved response, including `500` errors".
- **Verificação de parâmetros:** a camada de idempotência "compares incoming parameters to those of the original request and errors if they're not the same".
- **Não salvas:** requisições que falham na validação ou que entram em conflito com uma requisição em execução concorrente, já que nenhum endpoint começou a executar. Essas podem ser repetidas.
- **Remoção:** as chaves podem ser removidas automaticamente quando tiverem **pelo menos 24 horas**, e uma chave removida que é reutilizada gera uma nova requisição.
- O `POST` aceita chaves. `GET` e `DELETE` são idempotentes por definição e não precisam delas.
- A **API v2** é diferente: os retries "don't repeat successful operations" e o Stripe repete trabalho que falhou ou ficou parcial até a conclusão, quando possível.

**O que *você* precisa fazer do seu lado** `[INDUSTRY PATTERN]`:
1. Gere a chave a partir de uma **identidade de negócio estável** mais um discriminador de tentativa, como `order_id + attempt_no`. Se um retry muda o valor ou o cartão, use um novo número de tentativa, porque parâmetros alterados na mesma chave dão erro.
2. **Persista a chave e o seu próprio registro de intent antes** de chamar o provedor, de modo que uma queda entre "requisição enviada" e "resposta armazenada" possa ser resolvida repetindo a mesma chamada com a mesma chave.
3. Use a mesma ideia **dentro do seu sistema**: uma idempotency key na sua própria API de pagamento, com o resultado guardado na mesma transação do seu registro de pagamento. Veja [16 Reservation scheduler](16-reservation-scheduler.md) para o fluxo de hold e depois pagamento.
4. **Timeouts não são falhas.** Se a chamada estoura o timeout, o pagamento pode ou não ter acontecido. Repita com a mesma chave, ou consulte o status do intent. Nunca crie um pagamento novo.

---

## 4. Webhooks: late, duplicate, unordered `[CONFIRMED]` (Stripe docs)

- **Entrega:** o modo live repete por até três dias com exponential back-off (paráfrase). Os eventos de sandbox são repetidos três vezes ao longo de algumas horas. Um destino desativado ou apagado interrompe novos retries. O reenvio manual está disponível por 15 dias no Dashboard (30 dias pela CLI).
- **Duplicatas:** os endpoints podem receber o mesmo evento mais de uma vez, então registre os IDs dos eventos que você já processou e pule os que já estão registrados (paráfrase). Ocasionalmente dois objetos Event são gerados, então compare pelo ID de `data.object` mais o `event.type`.
- **Ordenação:** o Stripe não garante que os eventos sejam entregues na ordem em que foram gerados (paráfrase). Não use `created` (resolução de segundo) para ordenar os eventos. Se `invoice.paid` chegar antes dos objetos relacionados, busque-os na API.
- **Responda rápido:** devolva `2xx` antes de qualquer lógica complexa que possa causar timeout (paráfrase). Processe por uma **fila assíncrona**, já que picos (por exemplo no início de um mês de cobrança) podem sobrecarregar handlers síncronos.
- **Verifique a autenticidade:** confira o header `Stripe-Signature` (timestamp `t=` mais `v1=` HMAC-SHA256 de `timestamp.payload`) usando o signing secret do endpoint e o **corpo bruto da requisição**. A tolerância padrão é de **cinco minutos** para limitar ataques de replay, e uma tolerância de `0` desativa a checagem de frescor. Use comparação em tempo constante, ignore esquemas diferentes de `v1` e mantenha os relógios sincronizados com NTP. Além disso, faça allow-list dos endereços IP do Stripe.
- **Assine apenas os tipos de evento de que precisa**, e isente a rota do webhook da proteção CSRF.

**Consequência para o design** `[INDUSTRY PATTERN]`: um handler de webhook é "verificar → registrar o ID do evento (unique constraint) → enfileirar → 2xx". O worker então carrega o estado *atual* do objeto na API do provedor em vez de confiar na ordem do payload do evento.

---

## 5. The ledger: immutable double-entry `[CONFIRMED]` (Square Books, 2019)

**Por que o Square o construiu:** o serviço antigo de settlement calculava o saldo de um lojista com "an expensive group-by aggregate for each merchant", tinha dificuldade com milhões de repasses por dia, não conseguia dividir um pagamento em vários repasses (uma relação muitos-para-um), permitia inconsistências ("nothing is stopping [the payout_id] from being nulled out") e precisava de sharding no nível da aplicação com transações entre shards dolorosas.

**O modelo:** *Double Entry Accounting*. "All transactions (which we call 'journal entries') must balance to 0, so each cent lost is matched with a cent gained". Ele obriga a declarar "not just what financial state change occurred, but why".

**Schema (simplificado, do post):**
- `books`: uma linha por book. Guarda um saldo, tipo, dono, ID único. Os books são a única tabela mutável porque o saldo atual é atualizado a cada operação.
- `journal_entries`: uma linha por transação contábil.
- `book_entries`: cada linha liga um journal entry a um book, com um valor de débito (+) ou crédito (−), e um **contador de versão monotônico por book**. Como os saldos são guardados em cache nos book entries, os journal entries e book entries são "effectively append-only and immutable".
- **Exemplo resolvido no post:** dois pagamentos de $100 e $80 debitam o book *Payments* e creditam *Pending Balance* (logo Payments = $180 e Pending = −$180). Um reembolso credita *Refunds* e debita *Pending*. O repasse então é igual ao saldo pendente, que é uma linha, sem agregação. Também permite **dividir repasses** de forma arbitrária.
- **Correções:** "You can't update the data in place": você escreve um novo lançamento que corrige o anterior, de modo que "there will always be a trace of what happened".
- **Multitenancy:** os tenants são "shelves", e os índices secundários têm namespace por `shelf_id`.
- **Storage:** Google Cloud Spanner, que eliminou o sharding no nível da aplicação. Os schemas do Spanner exigiram UUIDs em vez de inteiros crescentes, ordenação de timestamps ciente de hotspots e tabelas interleaved para co-localização. Na época da escrita, **~20 TB** de dados, operados por **um time de três pessoas**.

**Lições para uma entrevista** `[INDUSTRY PATTERN]` extrapoladas deste design:
- Registre toda movimentação de dinheiro como um **journal entry balanceado** e nunca faça `UPDATE` de valores.
- Guarde dinheiro como **inteiros em unidades menores** (centavos) mais um código de moeda, nunca floats.
- Mantenha o **estado de negócio** (pedido, payment intent) separado do **estado contábil** (ledger), ligados por IDs.
- A escrita no ledger e a mudança de estado "pagamento bem-sucedido" devem ser comitadas **juntas** (uma transação, ou um outbox).

---

## 6. Architecture `[INDUSTRY PATTERN]` unless tagged

```
Checkout (browser/app) ──► Order service ──► Payment service ──► PSP API (idempotency key)
                                                   │                   │  │
                                        payment DB (intent, attempts)  │  └─► webhooks ──► verify → dedupe → queue
                                                   │                   │                           │
                                              outbox/queue ◄───────────┴───────────────────────────┘
                                                   │
                                  Ledger service (immutable double-entry) ──► reports / payouts
                                                   │
                                        Reconciliation job ◄── PSP settlement reports
```

- **Os dados do cartão nunca tocam os seus servidores.** O cliente os envia ao PSP (tokenização/hosted fields) e você lida apenas com tokens, o que minimiza o escopo PCI. As regras do PCI não foram lidas aqui, então trate isto como o design padrão.
- O **Payment service** é dono dos intents, das tentativas e dos registros de idempotência. O **Ledger service** é dono das movimentações de dinheiro. O **Order service** é dono do fulfilment.
- **Outbox pattern:** comite "pagamento bem-sucedido" mais o evento numa transação local e depois publique, para que o downstream (ledger, notificações) nunca o perca. Veja [04 Message queue](04-message-queue-kafka.md) e [10 Notification system](10-notification-system.md).
- **Rate limits e back-pressure** nas chamadas ao provedor: veja [02 Rate limiter](02-rate-limiter.md). O Stripe documenta seus próprios limiters (taxa de requisições, concorrência, load shedders) e recomenda dark launches e kill switches.
- **Reconciliação:** compare diariamente o seu ledger e os intents com os relatórios de settlement e transações do provedor. Investigue as diferenças e escreva lançamentos corretivos, nunca edições.

---

## 7. Failure cases to walk through

| Falha | O que acontece | Mitigação |
|---|---|---|
| O cliente dá duplo clique em "Pagar" | Duas requisições, mesmo pedido | Mesma idempotency key, ou intent já em `processing` |
| Timeout depois de enviar ao PSP | Resultado desconhecido | Repita com a **mesma** chave, ou busque o intent. Nunca um novo pagamento |
| O webhook chega duas vezes | Evento duplicado | Unique constraint no ID do evento `[CONFIRMED]` |
| O webhook chega antes de a chamada de API retornar | Ordem à frente da resposta | Os handlers buscam o estado atual em vez de presumir a ordem `[CONFIRMED]` |
| Um débito bancário fica em `processing` por dias | O pedido não pode ser enviado | Estado "aguardando pagamento", lembretes, política de timeout |
| O processo cai depois do commit, antes de publicar | Evento perdido | Outbox |
| Ledger e PSP discordam | Desvio silencioso | Reconciliação mais lançamentos corretivos |
| Reembolso pedido duas vezes | Reembolso duplo | Idempotency key no reembolso, e verificar o saldo reembolsável |

---

## ⚠️ Reviewer notes

1. **"Exactly-once payments" não existe.** A garantia honesta é *entrega at-least-once + processamento idempotente*. As idempotency keys tornam os retries seguros. Elas não impedem que *você* crie duas chaves diferentes para o mesmo intent.
2. **As idempotency keys têm um tempo de vida.** O Stripe v1 pode remover chaves após 24 horas. Um retry dias depois com uma chave antiga cria uma requisição **nova**, então os seus próprios registros precisam impedir uma duplicata tardia.
3. **Uma resposta de API bem-sucedida não é o mesmo que dinheiro liquidado.** `succeeded` significa que o fluxo de pagamento foi concluído segundo a documentação do Stripe. O settlement bancário e os repasses são etapas separadas. Não as misture no seu ledger.
4. **Não copie o ledger do Square como modelo para todo produto.** O próprio post observa que o Square relaxou as convenções estritas de sinal das partidas dobradas por facilidade de modelagem. Estude o princípio (lançamentos balanceados e imutáveis), não o schema exato.
5. **A documentação do Stripe evolui.** Lemos as páginas em 2026-10-27, incluindo a observação de que a Checkout Sessions agora é recomendada para a maioria das integrações. Releia antes de depender de um detalhe como as janelas de retry.
6. **Não lemos nenhum material de bandeiras de cartão nem de PCI**, então não declaramos nenhum requisito de conformidade.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **integridade dos dados / consistência**, **auditabilidade**, **confiabilidade**, **segurança**, **disponibilidade** do checkout, **recuperabilidade**. O throughput importa menos que a correção.
- **Estilo (Ch 13/14/17):** **service-based**, com uma borda **event-driven** para o PSP (webhooks) e um núcleo de log imutável (o ledger). As ideias do event sourcing (fatos append-only, replay) aparecem no ledger.
- **Quanta (Ch 7):** o ledger é um quantum que precisa ser fortemente consistente. Os caminhos de checkout e notificação podem ser mais relaxados. O PSP é um quantum externo que você não consegue mudar, então tudo o que o toca é projetado para resultados desconhecidos.
- **Trade-off (First Law, Ch 1):** **consistência e auditabilidade vs velocidade e simplicidade.** Um ledger imutável dá mais trabalho que uma coluna `UPDATE balance`, e se paga em rastreabilidade.
- **Esboço de ADR (Ch 19):** *"Vamos registrar todas as movimentações de dinheiro como lançamentos de ledger balanceados e append-only e tornar idempotente toda chamada ao provedor. Aceitamos mais storage e mais código que uma coluna de saldo mutável, em troca de uma trilha de auditoria e retries seguros."*
- Em linguagem simples: o caixa nunca cobra duas vezes, e o contador nunca apaga uma linha.

---

## Interview questions to practice

1. Um cliente clica em Pagar e o seu servidor estoura o timeout esperando o PSP. O que você faz, e o que você nunca deve fazer?
2. Como as idempotency keys funcionam, e o que acontece quando a mesma chave é enviada com um valor diferente?
3. Projete o endpoint de webhook. Como você trata duplicatas, eventos fora de ordem e processamento lento?
4. Por que usar contabilidade de partidas dobradas em vez de uma coluna `balance`? Descreva um pagamento, um reembolso e um repasse.
5. Como você reconcilia seus registros com os do PSP? O que você faz com uma divergência?
6. Como você suportaria autorizar agora e capturar depois (como num hotel ou numa corrida)? Quais estados mudam?
7. Como você deixaria um marketplace dividir um pagamento entre três vendedores?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: métodos, reembolsos, divisões de marketplace, regiões.
2. Estimar: pagamentos/s e linhas de ledger.
3. API: criar intent com uma idempotency key, webhook.
4. Design: payment service, PSP, fila, ledger, reconciliação.
5. Deep dive: máquina de estados, retries, tratamento de webhooks.
6. Falhas e escala: timeouts, duplicatas, divergências.

**Se crescer 10×**
- Picos de webhook: confirme rápido e processe a partir de uma fila.
- Crescimento do ledger: particione por conta e mantenha os lançamentos append-only.
- Mais provedores: ponha uma camada de adapters atrás de um único modelo de intent.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>A chamada ao PSP estoura o timeout. E agora?</summary>

Repita com a mesma idempotency key, ou busque o status do intent. Nunca crie um pagamento novo.

</details>

<details><summary>Por que partidas dobradas em vez de uma coluna de saldo?</summary>

Toda transação fecha em zero, os lançamentos são append-only e as correções são novos lançamentos, o que dá uma trilha de auditoria e consistência.

</details>

<details><summary>Como tratar webhooks duplicados e fora de ordem?</summary>

Registre os IDs dos eventos sob uma unique constraint, enfileire, devolva 2xx e faça o worker ler o estado atual do objeto.

</details>

## 📚 Further reading

- As fontes listadas no topo.
- [Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters) (veja também [02 Rate limiter](02-rate-limiter.md)).
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [16 Reservation scheduler](16-reservation-scheduler.md), [04 Message queue](04-message-queue-kafka.md), [`neokim-post/12` Airbnb](https://github.com/allmonty/study/blob/main/architecture/neokim-post/12-how-airbnb-works.md) (seção de pagamentos e a discussão do `Idempotency-Key`).

## Sources and provenance

> **Kind:** reference design com seus mecanismos importantes fundamentados em documentos primários. A pergunta usual de entrevista é "projete um serviço de pagamentos" para um lojista ou marketplace que recebe pagamentos de cartão e bancários por meio de um provedor de serviços de pagamento (PSP). Os internals reais dos PSPs não são publicados de um jeito que pudéssemos verificar, então a arquitetura é o design padrão `[INDUSTRY PATTERN]`. O que **é** verificado: o comportamento documentado do Stripe para **idempotência**, **estados do PaymentIntent** e **webhooks**, e o design publicado pelo Square de um **ledger imutável de partidas dobradas** (Books).
> **Sources read on 2026-10-27:** documentação do Stripe: [Idempotent requests](https://docs.stripe.com/api/idempotent_requests), [PaymentIntents lifecycle](https://docs.stripe.com/payments/paymentintents/lifecycle), [Webhooks](https://docs.stripe.com/webhooks) (nossos fetches das duas últimas devolveram páginas em locale português. Nós as lemos nesse idioma e traduzimos os fatos citados) · Square Engineering, [*Books, an immutable double-entry accounting database service*](https://developer.squareup.com/blog/books-an-immutable-double-entry-accounting-database-service/) (2019-10-16) · [post de rate limiter do Stripe](https://stripe.com/blog/rate-limiters), lido para [02 Rate limiter](02-rate-limiter.md).
> **Not read:** regras das bandeiras de cartão, texto do PCI DSS, formatos de arquivo de settlement bancário, o post do Airbnb sobre idempotência (paywall, devolveu apenas a introdução) e a arquitetura interna de qualquer PSP. As afirmações sobre esses temas são `[INDUSTRY PATTERN]` ou foram deixadas de fora.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27.* Stripe pages fetched (Portuguese-locale responses, read and translated), Square post read from the live page and the Internet Archive copy (same text length).
- Verified in Stripe idempotency docs: client-generated keys, 255 characters, V4 UUIDs suggested, no sensitive data, v1 saves status code and body including `500`, parameter comparison errors, validation and concurrency conflicts not saved, pruning after at least 24 hours, `POST` accepts keys, `GET`/`DELETE` do not need them, v2 retry behaviour.
- Verified in Stripe PaymentIntent docs: the six states and meanings, async methods taking up to several days, `requires_capture` for authorise-then-capture, failure returns to `requires_payment_method`, cancellation irreversible and releases held funds, create the intent once the amount is known, the Checkout Sessions recommendation.
- Verified in Stripe webhook docs: three-day exponential retries in live mode, three sandbox retries, manual resend 15 days (Dashboard) and 30 days (CLI), duplicates possible and event-ID tracking, no ordering guarantee and `created` not for ordering, respond `2xx` before complex logic, async queue, signature scheme (`t=`, `v1`, HMAC-SHA256 of `timestamp.payload`), five-minute default tolerance and `0` disables freshness checking, raw-body requirement, IP allow-list, CSRF exemption.
- Verified in Square's post: the old settlement problems, double-entry rationale, `books` / `journal_entries` / `book_entries`, version counter, immutability and corrections-as-new-entries, shelves, Spanner schema rules, ~20 TB and a three-person team, the worked $100 / $80 example and its balances ($180 and −$180).
- Not read: Airbnb's idempotency post (member-only, only the introduction came back), PCI DSS, card-network rules, settlement file formats, any PSP's internals.
- Labelled industry pattern, not sourced: the reference architecture, the "persist the key before calling" advice, minor-unit integers, reconciliation practice, fulfil-on-webhook advice, the failure-case table.
- Method note: the Stripe pages came back in Portuguese because of locale. The facts above are our translation of the returned text, so quotes are paraphrased rather than verbatim.
- Quote audit (2026-10-27): Stripe sentences from the webhook and PaymentIntent pages were read in Portuguese, so they are now paraphrases without quotation marks (the idempotency page was read in English and its quotes are unchanged).
