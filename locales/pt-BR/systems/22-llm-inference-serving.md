# 22 — LLM Inference Serving (ChatGPT-style)

*Um reference design construído sobre building blocks verificados. Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Servir um large language model é limitado pela memória da GPU e pela forma como as requisições são agrupadas em lote. Cada requisição precisa de um KV cache que cresce token a token, então o número de requisições que uma GPU consegue segurar decide o throughput. O vLLM gerencia esse cache em blocos de tamanho fixo como páginas de memória virtual, o Orca agenda o trabalho uma iteração de decodificação por vez para que as requisições entrem e saiam de um batch livremente, e o DistServe separa a fase de prefill, limitada por computação, da fase de decodificação, limitada por memória. Uma plataforma de produção envolve esses engines com um gateway, um router, autoscaling e metering.

**Números principais**
- Para o modelo OPT de 13B parâmetros, o KV cache de um token é de cerca de 800 KB, então uma requisição de 2.048 tokens pode precisar de até 1,6 GB `[CONFIRMED]` (paper do vLLM).
- Os sistemas existentes usavam apenas 20,4%–38,2% da memória do KV cache para estados reais de tokens `[CONFIRMED]`; o vLLM busca desperdício quase zero e relata 2–4× mais throughput com a mesma latência `[CONFIRMED]`.
- O Orca relatou 36,9× mais throughput que o NVIDIA FasterTransformer com a mesma latência num modelo GPT-3 175B `[CONFIRMED]`; o DistServe relatou atender 7,4× mais requisições ou cumprir metas de latência 12,6× mais apertadas `[CONFIRMED]`.

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| KV cache paginado (tamanho de bloco 16 por padrão) | Fragmentação quase zero, então batches maiores | Uma consulta à block table a cada passo de atenção e um kernel de atenção customizado |
| Agendamento em nível de iteração | As requisições terminadas saem e as novas entram a cada passo | Mais trabalho do scheduler por passo que o batching em nível de requisição |
| Desagregar prefill e decodificação | Cada fase recebe seus próprios recursos e paralelismo | Transferência de KV cache entre GPUs e dois pools para operar |

**Erros comuns**
- Tratar a latência como um único número: o tempo até o primeiro token (prefill) e o tempo por token de saída (decodificação) são problemas diferentes.
- Dimensionar as GPUs só pelos pesos do modelo e esquecer o KV cache, que cresce com o tamanho do batch e o comprimento da sequência.
- Afirmar como um serviço comercial nomeado serve seus modelos: só os sistemas de pesquisa acima são publicados.

---

## 🧒 Non-technical explanation

Imagine uma **cozinha de restaurante com um único fogão muito caro**. Cada pedido precisa da atenção total do fogão por um breve momento, de novo e de novo, até o prato ficar pronto. O fogão só é eficiente quando cozinha muitos pedidos em cada passada. Mas cada pedido em andamento também precisa da **sua própria bandeja de ingredientes semipreparados** que não para de crescer, e o espaço de bancada para as bandejas é limitado.

O jeito antigo era reservar o tamanho máximo de bandeja para cada pedido e só começar um novo lote quando o lote inteiro atual estivesse pronto. Os jeitos novos são distribuir o espaço das bandejas **em pequenos ladrilhos conforme for preciso**, deixar os pedidos **entrarem ou saírem entre as passadas**, e rodar a **linha de pré-preparo** (ler o pedido) separada da **linha do fogão** (cozinhar um prato passo a passo).

---

## TL;DR for engineers

