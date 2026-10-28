# 23 — RAG Knowledge Assistant (Enterprise Q&A)

*Um reference design construído sobre um método publicado (RAG) e uma técnica de retrieval publicada (Contextual Retrieval). Como foi pesquisado e o que não foi conferido está em **Sources and provenance**, perto do fim.*

## At a glance

**Em 60 segundos.** Um language model não conhece os documentos da sua empresa. A retrieval-augmented generation (RAG) resolve isso na hora da pergunta: encontre os trechos mais relevantes para a pergunta, ponha-os no prompt e peça ao modelo que responda a partir deles, com citações. O sistema tem duas metades. A **ingestão** corta os documentos em chunks, opcionalmente acrescenta contexto a cada chunk e constrói um índice vetorial e um índice por palavras-chave. A **consulta** filtra pelo que o usuário pode ver, recupera com os dois índices, reranqueia e gera. A maioria dos problemas de qualidade são problemas de retrieval, então a avaliação do retrieval é tão importante quanto a avaliação das respostas.

**Números principais** (como publicados, nos testes dos autores)
- Uma base de conhecimento com menos de 200.000 tokens (cerca de 500 páginas) pode ir direto no prompt, sem precisar de RAG `[CONFIRMED]` (Anthropic, 2024).
- Acrescentar contexto gerado a cada chunk reduziu as falhas de retrieval no top-20 em 35% (embeddings) e 49% (com busca por palavras-chave); acrescentar um reranker chegou a 67% (5,7% → 1,9%) `[CONFIRMED]` (datasets próprios da Anthropic).
- No paper original de RAG a fonte de conhecimento eram 21 milhões de chunks de 100 palavras da Wikipedia atrás de um índice de vizinho mais próximo aproximado `[CONFIRMED]`.
- Substituir o índice atualiza o conhecimento do modelo sem retreinar: 70% corretas com um índice de 2016 correspondente, 68% com um índice de 2018 correspondente, 12% e 4% quando não correspondem `[CONFIRMED]` (paper de RAG).

**Decisões e trade-offs**

| Decisão | Por quê | Custo |
|---|---|---|
| Retrieval híbrido (vetores + palavras-chave) | Os embeddings acham o sentido; a busca por palavras-chave acha identificadores exatos | Dois índices para construir e manter sincronizados |
| Acrescentar contexto a cada chunk antes de indexar | Os chunks perdem o que os cerca quando divididos | Uma chamada de modelo extra por chunk na ingestão |
| Reranquear uma lista ampla de candidatos | Melhores resultados no topo, menos tokens no prompt | Latência e custo adicionais por pergunta |
| Filtrar por permissões na hora do retrieval | Um usuário nunca deve ver um texto que não pode abrir | As permissões precisam ser guardadas com os chunks e mantidas atualizadas |
| Responder com citações | Os usuários podem verificar; você pode medir o grounding | Mais tokens de prompt e de saída |

**Erros comuns**
- Julgar o sistema só pela qualidade da resposta. Se o chunk certo nunca foi recuperado, nenhum prompt consegue consertar, então meça o retrieval separadamente.
- Verificar permissões só na UI. O retrieval precisa filtrar, senão o modelo pode citar um documento que o usuário não pode ler.
- Reembedar tudo a cada mudança, ou nunca atualizar. Planeje atualizações incrementais e exclusões.
- Pular um baseline. Para um corpus pequeno, a abordagem de pôr o corpus inteiro no prompt pode vencer um pipeline de RAG.

---

## 🧒 Non-technical explanation

Imagine um **funcionário novo com uma ótima memória de conhecimentos gerais, mas que nunca viu os arquivos da sua empresa**. Quando lhe fazem uma pergunta, ele não chuta: um bibliotecário primeiro tira do arquivo as poucas páginas mais relevantes, o funcionário as lê e responde apontando para a página. O bibliotecário precisa ser bom em duas habilidades: achar páginas pelo sentido ("como consigo um reembolso?") e pelas palavras exatas ("erro TS-999"). O bibliotecário também só pode buscar nas gavetas que quem pergunta tem permissão de abrir.

