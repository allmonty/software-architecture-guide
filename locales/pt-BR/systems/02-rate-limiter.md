# 02 — Rate Limiter

*Um sistema real documentado. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um rate limiter decide, por chave, se uma requisição pode prosseguir. A escolha do algoritmo (fixed window, sliding window counter, token bucket) importa menos do que fazer a verificação de forma atômica num store compartilhado, falhar aberto quando esse store cai e devolver um 429 claro. Os quatro mecanismos da Stripe mostram que limites de justiça e load shedding são trabalhos separados.

**Números principais**
- Aproximação de sliding window da Cloudflare: 0,003% de 400M de requisições permitidas ou limitadas por engano, 6% de diferença média `[CONFIRMED]`.
- O exemplo de limite de concorrência da Stripe é de 20 requisições em andamento `[CONFIRMED]`.
- Os headers `RateLimit` do IETF ainda são um Internet-Draft ativo (versão 11) `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Token bucket | Permite rajadas acima da taxa estável | Dois parâmetros para ajustar |
| Sliding-window counter | Suave, memória O(1) por chave | Uma aproximação da taxa real |
| Fail open | A API continua no ar se o limiter quebrar | O abuso passa durante uma queda |

**Erros comuns**
- Fazer read-then-write no contador, o que gera race. Use uma única operação atômica.
- Falhar fechado por padrão, de modo que uma queda do Redis derruba a API inteira.
- Tratar o rate limiting apenas como um algoritmo por usuário e ignorar load shedding e limites de concorrência.


---

## 🧒 Non-technical explanation

Um rate limiter é um **segurança com um contador de mão**. Todo mundo recebe uma cota fixa, digamos 10 entradas por minuto. Quando um convidado gasta a sua, o segurança diz "volte mais tarde" em vez de deixá-lo atropelar todos os outros.

As perguntas interessantes são todas sobre o contador:
- A cota **se recompõe aos poucos** (um balde que vai enchendo gota a gota) ou **zera no minuto** (uma catraca que volta a zero)?
- Com **muitas portas** abertas ao mesmo tempo, como os seguranças dividem uma única contagem sem se telefonar a cada convidado?
- Se o contador **quebrar**, deixam todo mundo entrar ou ninguém? A maioria escolhe "todo mundo", porque um contador quebrado não deveria fechar a casa noturna.

---

## TL;DR for engineers

- **Rate limiting não é uma coisa só.** A Stripe roda quatro mecanismos com funções diferentes: um rate limiter de requisições por usuário, um limiter de requisições concorrentes e dois load shedders que protegem a frota `[CONFIRMED]` (Stripe).
- **Token bucket** é o limiter de requisições da Stripe. Permite rajadas curtas acima da taxa estável `[CONFIRMED]`. **Sliding-window counter** é a abordagem da Cloudflare: pondere a contagem da janela anterior pelo quanto dela ainda se sobrepõe `[CONFIRMED]`.
- **O estado fica num store compartilhado e rápido** (Redis na Stripe `[CONFIRMED]`, protocolo memcached na Cloudflare `[CONFIRMED]`) e as operações precisam ser **atômicas**. O Redis documenta a race do INCR+EXPIRE e a correção com Lua `[CONFIRMED]`.
- **Fail open** é um padrão comum, não uma regra: a Stripe captura os erros para que a API continue no ar `[CONFIRMED]`, e o conselho usual é falhar aberto com um alerta `[INDUSTRY PATTERN]`. O filtro do Envoy pode ser configurado de qualquer um dos dois jeitos (`failure_mode_deny`) `[CONFIRMED]`.
- Faça **dark launch** de cada limiter e mantenha um kill switch antes de aplicar de fato `[CONFIRMED]` (Stripe).
- **Avise o cliente**: devolva `429` (RFC 6585) e uma dica de back-off. O draft de headers `RateLimit` do IETF ainda é um Internet-Draft ativo, não um padrão `[CONFIRMED]`.

---

## 1. Requirements

**Funcionais:** limitar por uma chave (API key, usuário, IP, rota). Rejeitar requisições acima do limite com um status claro. Permitir limites configuráveis por chave e por rota. Opcionalmente permitir rajadas.

**Não funcionais:** adiciona **milissegundos de um dígito** ao caminho da requisição `[SPECULATIVE]` (uma meta típica, não um número com fonte) · disponível mesmo quando o store do próprio limiter falha · preciso o bastante (veja o erro medido pela Cloudflare abaixo) · pouca memória por chave · difícil de burlar trocando de identidade.

**Perguntas de esclarecimento:** qual é a chave (usuário, IP, API key, tenant)? Limite rígido ou flexível? Uma região ou global? Um pequeno excesso é aceitável? O que deve acontecer quando o limiter estiver fora do ar?

---

## 2. The four mechanisms Stripe documents `[CONFIRMED]`

| Mecanismo | O que limita | Notas do post |
|---|---|---|
| **Request rate limiter** | Requisições por segundo por usuário | Chamado de "by far the most important one". Token bucket. Permite rajadas breves (ex.: flash sales) |
| **Concurrent requests limiter** | Requisições em andamento por usuário | Para endpoints caros, ex.: "20 API requests in progress at the same time" |
| **Fleet usage load shedder** | Tráfego não crítico quando a frota está ocupada | Reserva uma fatia da capacidade para métodos críticos. O Redis conta as requisições por tipo. Rejeita com 503 |
| **Worker utilization load shedder** | Categorias de tráfego quando os workers estão saturados | "Final line of defense" durante incidentes. Descarta primeiro o tráfego de modo de teste, depois segue uma ordem fixa |

**Por que importa numa entrevista:** a resposta a "projete um rate limiter" fica mais forte se você separar **justiça** (limites por usuário) de **proteção** (load shedding). Objetivos diferentes, chaves diferentes, comportamento de falha diferente.

Os conselhos da Stripe para o rollout, todos do mesmo post `[CONFIRMED]`: comece com o request rate limiter e adicione os demais conforme a escala pedir. Faça dark launch de cada limiter para ver o que ele bloquearia. Mantenha kill switches por feature flag. Capture as exceções em todos os níveis para que os bugs falhem abertos.

---

## 3. Algorithms compared

| Algoritmo | Como conta | Ponto forte | Ponto fraco | Fonte primária |
|---|---|---|---|---|
| **Fixed window counter** | Um contador por chave por janela (ex.: por segundo), `INCR` + `EXPIRE` | Trivial, O(1), memória mínima | Uma rajada na fronteira entre janelas pode passar até ~2× o limite `[INDUSTRY PATTERN]` | A documentação do `INCR` do Redis descreve esse padrão `[CONFIRMED]` |
| **Sliding window counter** | `rate = previous × (window − elapsed)/window + current` | Suave, O(1), dois contadores por chave | Uma aproximação | Cloudflare `[CONFIRMED]` |
| **Sliding window log** | Guarda um timestamp por requisição, conta as que estão na janela | Exato | A memória cresce com o limite | `[INDUSTRY PATTERN]` |
| **Token bucket** | O balde se recompõe a uma taxa estável. Cada requisição tira um token. Vazio = rejeita | Permite rajadas até o tamanho do balde, taxa estável no longo prazo | Dois números para ajustar (taxa, capacidade) | Stripe, e o limiter local do Envoy `[CONFIRMED]` |
| **Leaky bucket** | Uma fila escoa a uma taxa fixa | Suaviza a saída | Adiciona atraso ou descarta, sem tolerância a rajadas | `[INDUSTRY PATTERN]` |

### Cloudflare's worked example and measured accuracy `[CONFIRMED]`

Limite de 50 requisições/min, 18 requisições até agora no minuto atual (começou há 15 s), 42 no minuto anterior:

```
rate = 42 × ((60 − 15) / 60) + 18 = 49.5   → under the limit, allow
```

Em **400 milhões de requisições de 270.000 origens**, a Cloudflare relata que 0,003% das requisições foram permitidas ou limitadas por engano, uma diferença média de 6% entre a taxa real e a aproximada, **nenhum falso positivo**, e 3 origens permitidas estando ligeiramente acima do limite (por menos de 15%). O post chama isso de "only an approximation".

### The Redis atomicity trap `[CONFIRMED]`

A própria documentação do Redis mostra o padrão simples (`INCR`, depois `EXPIRE` quando o valor é 1) e em seguida afirma: **"In the above code there is a race condition."** Se o cliente faz o `INCR` mas não o `EXPIRE`, a chave vaza. As correções que ela dá: envolver tudo em `MULTI`/`EXEC`, ou um **script Lua** enviado com `EVAL`, ou usar listas em vez de contadores. Lição: o check-and-update precisa ser um único passo atômico no store.

---

## 4. Where state lives, and how many nodes share it

| Design | Como funciona | Quem documenta |
|---|---|---|
| **Central store (Redis)** | Todos os nós da aplicação chamam um único cluster Redis para os contadores | Stripe `[CONFIRMED]` |
| **Per-site counters via anycast** | O anycast roteia um IP para o mesmo PoP, então cada PoP conta sozinho, usando Twemproxy + Twemcache (protocolo memcached) com `GET`/`SET`/`INCR` atômico. Os incrementos são assíncronos. Uma flag de "mitigation" é gravada quando o limite é excedido e os servidores a mantêm em cache local até acabar | Cloudflare `[CONFIRMED]` |
| **Local + global in two stages** | Cada proxy Envoy roda um token bucket local e depois chama um **serviço gRPC global de rate limit**. O bucket local absorve as rajadas para que o serviço global não fique sobrecarregado | Documentação do Envoy `[CONFIRMED]` |

A Cloudflare evitou compare-and-swap porque "during attacks, we will have a lot of requests, creating a lot of contention" `[CONFIRMED]`, um bom exemplo de escolher uma primitiva (`INCR`) que sobrevive a hot keys.

**Comportamento em falha:**
- Stripe: quaisquer erros "fail open" para que a API continue funcional `[CONFIRMED]`.
- Envoy: com `failure_mode_deny` verdadeiro, uma chamada que falha devolve **500**. Com falso, as requisições com erro passam (contadas em `failure_mode_allowed`). A página não explicita o valor padrão, então confira a referência do filtro antes de depender dele `[CONFIRMED]`.
- O post da Cloudflare não discute fail-open vs fail-closed, então nada é afirmado aqui.

---

## 5. Responding to the client

- **429 Too Many Requests** é o status usual (RFC 6585). O Envoy devolve 429 quando um descriptor está acima do limite, configurável com `rate_limited_status`, e define `x-envoy-ratelimited` a menos que seja desativado `[CONFIRMED]`. A Stripe aconselha escolher 429 ou 503 conforme a situação, e seu fleet-usage load shedder rejeita com 503 `[CONFIRMED]`.
- **Dicas de back-off:** o draft do IETF `draft-ietf-httpapi-ratelimit-headers` (versão 11, um **Internet-Draft ativo**, expira em 2026-11-24, sem status de RFC pretendido na data da leitura da página) define `RateLimit-Policy` (a política de cota) e `RateLimit` (o limite atual). Se uma resposta também tem `Retry-After`, o `Retry-After` tem precedência `[CONFIRMED]`. Por ser um draft, os nomes dos headers podem mudar, e muitos serviços ainda enviam headers `X-RateLimit-*` específicos de cada fornecedor `[INDUSTRY PATTERN]`.

---

## 6. Interview design `[INDUSTRY PATTERN]`

```
client → edge / API gateway ──► local token bucket (per node, no network)
                         └────► shared counter store (atomic op) ──► allow / 429
                                          │
                              config service (limits per key / route, hot-reloaded)