- **Duas fases:** o prompt é processado em paralelo (prefill), depois os tokens são gerados um de cada vez (decoding). O decoding "severely underutilizes GPU computation and becomes memory-bound" `[CONFIRMED]` (paper do vLLM).
- **A memória decide o tamanho do batch.** Com um modelo de 13B numa A100 de 40 GB, os pesos ocupam 26 GB (65%), deixando cerca de 12 GB para o KV cache `[CONFIRMED]`.
- O **PagedAttention** guarda o KV cache em blocos não contíguos com uma block table por requisição, como a paginação de SO `[CONFIRMED]`.
- O **agendamento em nível de iteração** (Orca) e o **continuous batching** deixam as requisições entrarem e saírem a cada passo `[CONFIRMED]`.
- A **desagregação prefill/decode** (DistServe) otimiza o **goodput** por GPU sob metas de tempo até o primeiro token e tempo por token de saída `[CONFIRMED]`.
- **Uma plataforma em volta do engine** (gateway, limites baseados em tokens, router, autoscaling, metering) é o design padrão `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** uma API de chat ou completion com saída em streaming · vários modelos e tamanhos · system prompts, tools e contextos longos · limites por cliente e cobrança por tokens · tratamento seguro de abuso.

**Não funcionais:** metas de **tempo até o primeiro token (TTFT)** e **tempo por token de saída (TPOT)** · **throughput por GPU** (custo) · disponibilidade sob tráfego em rajadas · justiça entre clientes · comportamento previsível quando sobrecarregado.

**Perguntas de esclarecimento:** chat interativo ou batch? Comprimentos típicos de prompt e de saída? Prefixos longos compartilhados (system prompts, documentos)? Um modelo ou vários? Metas de latência e a parcela das requisições que precisa cumpri-las? Orçamento e tipo de GPU?

---

## 2. Why serving is hard: two phases and a growing cache

Uma requisição fornece tokens de prompt e o modelo gera tokens de saída um de cada vez `[CONFIRMED]`. O paper do vLLM separa a **fase de prompt**, em que o prompt inteiro é processado em paralelo, da **fase de geração autorregressiva**, em que os tokens são produzidos em sequência e o trabalho é "memory-bound".

O **KV cache** guarda os vetores de chave e valor dos tokens anteriores para que não precisem ser recalculados. Para o modelo OPT de 13B o paper calcula 800 KB por token (2 para chave e valor × 5.120 de hidden size × 40 camadas × 2 bytes em FP16), então uma requisição de 2.048 tokens pode precisar de até **1,6 GB** `[CONFIRMED]`. Podemos conferir a aritmética: 2 × 5.120 × 40 × 2 = 819.200 bytes ≈ 800 KB, e 2.048 × 800 KB ≈ 1,6 GB.

**Ressalva para modelos modernos.** Essa fórmula supõe que cada attention head tem a sua própria chave e valor (multi-head attention, como no OPT). Muitos modelos mais novos usam **grouped-query attention (GQA)**, em que várias query heads compartilham uma key/value head, então o tamanho de KV por token é 2 × camadas × KV heads × dimensão da head × bytes. O Llama 3, por exemplo, usa GQA com 8 key-value heads `[CONFIRMED]` (relatório do Llama 3, Seção 3.2), o que torna seu cache muito menor do que a fórmula multi-head daria. Quando um entrevistador pedir para dimensionar um KV cache, pergunte qual variante de atenção o modelo usa.

**O que a GPU guarda** (exemplo de 13B do paper numa A100 de 40 GB): parâmetros 26 GB (65%), KV cache cerca de 12 GB, um pequeno restante para ativações. Na Tabela 1 o servidor de 13B tem 15,7K "slots" de KV cache, e o servidor de 175B (8 × A100-80GB) tem 264 GB para KV cache e 60,1K slots `[CONFIRMED]`. O KV cache é dinâmico: cresce a cada token gerado e é liberado quando a requisição termina, então é a parte que limita quantas requisições você consegue rodar juntas.

---

## 3. Managing the KV cache: PagedAttention and vLLM `[CONFIRMED]`

**O problema da alocação contígua.** Os sistemas anteriores guardavam o KV cache de cada requisição numa região contígua dimensionada para o comprimento máximo (por exemplo 2.048 tokens). Isso desperdiça espaço dentro da região (fragmentação interna, já que os comprimentos reais são menores) e entre regiões (fragmentação externa). O profiling do paper constatou que "only 20.4% - 38.2% of the KV cache memory is used to store the actual token states" nos sistemas existentes. Eles também não conseguiam compartilhar memória entre as sequências de uma mesma requisição.

**A correção.** O vLLM divide o KV cache de cada requisição em **blocos** e mantém uma **block table** que mapeia blocos lógicos para blocos físicos, de modo que o cache pode crescer dinamicamente sem reservar todas as posições com antecedência. O paper relata que "the block size 16 is large enough to efficiently utilize the GPU" e pequeno o bastante para limitar a fragmentação interna, e o tamanho de bloco padrão do vLLM é 16.

**Compartilhamento.** Requisições que produzem várias saídas (parallel sampling, beam search) compartilham os blocos do prompt, e o vLLM usa **copy-on-write** na granularidade de bloco quando um bloco compartilhado precisa ser modificado, como o fork de um processo. Um **prefixo** compartilhado (um system prompt longo, por exemplo) pode ter seu KV cache guardado uma vez e reutilizado por muitas requisições.

**Quando a memória acaba.** O vLLM agenda **first-come-first-serve** "ensuring fairness and preventing starvation", e quando precisa fazer preempção, serve primeiro as requisições mais antigas e faz preempção das mais recentes. O estado preemptado é **enviado por swap** para a memória da CPU ou **recalculado** quando a requisição é reagendada, e o descarte é **tudo ou nada** por sequência: "either evict all or none of the blocks of a sequence". As sequências de uma requisição são agendadas em grupo (gang-scheduled).

**Modelos distribuídos.** Para modelos maiores que uma GPU, o vLLM suporta paralelismo tensorial de modelo no estilo Megatron-LM num padrão SPMD, com as GPUs sincronizando via all-reduce.

**Resultado.** "vLLM improves the throughput of popular LLMs by 2-4× with the same level of latency compared to the state-of-the-art systems, such as FasterTransformer and Orca", com ganhos maiores para sequências mais longas, modelos maiores e decodificação mais complexa.

---

## 4. Scheduling: iteration-level batching `[CONFIRMED]` (Orca, OSDI 2022)

**A limitação do batching em nível de requisição.** O paper descreve um mecanismo em que as requisições que terminam cedo "cannot return to the client", e "newly arrived requests have to wait until the current batch completely finishes".

**Agendamento em nível de iteração.** O scheduler "schedules execution at the granularity of iteration (instead of request)": ele aciona o execution engine para rodar uma **única iteração** do modelo no batch e depois reconsidera o batch. As requisições terminadas saem imediatamente e as novas entram.

**Selective batching.** Como as requisições na mesma iteração podem estar em posições diferentes, o Orca aplica o batching "only to a selected set of operations" para que a técnica funcione com Transformers.

**Resultado.** Num modelo GPT-3 175B, o Orca relatou uma "36.9× throughput improvement at the same level of latency" frente ao FasterTransformer. Hoje isso costuma ser chamado de **continuous batching** e também aparece no vLLM.

---

## 5. Separating prefill from decoding `[CONFIRMED]` (DistServe, OSDI 2024)

O DistServe observa que os sistemas existentes fazem **colocation** de prefill e decoding e os agrupam em batch entre requisições, o que "leads to strong prefill-decoding interferences" e acopla a alocação de recursos e o paralelismo das duas fases.

**Dois números de latência.** **TTFT**, "the duration of the prefill phase", e **TPOT**, "the average time taken to generate a token for each request (except for the first token)". Aplicações diferentes os pesam de modo diferente: um chatbot em tempo real prioriza um TTFT baixo, enquanto, no exemplo do paper, a sumarização de documentos tolera um início lento (a tabela dele permite 15 s de TTFT para o OPT-66B no LongBench) e se importa mais com o TPOT. Para documentos muito longos o próprio prefill é um custo grande, então confira qual fase domina na sua carga.

**Goodput, não throughput.** O paper define o **goodput** por GPU como "the maximum request rate that can be served adhering to the SLO attainment goal (say, 90%) for each GPU provisioned". Um goodput maior reduz diretamente o custo por consulta.

**O design.** O DistServe atribui prefill e decoding a **GPUs diferentes**, eliminando a interferência e deixando cada fase usar sua própria estratégia de paralelismo. Ele relata atender "7.4 × more requests or 12.6× tighter SLO" que os sistemas de ponta, mantendo mais de 90% das requisições dentro das restrições de latência.

**O preço: mover o KV cache.** A desagregação significa enviar o KV cache de cada requisição de uma GPU de prefill para uma GPU de decode. O exemplo do paper: o KV cache de uma única requisição de 512 tokens no OPT-66B é de aproximadamente 1,13 GB, então com uma média de 10 requisições por segundo o sistema precisa transferir 11,3 GB por segundo, "equivalently 90Gbps bandwidth" para tornar o overhead invisível. Ele depende de links rápidos: InfiniBand entre nós quando disponível, caso contrário NVLink dentro de um nó (pico de 600 GB/s entre GPUs A100). No seu testbed, que tinha apenas 25 Gbps entre nós, o DistServe portanto coloca as instâncias de prefill e decode de um estágio do modelo na mesma máquina para que a transferência use NVLink; com esse posicionamento, a transmissão de KV para o OPT-175B respondeu por menos de 0,1% da latência total e mais de 95% das requisições viram um atraso de transferência abaixo de 30 ms. O design fica, portanto, atrelado à topologia do cluster.

---

## 5b. Other techniques the same papers point to `[CONFIRMED]`

- **Chunked prefill e stall-free batching (Sarathi-Serve, Agrawal et al., 2024).** Misturar prefills longos com decodes em andamento causa "generation stalls" (um decode travando por segundos no scheduler do vLLM). O Sarathi-Serve divide um prefill em chunks quase iguais e constrói schedules stall-free que acrescentam novas requisições a um batch sem pausar os decodes em andamento. Ele relata capacidade de serving 2,6 vezes maior que o vLLM para o Mistral-7B numa A100, até 3,7 vezes para o Yi-34B em duas A100 e até 5,6 vezes para o Falcon-180B com pipeline parallelism, sob restrições de latência de cauda. É a principal alternativa ao DistServe para o problema de interferência prefill/decode: agendar de forma mais inteligente em GPUs compartilhadas em vez de separá-las.
- **Speculative decoding (Leviathan et al., 2022).** Um modelo pequeno e rápido propõe vários tokens e o modelo grande os confere em paralelo; com o método de amostragem do paper a distribuição da saída não muda ("identical outputs"). Ele relata um ganho de 2X-3X no T5-XXL frente à implementação padrão do T5X, sem retreinar.
- **FlashAttention (Dao et al., 2022).** Um algoritmo de atenção exata ciente de I/O que usa tiling para reduzir leituras e escritas entre a memória de alta largura de banda da GPU e a SRAM on-chip. Os ganhos relatados no paper são para treinamento (por exemplo 3 vezes no GPT-2 com sequência de 1K); não afirmamos números de inferência a partir dele.

Quantization e APIs de fornecedores continuam sem leitura.

---

## 6. The platform around the engine `[INDUSTRY PATTERN]`

Nenhum serviço comercial publica sua stack de serving completa, então este é o design padrão:

```
client ─► API gateway ─► request router ─► inference replica (GPU server, vLLM-style engine)
         auth, quotas        load, prefix      scheduler · KV block manager · model executor
         token limits        affinity                │
              │                                      ▼
        usage metering ◄──────── token stream (SSE) ◄┘