---

## TL;DR for engineers

- **RAG** combina um gerador (memória paramétrica) com um índice pesquisável (memória não paramétrica) `[CONFIRMED]` (Lewis et al., 2020).
- **O conhecimento é atualizado substituindo o índice,** não retreinando `[CONFIRMED]`.
- **Os chunks perdem contexto.** Anteceder uma curta explicação gerada antes de fazer o embedding e a indexação por palavras-chave reduziu as falhas de retrieval `[CONFIRMED]` (Anthropic).
- **Busca híbrida mais reranking** venceu só embeddings nos testes da Anthropic `[CONFIRMED]`.
- **Permissões, frescor, citações, avaliação e controle de custo** são as preocupações de produção `[INDUSTRY PATTERN]`.

---

## 1. Requirements (design framing)

**Funcionais:** fazer perguntas em linguagem natural sobre documentos da empresa (wiki, tickets, arquivos) · as respostas citam suas fontes · os resultados respeitam as permissões de cada usuário · documentos novos e alterados aparecem rapidamente · documentos apagados desaparecem.

**Não funcionais:** **qualidade da resposta** (fundamentada, correta, diz "não sei") · **latência** (segundos, streaming) · **frescor** (minutos a horas) · **segurança** (sem vazamento entre usuários) · **custo** (tokens, embeddings, reranking) · **auditabilidade**.

**Perguntas de esclarecimento:** tamanho e tipos do corpus? Taxa de atualização? Quem pode ver o quê, e onde isso é definido? Idiomas? Tipos esperados de pergunta (consulta direta, multidocumento, numérica)? Orçamento de latência e custo? Uma resposta errada é cara (jurídico, médico)?

---

## 2. The method: retrieval-augmented generation `[CONFIRMED]`

O paper de RAG (Lewis et al., arXiv 2005.11401) descreve modelos "which combine pre-trained parametric and non-parametric memory for language generation". A memória paramétrica é um modelo seq2seq pré-treinado (BART-large, 400 milhões de parâmetros). A memória não paramétrica é "a dense vector index of Wikipedia", acessada com um retriever neural pré-treinado.

**Retriever.** Um bi-encoder (dois encoders BERT-base, um para documentos e outro para consultas) pontua vetores de documentos e de consultas. Achar os top-k documentos é um problema de Maximum Inner Product Search, que "can be approximately solved in sub-linear time". Os autores usaram FAISS com um índice Hierarchical Navigable Small World. Os índices vetoriais são tratados em [24 Vector / semantic search at scale](24-vector-semantic-search.md).

**Montagem do corpus.** O dump da Wikipedia de dezembro de 2018 foi dividido em "disjoint 100-word chunks, to make a total of 21M documents". Durante o treinamento eles recuperaram os top-k documentos, com k em 5 ou 10.

**Por que importa.** O paper observa que modelos puramente paramétricos "may produce hallucinations" e que seu conhecimento é difícil de atualizar. Nos testes dele, "RAG models hallucinate less and generate factually correct text more often than BART". Numa avaliação humana de geração de perguntas de Jeopardy, os avaliadores julgaram o RAG mais factual em 42,7% dos pares contra 7,1% do BART.

**Atualização de conhecimento.** Com um índice de dezembro de 2016, o RAG respondeu corretamente a 70% das perguntas sobre líderes mundiais de 2016; com o índice de 2018 e os líderes de 2018 foi 68%. Com índices que não correspondiam, a acurácia caiu para 12% e 4%. Os autores concluem "we can update RAG's world knowledge by simply replacing its non-parametric memory."

---

## 3. Better retrieval: Contextual Retrieval `[CONFIRMED]` (Anthropic, September 2024)

**O problema.** O RAG tradicional divide os documentos em chunks "usually no more than a few hundred tokens", e um chunk pode perder o sentido. O exemplo da Anthropic: um chunk que diz que a receita da empresa cresceu 3% não diz de que empresa nem de que período.