```

1. **Limiter no nível do gateway** com chave por API key, recorrendo ao IP. Limites por rota vindos de um config service.
2. **Dois estágios:** um bucket local barato primeiro, depois o store compartilhado para a contagem global. Esse é o formato recomendado pelo Envoy `[CONFIRMED]`.
3. **Atualização atômica** no store (script Lua ou um incremento atômico). Nunca read-then-write.
4. **Fail open** com um alerta e um kill switch. Faça dark launch de toda regra nova.
5. **Hot keys:** uma chave abusiva pode sobrecarregar um shard. Guarde em cache local a decisão "já bloqueado", como a Cloudflare faz com sua flag de mitigation `[CONFIRMED]`.

A capacidade não é calculada aqui porque depende inteiramente do tráfego assumido. Declare as premissas e derive os números se for pedido: contadores ocupam bytes por chave, então a memória raramente é o problema. As idas e vindas ao store são.

---

## ⚠️ Reviewer notes

1. **Muitos tutoriais apresentam "token bucket vs leaky bucket vs sliding window" como a resposta inteira.** O post da Stripe mostra que sistemas de produção acrescentam limites de concorrência e load shedding, e eles importam tanto quanto o algoritmo por usuário.
2. **Contadores fixed-window não estão "errados".** A documentação do Redis os apresenta como o padrão. A fraqueza da rajada na fronteira é real, mas pode ser aceitável. A Cloudflare migrou para uma aproximação deslizante por causa das suas necessidades de precisão.
3. **Não afirme que um rate limiter é exato entre regiões.** O design da Cloudflare é deliberadamente por PoP e conta com o anycast para manter uma origem num único PoP em condições normais `[CONFIRMED]`. A exatidão global custaria latência entre regiões.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não de uma fonte primária. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (está em toda requisição), **disponibilidade** (não pode ser a coisa que derruba a API), **escalabilidade**. A **precisão** é uma característica secundária que você troca por custo.
- **Estilo (Ch 9–10):** um **interceptor no caminho da requisição** (gateway ou sidecar) apoiado por um **serviço de estado compartilhado**. A divisão local-mais-global do Envoy é um exemplo concreto.
- **Quanta (Ch 7):** o limiter e a API que ele protege são um quantum se o limiter falhar fechado. Com **fail-open**, eles passam a ser implantáveis de forma independente e o store do limiter pode falhar sem que a API falhe.
- **Trade-off (First Law, Ch 1):** **precisão vs latência/custo.** Aproximação por sliding window (6% de diferença média, segundo a Cloudflare) vs um log exato que custa memória e escritas.
- **Esboço de ADR (Ch 19):** *"Vamos falhar aberto se o store de contadores estiver inacessível, alertar sobre isso e manter um kill switch. Aceitamos que uma queda do store deixe passar tráfego abusivo durante sua duração."* (A mesma decisão que a Stripe documenta.)
- Em linguagem simples: um contador quebrado deve deixar as pessoas entrarem, não trancar a casa noturna, e alguém deve ser acionado.

---

## Interview questions to practice

1. Token bucket vs sliding-window counter: quando cada um dá uma resposta pior?
2. Dois servidores de aplicação leem o contador como 9 de 10 e ambos permitem uma requisição. Corrija.
3. Um único cliente manda 100k requisições/s para uma chave. O que quebra primeiro, e o que você faz com o shard quente?
4. O cluster Redis caiu. O que a API faz? Quem é acionado?
5. Como você implanta com segurança um limite novo e mais baixo?
6. Como você tornaria os limites justos num deploy multi-região?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: chave (usuário, IP, API key), limite rígido ou flexível, uma região ou global.
2. Estimar: requisições/s e chaves, que determinam o tamanho do store e as idas e vindas.
3. API: `429` com uma dica de retry.
4. Design: filtro no gateway, bucket local, store de contadores compartilhado, config service.
5. Deep dive: escolha do algoritmo e atualizações atômicas.
6. Falhas e escala: queda do store (fail open), hot key, rollout com dark launch.

**Se crescer 10×**
- Uma chave abusiva pode sobrecarregar um shard: guarde a decisão de bloqueio em cache local.
- A exatidão entre regiões fica cara: conte por site e aceite a aproximação.
- Mais regras pedem um config service com hot reload e um kill switch.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Token bucket vs sliding-window counter?</summary>

O token bucket permite uma rajada até a sua capacidade e depois uma taxa estável. O sliding counter pondera a janela anterior pela sobreposição, então é suave mas aproximado. Escolha conforme as rajadas sejam aceitáveis ou não.

</details>

<details><summary>Dois servidores leem 9 de 10 e ambos permitem. Correção?</summary>

A verificação e a atualização precisam ser um único passo atômico no store (um script Lua ou um incremento atômico), nunca read-then-write.

</details>

<details><summary>O cluster Redis caiu. O que acontece?</summary>

Falhe aberto com um alerta e um kill switch, como a Stripe faz. Declare a consequência: o tráfego abusivo passa até a recuperação.

</details>

## 📚 Further reading

- [Stripe: Scaling your API with rate limiters](https://stripe.com/blog/rate-limiters)
- [Cloudflare: Counting things, a lot of different things](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/)
- [Envoy: Global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) · [Rate limit filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_filter)
- [Redis: INCR (rate limiter pattern)](https://redis.io/docs/latest/commands/incr/)
- [IETF draft: RateLimit header fields](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/)
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (contexto geral, fonte secundária)

## Sources and provenance

> **Kind:** majoritariamente real-system. Stripe, Cloudflare e Envoy documentam, cada um, como limitam requisições, e as afirmações abaixo estão amarradas a esses textos. O "interview design" combinado no final é uma síntese `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** [Stripe, *Scaling your API with rate limiters*](https://stripe.com/blog/rate-limiters) (2017) · [Cloudflare, *Counting things, a lot of different things*](https://blog.cloudflare.com/counting-things-a-lot-of-different-things/) · Envoy docs: [global rate limiting](https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting) e [rate limit filter](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_filter) · [Redis `INCR`](https://redis.io/docs/latest/commands/incr/) (rate limiter pattern) · [IETF RateLimit headers draft](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/).
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão, sem autoridade única · `[SPECULATIVE]` escolha de design plausível.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading each primary source in full text during this session.* No claim was changed during checking. Three were softened (listed last). We did not keep a numeric tally of verified claims, so the list below names what was checked.
- Verified against Stripe's post: four limiters and their roles, token bucket, Redis, fail-open, dark launch, kill switches, 429/503, adoption order.
- Verified against Cloudflare's post: sliding-window formula and worked example (42×45/60+18 = 49.5, checked by hand), the 400M/270,000/0.003%/6%/3 sources/<15%/no-false-positives figures, Twemproxy+Twemcache, anycast per-PoP counting, async increments, mitigation flag, CAS avoided.
- Verified against Envoy docs: gRPC global service, local token bucket, two-stage recommendation, `failure_mode_deny` 500 behaviour, 429 and `x-envoy-ratelimited`.
- Verified against Redis `INCR`: both patterns, the stated race condition and the Lua/MULTI/list fixes.
- Verified against the IETF page: draft version 11, active, expires 24 Nov 2026, field names, `Retry-After` precedence.
- Softened: Envoy's default for `failure_mode_deny` is not stated on the page we read, so none is claimed.
- Softened: Cloudflare's fail-open behaviour is not in the post, so none is claimed.
- Softened: "single-digit milliseconds" latency target is labelled `[SPECULATIVE]`.
- Not sourced (marked `[INDUSTRY PATTERN]`): sliding window log, leaky bucket, fixed-window 2× burst bound.
- Caveat: the Stripe post is from 2017 and the figures it quotes ("this month") are from then. We use it for design, not for current numbers.
- Corrected (independent review, 2026-10-27): Stripe ties the 503 status explicitly to the fleet-usage load shedder; for other cases it only advises deciding between 429 and 503, so the note no longer says it uses 429 or 503 per limiter.