autoscaler ◄── queue depth, GPU memory, TTFT/TPOT ── metrics
model weights store ──► replicas (slow cold start)
```

- **Gateway:** autenticação, rate limits e cotas **baseados em tokens** por cliente, validação de requisições, streaming por server-sent events. Veja [02 Rate limiter](02-rate-limiter.md) para algoritmos de limite e comportamento em falha.
- **Router:** envia cada requisição a uma réplica pela carga atual e, quando existe um prefixo longo compartilhado, a uma réplica que já guarda o KV cache desse prefixo (roteamento ciente de prefixo). Os papers dos engines suportam compartilhamento de prefixo dentro de um engine. O roteamento de prefixo entre réplicas é uma extensão de design nossa.
- **Réplicas:** um processo de engine por grupo de GPUs, dimensionado para que pesos mais um orçamento útil de KV cache caibam.
- **Autoscaling:** escale pela profundidade da fila e pelas metas de latência, não pela CPU. As GPUs são escassas e carregar pesos é lento, então mantenha um piso aquecido e escale antes dos picos conhecidos.
- **Comportamento sob sobrecarga:** enfileire brevemente e depois rejeite com uma dica clara de retry em vez de deixar a latência crescer sem limite. O paper do vLLM observa que o comprimento da fila "continues to grow infinitely" quando a taxa de requisições passa da capacidade.
- **Metering e observabilidade:** conte tokens de entrada e de saída por cliente, acompanhe TTFT, TPOT, tempo de fila, memória da GPU e taxas de erro, e registre as preempções.
- **Multi-tenancy e segurança:** isole os prompts e os caches dos clientes, aplique políticas de conteúdo e limite o tamanho da saída para conter o custo.

---

## 7. Capacity and cost reasoning (illustrative)

- **Pesos:** parâmetros × bytes por parâmetro. Em FP16 cada parâmetro ocupa 2 bytes, então um modelo de 13B tem cerca de 26 GB, batendo com a tabela do paper.
- **Orçamento de KV:** memória da GPU menos pesos menos ativações. O exemplo de 13B do paper deixa cerca de 12 GB, que a 800 KB por token comportam cerca de 15.000 tokens de contexto entre todas as requisições concorrentes (12 GB ÷ 800 KB ≈ 15.000), consistente com seus 15,7K slots.
- **Implicação:** com requisições de 2.048 tokens só cabem cerca de 7 residentes ao mesmo tempo, e requisições reais mais curtas permitem mais. A paginação deixa os comprimentos reais, e não o máximo, decidirem.
- **Métricas de custo:** custo por milhão de tokens ≈ preço por hora da GPU ÷ (tokens por segundo × 3.600) × 1.000.000. As entradas (preço, tokens por segundo) são específicas da carga, então declare premissas em vez de citar números.

---

## ⚠️ Reviewer notes

1. **Os ganhos dos papers são relativos a baselines e cargas específicas.** Os números de 2–4×, 36,9× e 7,4× comparam com sistemas particulares (FasterTransformer, Orca, vLLM) em modelos e datasets particulares. Não são ganhos gerais.
2. **"Continuous batching" é um nome, não um termo de paper.** O termo do Orca é iteration-level scheduling. Use o nome que seu entrevistador usa e esteja pronto para explicar o mecanismo.
3. **A desagregação não é de graça.** Ela exige uma interconexão rápida e um placement ciente de topologia (seção 5). O Sarathi-Serve mostra o chunked prefill em GPUs compartilhadas como um jeito concorrente de reduzir a mesma interferência; não achamos um paper que os compare frente a frente, e não afirmamos qual vence.
4. **Esta nota cobre o serving de inferência.** O treinamento está em [27 LLM training infrastructure](27-llm-training-infrastructure.md) e a melhoria de um modelo está em [28 LLM fine-tuning, evaluation and deployment](28-llm-finetuning-evaluation.md).
5. **Não lemos** a documentação de fornecedores de APIs comerciais específicas nem papers de quantization, então a quantization não é afirmada. Speculative decoding, FlashAttention e chunked prefill são cobertos a partir de seus papers na seção 5b.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não dos papers. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **performance** (TTFT, TPOT), **elasticidade** (demanda em rajadas sobre GPUs escassas), **eficiência de custo**, **disponibilidade**, **justiça** entre tenants.
- **Estilo (Ch 13):** **service-based**: um gateway e um router stateless na frente de réplicas de GPU stateful. Dentro de uma réplica, o scheduler, o gerenciador de memória e o executor são fortemente acoplados por design.
- **Quanta (Ch 7):** cada réplica é um quantum com seu próprio estado de memória. O serving desagregado a divide em quanta de prefill e de decode que precisam concordar sobre a passagem do cache.
- **Trade-off (First Law, Ch 1):** **latência vs throughput por GPU.** Batches maiores aumentam o throughput e também a latência por requisição, e o goodput sob uma meta de latência é a métrica que equilibra os dois.
- **Esboço de ADR (Ch 19):** *"Vamos rodar um engine estilo vLLM com KV cache paginado e continuous batching atrás de um gateway ciente de tokens. Aceitamos a preempção sob pressão de memória em troca de maior utilização da GPU."*
- Em linguagem simples: disponha as bandejas em ladrilhos, troque o batch a cada passada e mantenha a linha de pré-preparo separada do fogão.

---

## Interview questions to practice

1. Por que servir um LLM é mais difícil que servir uma API stateless típica?
2. O que é o KV cache, e por que ele limita o throughput? Calcule seu tamanho para um modelo à sua escolha.
3. Como o continuous batching difere do batching em nível de requisição, e por que ele aumenta a utilização?
4. O que você faria quando a memória da GPU se esgota no meio da geração?
5. O que são TTFT e TPOT, e como você definiria metas para um produto de chat vs um job de sumarização?
6. Como você faria o autoscale de uma frota de GPUs, e o que o torna difícil?
7. Como você aplicaria rate limit e cobraria as requisições de LLM?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: chat ou batch, modelos, comprimentos de contexto, metas de latência, orçamento.
2. Estimar: requisições/s, tokens por requisição, pesos e memória de KV cache por GPU.
3. API: endpoint de chat com streaming, limites de tokens e um ID de requisição.
4. Design: gateway, router, réplicas de GPU com um engine de KV paginado, autoscaler, metering.
5. Deep dive: paginação do KV cache, agendamento em nível de iteração, prefill versus decode.
6. Falhas e escala: pressão de memória e preempção, queda de réplica no meio do stream, sobrecarga, cold starts.

**Se crescer 10×**
- O custo de GPU domina: melhore a utilização com batching e compartilhamento de prefixo antes de adicionar hardware.
- Metas de latência em conflito: separe pools de prefill e decode e ajuste cada um.
- Contextos longos explodem a memória de KV: limite ou faça tiering dos contextos e use reutilização de prefixo.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>O que é o KV cache, e por que ele limita o throughput?</summary>

Ele guarda os vetores de chave e valor dos tokens anteriores para que não sejam recalculados. Cresce com cada token gerado e com o tamanho do batch, e compete com os pesos do modelo pela memória da GPU. As requisições concorrentes são limitadas por quantos caches cabem, então ele limita o throughput.

</details>

<details><summary>O que você faz quando a memória da GPU acaba no meio da geração?</summary>

Faça preempção: escolha as requisições mais recentes e então envie o cache delas por swap para a memória da CPU ou descarte-o e recalcule depois. Descarte uma sequência inteira por vez, mantenha a ordem first-come-first-served e rejeite trabalho novo se a pressão persistir.

</details>

<details><summary>Como definir metas de latência para chat vs sumarização?</summary>

O chat precisa de um tempo baixo até o primeiro token para que a resposta comece rápido, e depois uma taxa de tokens constante. A sumarização tolera um início lento mas quer um tempo por token de saída baixo para terminar rápido. Meça o goodput: a taxa de requisições atendida dentro das duas metas por GPU.

</details>

## 📚 Further reading

- Os três papers listados em Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) para tokens, embeddings e o design de serving no nível do produto.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [02 Rate limiter](02-rate-limiter.md), [23 RAG knowledge assistant](23-rag-knowledge-assistant.md), [25 AI agent platform](25-ai-agent-platform.md), [28 LLM fine-tuning, evaluation and deployment](28-llm-finetuning-evaluation.md).

## Sources and provenance

> **Kind:** reference design com partes reais. vLLM, Orca e DistServe são sistemas de pesquisa publicados. Como qualquer serviço comercial de LLM é construído de ponta a ponta **não** é publicado, então a plataforma da seção 6 é o design padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-26 and 2026-10-27 (texto dos PDFs extraído localmente; Sarathi-Serve, speculative decoding, FlashAttention e a afirmação de GQA do Llama 3 foram acrescentados na segunda data):** Kwon et al., [*Efficient Memory Management for Large Language Model Serving with PagedAttention*](https://arxiv.org/pdf/2309.06180) (SOSP 2023) · Yu et al., [*Orca: A Distributed Serving System for Transformer-Based Generative Models*](https://www.usenix.org/system/files/osdi22-yu.pdf) (OSDI 2022) · Zhong et al., [*DistServe: Disaggregating Prefill and Decoding for Goodput-optimized Large Language Model Serving*](https://arxiv.org/pdf/2401.09670) (OSDI 2024, arXiv v3 junho de 2024) · Agrawal et al., [*Taming Throughput-Latency Tradeoff in LLM Inference with Sarathi-Serve*](https://arxiv.org/pdf/2403.02310) (2024) · Leviathan et al., [*Fast Inference from Transformers via Speculative Decoding*](https://arxiv.org/pdf/2211.17192) (2022) · Dao et al., [*FlashAttention*](https://arxiv.org/pdf/2205.14135) (2022) · Llama Team, Meta, [*The Llama 3 Herd of Models*](https://arxiv.org/pdf/2407.21783) (2024; Seção 3.2, para a afirmação de GQA).
> **Dated material:** os papers são de 2022–2024 e a área se move rápido. As medições vêm do hardware e dos modelos dos autores (GPUs A100, modelos OPT, GPT-3 e LLaMA).
> **Not read:** papers de quantization, documentação de APIs de fornecedores. Não são feitas afirmações sobre esses.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-26, by extracting each paper's text and checking numbers and quotations. Quotations are confirmed by `npm run verify`.*
- Verified in the vLLM paper: 800 KB per token for OPT-13B and 1.6 GB per 2,048-token request (formula arithmetic re-derived: 2 × 5,120 × 40 × 2 = 819,200 bytes); 20.4%–38.2% usage; parameters 26 GB (65%) and KV cache about 12 GB on a 40 GB A100; Table 1 slot counts (15.7K, 9.7K, 60.1K) and KV memory (12, 21, 264 GB); block size 16 default; block table; copy-on-write; shared prefix; FCFS; all-or-nothing eviction with swap or recomputation; Megatron-style tensor parallelism; 2–4× throughput.
- Verified in Orca: iteration-level scheduling, selective batching, the request-level batching limitation, 36.9× on GPT-3 175B versus FasterTransformer.
- Verified in DistServe: disaggregation, TTFT and TPOT definitions, goodput definition with 90% SLO attainment, 7.4× and 12.6× figures, and the KV-transfer analysis (1.13 GB per 512-token OPT-66B request, 11.3 GB/s at 10 requests per second, about 90 Gbps, NVLink 600 GB/s, under 0.1% of OPT-175B latency, over 95% of transfers under 30 ms, 25 Gbps cross-node testbed).
- Verified in Sarathi-Serve, the speculative decoding paper and FlashAttention: the abstract-level claims quoted in section 5b (2.6, 3.7 and 5.6 times; 2X-3X with identical outputs; the training speedups). The papers' experimental setups beyond those figures were not reviewed.
- Labelled industry pattern, not sourced: the gateway, router with prefix-aware routing, autoscaling, metering, overload and multi-tenancy design, and the cost formula.
- Not claimed: how any named commercial LLM service is built.