**Busca híbrida.** Os embeddings "can miss crucial exact matches". O BM25 é uma função de ranking que usa correspondência léxica, "particularly effective for queries that include unique identifiers or technical terms". O exemplo do post é uma consulta por um código de erro que os embeddings poderiam deixar passar. Combinar os dois dá resultados mais completos.

**A técnica.** O Contextual Retrieval antecede a cada chunk um texto explicativo específico dele antes de fazer o embedding e antes de construir o índice BM25. Um modelo recebe o documento inteiro e o chunk e produz o contexto, que é "usually 50-100 tokens". Com prompt caching, o post estima "$1.02 per million document tokens" como custo único sob as premissas declaradas (chunks de 800 tokens, documentos de 8.000 tokens).

**Resultados.** Medidos como a parcela de documentos relevantes não encontrados nos top 20 chunks, na média de seus datasets (bases de código, ficção, papers do ArXiv e papers científicos) com um modelo de embedding do Gemini:
- Embeddings contextuais: falhas reduzidas em 35%.
- Mais BM25 contextual: reduzidas em 49%.
- Mais um reranker (top 150 candidatos reduzidos aos top 20): reduzidas em 67%, de 5,7% para 1,9%.

Passar 20 chunks ao modelo venceu 10 ou 5. Resumos genéricos de documento acrescentados aos chunks deram "very limited gains". O post aconselha "always run evals".

**Limites desta evidência.** São testes de um fornecedor sobre seus próprios datasets e um reranker. Trate as porcentagens como indicativas, não como resultados esperados nos seus dados.

---

## 4. The reference design `[INDUSTRY PATTERN]`

```
Sources ─► sync ─► chunk ─► (add context) ─► embed ─► vector index
 (docs, wiki, tickets)            │                 └► keyword index
                                  └► chunk store (text, source, permissions)

user ─► permission scope ─► hybrid retrieve ─► rerank ─► build prompt ─► LLM ─► answer + citations
                                                                          └► log for evaluation
```

**Ingestão**
- **Sync e detecção de mudanças:** conectores por fonte, atualizações incrementais, exclusões e mudanças de permissão. Um documento que é apagado ou tornado privado precisa sair do índice rapidamente.
- **Parsing e chunking:** extraia texto de PDFs, tabelas e slides; faça chunks por estrutura (títulos, parágrafos) com alguma sobreposição. As escolhas de chunking "can affect retrieval performance", como diz o post da Anthropic.
- **Contexto, embeddings, índices:** como na seção 3. Guarde o texto do chunk, o link da fonte, uma versão e a lista de acesso junto com os vetores.

**Consulta**
- **Identidade primeiro:** resolva quem é o usuário e quais documentos ele pode ler, e aplique isso como filtro na consulta de retrieval. Nunca recupere e depois filtre no prompt.
- **Retrieval híbrido e reranking:** como na seção 3. Limite quantos chunks chegam ao prompt.
- **Posicionamento do contexto:** mais texto recuperado nem sempre é melhor. Liu et al. (*Lost in the Middle*, 2023) testaram question answering multidocumento e retrieval de chave-valor e constataram que o desempenho "can degrade significantly when changing the position of relevant information": é muitas vezes maior quando a informação relevante está no início ou no fim da entrada e piora quando os modelos precisam usar informação do meio, mesmo para modelos explicitamente de contexto longo `[CONFIRMED]`. Consequências de design (nossas): reranqueie para que os melhores chunks fiquem primeiro, mantenha o número de chunks limitado e teste o seu próprio modelo em vez de presumir que o contexto longo é usado de forma uniforme. Isso concorda com a constatação da Anthropic de que passar 20 chunks venceu 10 ou 5 nos testes deles, o que mostra que o ótimo é específico da tarefa e do modelo.
- **Geração:** instrua o modelo a responder apenas a partir dos trechos fornecidos, citá-los e dizer quando são insuficientes. Veja [22 LLM inference serving](22-llm-inference-serving.md) para servir o modelo.
- **Streaming e fallbacks:** faça streaming da resposta; se o retrieval não devolver nada relevante, responda isso, em vez de chutar.

**Avaliação e operações**
- **Métricas de retrieval:** recall do chunk relevante conhecido nos top-k, num conjunto rotulado de perguntas. É isso que o post da Anthropic mediu.
- **Métricas de resposta:** groundedness (cada afirmação aparece num chunk citado?), correção frente a respostas de referência, qualidade da recusa. Use revisão humana em amostras e avaliação feita por modelo com cuidado, já que os avaliadores têm seus próprios erros.
- **Monitoramento:** registre pergunta, chunks recuperados, resposta e feedback (com controles de privacidade); acompanhe a taxa de não-resposta, o click-through de citações e a latência.
- **Controle de custo:** faça cache de embeddings e de respostas frequentes onde as permissões permitirem, limite o tamanho do contexto, reranqueie menos candidatos, use um modelo pequeno para perguntas fáceis.
- **Segurança:** a prompt injection por documentos é um risco real, já que o texto recuperado entra no prompt. Trate o conteúdo recuperado como dados, limite o que o modelo pode fazer com ele e mantenha o filtro de permissões fora do modelo.

---

## 5. Failure scenarios

- **Conteúdo obsoleto ou apagado.** Se o sync atrasa, os usuários recebem respostas de documentos removidos. Use eventos de exclusão, um intervalo de atualização limitado e mostre o horário da última atualização do documento `[INDUSTRY PATTERN]`.
- **Mudança de permissão.** Uma permissão revogada precisa se propagar ao chunk store antes da próxima consulta; do contrário a resposta vaza conteúdo `[INDUSTRY PATTERN]`.
- **Identificador exato perdido.** Só os embeddings podem perder um número de ticket ou código de erro; o índice por palavras-chave o resgata `[CONFIRMED]` (exemplo da Anthropic).
- **Chunk certo não recuperado.** O modelo não consegue responder ou responde errado; corrija o chunking, acrescente contexto, amplie a lista de candidatos e reranqueie `[CONFIRMED]` como direção, com números específicos dos testes da Anthropic.
- **Resposta alucinada.** Exija citações e verifique se os chunks citados sustentam a afirmação `[INDUSTRY PATTERN]`.

---

## 6. Capacity reasoning (illustrative)

- Chunks ≈ tokens do corpus ÷ tamanho do chunk. Com 50 milhões de tokens e chunks de 500 tokens são 100.000 chunks. Ambos os números são premissas nossas.
- O custo de contextualização escala com os tokens dos documentos. A estimativa da Anthropic de $1,02 por milhão de tokens de documento assumiu o modelo, os preços e os tamanhos de chunk dela na época; recalcule para os seus.
- Tamanho do prompt ≈ chunks recuperados × tamanho do chunk. Vinte chunks de 500 tokens dão cerca de 10.000 tokens por pergunta antes da resposta.
- Tamanho do índice de vetores ≈ chunks × dimensões × bytes por número, antes do overhead do índice. 100.000 chunks × 1.024 dimensões × 4 bytes dão cerca de 400 MB. As dimensões dependem do modelo; isto é ilustrativo.

---

## ⚠️ Reviewer notes

1. **Os ganhos de retrieval vêm de experimentos de um único fornecedor** (seus datasets, um reranker, um modelo de embedding do Gemini). Não são resultados gerais.
2. **O sistema do paper de RAG treina o retriever e o gerador juntos** (fazendo fine-tuning do query encoder e do gerador). A maior parte do "RAG" corporativo não faz isso; ele monta um prompt na hora da consulta. A ideia compartilhada é a etapa de retrieval, não a receita de treinamento.
3. **O limite de 200.000 tokens** é do post da Anthropic e está atrelado à janela de contexto do modelo daquela época; ele se move à medida que as janelas de contexto crescem.
4. **As orientações de controle de acesso, sync, avaliação e prompt injection são prática do setor,** não afirmações com fonte.
5. **Not read:** outros estudos de chunking, papers de reranker (os efeitos de posição em contexto longo são cobertos apenas pelo abstract do *Lost in the Middle*), retrieval baseado em grafos ou agêntico, retrieval multivetorial estilo ColBERT e a documentação de bancos vetoriais de fornecedores.

---

## 🏛️ Architecture lens (Fundamentals of Software Architecture)

> 🔧 Análise nossa, não das fontes citadas. Vocabulário em [neokim-post/00-fundamentals.md §4](https://github.com/allmonty/study/blob/main/architecture/neokim-post/00-fundamentals.md#architecture-thinking).

- **Características dominantes (Ch 4–5):** **segurança** (respostas corretas quanto a permissões), **acurácia**, **frescor**, **performance** (latência), **custo**.
- **Estilo (Ch 13):** dois **pipelines**: um pipeline de ingestão em batch/stream e um serviço de consulta online que compartilham os índices.
- **Quanta (Ch 7):** a ingestão e a consulta escalam de forma independente; os índices e o chunk store são o ponto de acoplamento compartilhado.
- **Trade-off (First Law, Ch 1):** **qualidade vs latência e custo.** Listas de candidatos mais amplas, contextualização e reranking melhoram o retrieval e acrescentam custo e atraso.
- **Esboço de ADR (Ch 19):** *"Vamos recuperar com índices vetorial e por palavras-chave, filtrar por permissão dentro da consulta de retrieval e reranquear antes da geração. Aceitamos um pipeline de ingestão mais complexo em troca de recall de correspondência exata e de nunca expor texto não autorizado."*
- Em linguagem simples: um bom bibliotecário que confere a sua carteirinha primeiro.

---

## Interview questions to practice

1. Projete um assistente de perguntas e respostas sobre os documentos internos de uma empresa.
2. Por que não fazer fine-tuning do modelo nos documentos?
3. Como você faz o chunking dos documentos, e o que dá errado com um chunking ruim?
4. Por que combinar busca por palavras-chave e vetorial? O que o reranking acrescenta?
5. Como garantir que os usuários só vejam respostas de documentos que podem ler?
6. Como manter o índice atualizado, incluindo as exclusões?
7. Como avaliar o sistema? Separe retrieval de geração.
8. O que pode dar errado quando os documentos contêm instruções (prompt injection)?

## Interview practice

Estes roteiros são raciocínio nosso (`[INDUSTRY PATTERN]`), não afirmações das fontes citadas.

**Um roteiro de 45 minutos**

1. Esclarecer: tamanho do corpus, fontes, taxa de atualização, modelo de permissões, necessidades de acurácia.
2. Estimar: chunks, tamanho do índice, perguntas por segundo, tokens por pergunta.
3. API: endpoint de pergunta com identidade do usuário, resposta em streaming, citações, endpoint de feedback.
4. Design: conectores e sync, chunker, embedder, índices vetorial e por palavras-chave com permissões, serviço de consulta, reranker, LLM.
5. Deep dive: retrieval híbrido e reranking; filtro de permissões; avaliação.
6. Falhas e escala: documentos obsoletos ou apagados, mudanças de permissão, retrievals perdidos, prompt injection, custo.

**Se crescer 10×**
- Tamanho do índice e latência: faça shard dos índices (veja [24 Vector / semantic search at scale](24-vector-semantic-search.md)) e filtre cedo.
- Throughput de ingestão: paralelize o parsing e o embedding, processe as mudanças de forma incremental.
- Custo: use cache, reranqueie menos candidatos, direcione perguntas fáceis a um modelo menor.

**Roteiros de resposta** (tente as perguntas acima primeiro)

<details><summary>Por que não fazer fine-tuning do modelo nos documentos?</summary>

Fatos nos pesos são difíceis de atualizar, não podem ser citados e não conseguem respeitar permissões por usuário. O retrieval deixa você substituir o índice para atualizar o conhecimento, citar fontes e filtrar por quem está perguntando. O fine-tuning ainda pode ajudar no estilo ou no vocabulário do domínio.

</details>

<details><summary>Como você impõe as permissões?</summary>

Guarde a lista de acesso de cada chunk junto com ele, resolva os grupos do usuário na hora da consulta e filtre dentro da consulta de retrieval antes do ranking. Propague rapidamente as mudanças de permissão e teste com usuários que não devem ver um documento.

</details>

<details><summary>Como você avalia?</summary>

Construa um conjunto rotulado de perguntas. Meça primeiro o recall do retrieval nos top-k, depois o groundedness e a correção das respostas, depois o comportamento de recusa. Acompanhe o mesmo conjunto ao longo do tempo para que toda mudança de chunking, modelos ou prompts seja comparada antes do release.

</details>

## 📚 Further reading

- As duas fontes listadas em Sources and provenance.
- [`neokim-post/01` How LLMs work](https://github.com/allmonty/study/blob/main/architecture/neokim-post/01-how-llms-work.md) para embeddings e noções básicas de retrieval.
- [System Design Primer](https://github.com/donnemartin/system-design-primer) (secundária).
- Relacionado neste repositório: [20 Web crawler and search](20-web-crawler-search.md), [22 LLM inference serving](22-llm-inference-serving.md), [24 Vector / semantic search at scale](24-vector-semantic-search.md), [25 AI agent platform](25-ai-agent-platform.md) e [28 LLM fine-tuning, evaluation and deployment](28-llm-finetuning-evaluation.md).

## Sources and provenance

> **Kind:** reference design. O RAG (o método) e o Contextual Retrieval (uma técnica e suas medições) são publicados. Como qualquer empresa específica constrói seu assistente interno não é, então a plataforma da seção 4 é o design padrão `[INDUSTRY PATTERN]`.
> **Sources read on 2026-10-27:** Lewis et al., [*Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks*](https://arxiv.org/pdf/2005.11401) (arXiv 2005.11401, 2020; texto do PDF extraído localmente) · Anthropic, [*Introducing Contextual Retrieval*](https://www.anthropic.com/news/contextual-retrieval) (19 de setembro de 2024; lido por uma cópia do Internet Archive) · Liu et al., [*Lost in the Middle: How Language Models Use Long Contexts*](https://arxiv.org/pdf/2307.03172) (2023; abstract e introdução).
> **Dated material:** o paper de RAG é de 2020 e o post da Anthropic de 2024. Modelos, janelas de contexto e preços mudaram desde então.
> **Not read:** o cookbook da Anthropic, outros papers de chunking e reranking, a documentação de fornecedores de bancos vetoriais ou de produtos de busca corporativa.
> **Tags:** `[CONFIRMED]` afirmado por uma fonte primária · `[INDUSTRY PATTERN]` prática padrão · `[SPECULATIVE]` plausível ou ilustrativo.

---
## ✅ Verification log

*Fact-check, 2026-10-27, by reading both sources in full. Quotations are confirmed by `npm run verify`.*
- Verified in the RAG paper: the parametric and non-parametric memory definition, BART-large with 400M parameters, DPR bi-encoder with BERT-base encoders, MIPS in sub-linear time, FAISS with HNSW, December 2018 dump in 100-word chunks giving 21M documents, k in 5 or 10 for training, hallucination statement, Jeopardy factuality percentages (42.7% and 7.1%), index hot-swapping results (70%, 68%, 12%, 4%).
- Verified in the Anthropic post: 200,000-token threshold, chunk size wording, BM25 description and error-code example, context length of 50–100 tokens, $1.02 per million document tokens and its assumptions, the 35%, 49% and 67% figures with 5.7% to 1.9%, top-150 to top-20 reranking, 20 chunks versus 10 or 5, the limited gains from generic summaries, "always run evals", datasets used.
- Verified in the Lost in the Middle abstract: the two tasks, the position effect (best at beginning or end, worse in the middle, even for long-context models). The models and quantitative results in the paper were not reviewed.
- Labelled industry pattern, not sourced: ingestion and sync design, permission filtering, evaluation metrics and monitoring, cost control, prompt-injection advice, capacity figures.
- Not claimed: results on any dataset other than those in the cited sources.
