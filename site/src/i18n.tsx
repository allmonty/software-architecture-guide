import type { ReactNode } from "react";
import { useSettings } from "./settings.ts";
import type { ItemType } from "./data.ts";

// UI text in both languages. Only sentences and labels are translated; technical terms (Mermaid, Graph, Split,
// CONFIRMED, container, component, flow, ...) stay in English. The pt-BR object is typed as the English one, so a
// missing or mistyped key fails `tsc`.
const en = {
  brandCoffee: "Buy me a coffee",
  coffeeTitle: "Support this project on Buy Me a Coffee",
  home: "← Home",
  allTracks: "← All tracks",
  back: "← Back",
  toolkitIndex: "Toolkit index",
  unknownTrack: "Unknown track.",

  // Settings menu
  readingSettings: "Reading settings",
  language: "Language",
  theme: "Theme",
  themes: { system: "System", light: "Light", warm: "Warm", dark: "Dark" },
  font: "Font",
  fontSystem: "System default",
  textSize: "Reading text size",
  textSizeAria: "Reading text size in pixels",
  smaller: "Smaller text",
  larger: "Larger text",
  diagramFixed: "Diagram labels keep a fixed size.",
  reset: "Reset to defaults",

  // Reading tools, study toggle
  focus: "Focus",
  focusTitle: "Hide the legend and the summary card",
  print: "Print / PDF",
  printTitle: "Print the note, or save it as a PDF from the print dialog",
  studied: "✓ Studied",
  markStudied: "Mark as studied",
  markItemStudied: (title: string) => `Mark ${title} as studied`,

  // Item labels
  itemType: { System: "System", Primer: "Primer", Incident: "Incident", Exercise: "Exercise" } as Record<ItemType, string>,
  practice: "practice",
  minutes: (n: number) => `~${n} min`,
  upNext: "Up next",
  referenceDesign: "Reference design",
  realSystem: "Real system",
  continueLabel: "Continue",
  start: "Start",

  // Home
  heroA: "Learn system design by walking through ",
  heroB: "worked architectures",
  lede: (n: number) =>
    `${n} case studies with interactive diagrams, a casebook of real outages, fourteen primers on the topics that cut across them, and a practice workbook. Every factual claim is tagged by how well it is supported, and sourced claims link to their source.`,
  startInterview: "Start the interview track",
  becomeArchitect: "Become an architect",
  progressSome: (done: number, total: number) => `${done} of ${total} pages marked as studied. `,
  progressNone: "Tick pages as you finish them to track progress. ",
  progressLocal: "Progress is saved only in this browser.",
  resetProgress: "Reset",
  confirmReset: "Clear all progress in this browser?",
  pickGoal: "1. Pick a goal",
  pickGoalNote: "Each track is an ordered reading list with a reason for every step. You can switch at any time.",
  trackMeta: (steps: number, hours: number) => `${steps} steps · about ${hours} h of reading`,
  doneOf: (n: number, total: number) => `${n} of ${total} done`,
  howToStudy: "2. How to study one system",
  method: [
    ["Read the 60-second summary", "Open a system and read its At a glance box: the key numbers, decisions and common mistakes."],
    ["Try it yourself", "Close the page and sketch your own design for ten minutes, with estimates, before you look further."],
    ["Walk the diagram", "Switch between the Context, Containers and Components levels. Pick a flow and step through it, including the failure flows."],
    ["Read the deep dive", "Compare with the note. Look at the reviewer notes: they list popular claims the sources do not support."],
    ["Drill it", "Do the interview practice section, answer the questions aloud, then add facts you missed to your flashcards."],
  ] as [string, string][],
  howToRead: "How to read a system page and trust it",
  legendViews: (
    <><b>Views:</b> Graph, Split (diagram with the note beside it) or Text. Click a component for its summary, sources and confidence; use ← and → to step through a flow.</>
  ),
  legendLevels: (
    <><b>Levels:</b> Context shows the system as one box, Containers shows its parts, Components opens one container.</>
  ),
  legendTags: (
    <><b>Tags:</b> <b>CONFIRMED</b> was stated by a primary source we read; <b>INDUSTRY PATTERN</b> is standard practice that no source states for this system; <b>SPECULATIVE</b> is plausible or illustrative. Dashed borders mark patterns, dotted ones speculation.</>
  ),
  legendKinds: (
    <><b>Kinds:</b> a <i>real system</i> is described by its own engineers; a <i>reference design</i> is a standard design built on verified pieces and is not a claim about any company.</>
  ),
  legendLog: "Each note ends with a verification log that says what was checked and what was not.",
  browse: "3. Browse everything",
  browseConcept: (link: ReactNode) => <>Looking for an idea rather than a system? {link}.</>,
  browseConceptLink: "Browse by concept",
  searchPlaceholder: "Search titles and the full text of every note",
  search: "Search",
  pages: "Pages",
  inText: "In the text",
  sections: "sections",
  typeMore: "Keep typing: the text search starts at three letters.",
  noMatch: "No match.",
  toolkit: "Toolkit",
  toolkitNote: "Practice material around the systems.",
  casebook: "Casebook: real incidents",
  primers: "Primers: cross-cutting topics",
  workbook: "Workbook: practice with feedback",
  studiedAria: "studied",

  // Track page
  trackProgress: (n: number, total: number, left: number, all: number) => `${n} of ${total} done · about ${left} h left of ${all} h`,
  trackComplete: (link: ReactNode) => <><b>Track complete.</b> Revisit the workbook, or pick another goal from the {link}.</>,
  homePage: "home page",

  // Concepts page
  conceptsTitle: "Browse by concept",
  conceptsLede: "The same idea shows up in many systems. Pick a concept to see where it is covered, and compare how each system uses it.",
  filterConcepts: "Filter concepts",
  noConcept: "No concept matches.",
  conceptsInNote: "Concepts in this note:",

  // System page
  mermaidSource: "Mermaid source (the interactive diagram replaces it)",
  livesInRepo: (href: string) => `Lives in the repository: ${href}`,
  showInDiagram: "Show in the diagram",
  view: "View",
  legendLighter: "lighter = component",
  legendBorder: " · Border: solid = confirmed, dashed = industry pattern, dotted = speculative · Lines: dashed = async",
  notTranslated: "This page is not translated yet, so it is shown in English.",

  // Sections
  jumpTo: "Jump to",
  jumpToAria: "Jump to section",
  sectionPlaceholder: "Section…",
  contents: "Contents",
  copyLink: "Copy link to this section",
  copied: "copied",

  // Diagram
  noComponentView: "This system has no component view",
  lineLabels: "Line labels",
  lineLabelsTitle: "Show or hide the text on the lines",
  svgTitle: "Download this view as an SVG image",
  pngTitle: "Download this view as a PNG image",
  resetLayout: "Reset layout",
  flows: "Flows",
  failureTitle: "A failure, overload or other abnormal case",
  noFlows: "No flows for this system.",
  step: (i: number, n: number) => `Step ${i}/${n}.`,
  happensInside: (label: string) => <>Happens inside <b>{label}</b> at this level. Open a lower level to see it.</>,
  notDrawn: "Not drawn in this view.",
  next: "Next →",
  arrowKeys: "or press the ← and → keys",
  openContainers: "Open the Containers view",
  openComponents: "Open the Components view",
  componentsOf: "Components:",
  quotesFrom: (n: number) => `Quotations from these sources (${n})`,
  quotesNote: "Words from this element's sources that the note quotes and the verifier found in the page. They may support nearby claims rather than this element alone.",
  discussedIn: "Discussed in:",
  rolledUp: "Rolled up from these interactions",
  interaction: "Interaction",
  clickForDetails: "Click an element or a line for details. Drag elements to untangle.",

  // Trust card
  trustAria: "How far to trust this page",
  trustSummary: "Trust summary",
  noSourceDate: "No source date recorded",
  sourcesRead: (date: string, days: number, stale: boolean, limit: number) =>
    `Sources read ${date} (${days} days ago)${stale ? ` · older than ${limit} days, may be out of date` : ""}`,
  diagramFacts: (confirmed: number, pattern: number, speculative: number) =>
    `${confirmed} elements confirmed by a source, ${pattern} industry pattern${speculative ? `, ${speculative} speculative` : ""}.`,
  diagramLabel: "Diagram:",
  quotationsLabel: "Quotations:",
  noQuotations: "none in this page.",
  quotesPrimary: (n: number) => `${n} found in a primary source`,
  quotesSecondary: (n: number) => `${n} only in a secondary source`,
  quotesManual: (n: number) => `${n} checked by hand (page not machine-readable)`,
  quotesUnverified: (n: number) => `${n} not found`,
  quotesIgnored: (n: number) =>
    `${n} quoted phrase${n === 1 ? "" : "s"} not machine-checked (our own wording, or a claim attributed to a secondary source; the ledger gives each reason)`,
  quoteCaveat: "A found quotation means the words appear in the cited page. It does not prove that the claim built on them is right; the tags and the reviewer notes carry that judgement.",
  tagsMeaning: "What the tags mean",
  tagConfirmed: " a primary source we read states it.",
  tagPattern: " standard practice that no source states for this system.",
  tagSpeculative: " plausible or illustrative, not backed by a source.",
  tagKinds: (
    <><b>Real system</b> is described by its own engineers; a <b>reference design</b> is a standard design and not a claim about any company.</>
  ),
  notVerifiedSummary: (n: number) => `What this page says it did not read, check or claim (${n})`,
  changeHistory: (date: string) => `Change history (last change ${date})`,
  historyNote: (n: number) => `From the repository's commit log: the latest ${n} commits to this note's text.`,
  evidence: (n: number) => `Quotation evidence (${n})`,
  quotation: "Quotation",
  foundIn: "Found in",
  viaArchive: " via Internet Archive",
  readLog: "Read the full verification log",
  reportError: "Report an error on this page",
};

export type Dict = typeof en;

const ptBR: Dict = {
  brandCoffee: "Me pague um café",
  coffeeTitle: "Apoie este projeto no Buy Me a Coffee",
  home: "← Início",
  allTracks: "← Todas as trilhas",
  back: "← Voltar",
  toolkitIndex: "Índice do toolkit",
  unknownTrack: "Trilha desconhecida.",

  readingSettings: "Configurações de leitura",
  language: "Idioma",
  theme: "Tema",
  themes: { system: "Sistema", light: "Claro", warm: "Quente", dark: "Escuro" },
  font: "Fonte",
  fontSystem: "Padrão do sistema",
  textSize: "Tamanho do texto de leitura",
  textSizeAria: "Tamanho do texto de leitura em pixels",
  smaller: "Texto menor",
  larger: "Texto maior",
  diagramFixed: "Os rótulos do diagrama mantêm um tamanho fixo.",
  reset: "Restaurar padrões",

  focus: "Foco",
  focusTitle: "Esconde a legenda e o cartão de resumo",
  print: "Imprimir / PDF",
  printTitle: "Imprima a nota, ou salve como PDF na janela de impressão",
  studied: "✓ Estudado",
  markStudied: "Marcar como estudado",
  markItemStudied: (title) => `Marcar ${title} como estudado`,

  itemType: { System: "Sistema", Primer: "Primer", Incident: "Incidente", Exercise: "Exercício" },
  practice: "prática",
  minutes: (n) => `~${n} min`,
  upNext: "A seguir",
  referenceDesign: "Reference design",
  realSystem: "Sistema real",
  continueLabel: "Continuar",
  start: "Começar",

  heroA: "Aprenda system design percorrendo ",
  heroB: "arquiteturas resolvidas",
  lede: (n) =>
    `${n} estudos de caso com diagramas interativos, um casebook de quedas reais, catorze primers sobre os temas que atravessam todos eles e um workbook de prática. Toda afirmação factual é marcada pelo quanto está sustentada, e as afirmações com fonte apontam para ela.`,
  startInterview: "Começar a trilha de entrevista",
  becomeArchitect: "Tornar-se arquiteto",
  progressSome: (done, total) => `${done} de ${total} páginas marcadas como estudadas. `,
  progressNone: "Marque as páginas ao terminá-las para acompanhar o progresso. ",
  progressLocal: "O progresso fica salvo apenas neste navegador.",
  resetProgress: "Zerar",
  confirmReset: "Apagar todo o progresso neste navegador?",
  pickGoal: "1. Escolha um objetivo",
  pickGoalNote: "Cada trilha é uma lista de leitura em ordem, com o motivo de cada passo. Você pode trocar a qualquer momento.",
  trackMeta: (steps, hours) => `${steps} passos · cerca de ${hours} h de leitura`,
  doneOf: (n, total) => `${n} de ${total} concluídos`,
  howToStudy: "2. Como estudar um sistema",
  method: [
    ["Leia o resumo de 60 segundos", "Abra um sistema e leia a caixa At a glance: os números principais, as decisões e os erros comuns."],
    ["Tente você mesmo", "Feche a página e esboce seu próprio design por dez minutos, com estimativas, antes de olhar adiante."],
    ["Percorra o diagrama", "Alterne entre os níveis Context, Containers e Components. Escolha um flow e avance passo a passo, incluindo os flows de falha."],
    ["Leia o aprofundamento", "Compare com a nota. Veja as reviewer notes: elas listam afirmações populares que as fontes não sustentam."],
    ["Pratique", "Faça a seção de interview practice, responda as perguntas em voz alta e depois adicione os fatos que faltaram aos seus flashcards."],
  ],
  howToRead: "Como ler uma página de sistema e confiar nela",
  legendViews: (
    <><b>Views:</b> Graph, Split (diagrama com a nota ao lado) ou Text. Clique em um componente para ver resumo, fontes e confiança; use ← e → para avançar em um flow.</>
  ),
  legendLevels: (
    <><b>Níveis:</b> Context mostra o sistema como uma caixa só, Containers mostra suas partes, Components abre um container.</>
  ),
  legendTags: (
    <><b>Tags:</b> <b>CONFIRMED</b> foi afirmado por uma fonte primária que lemos; <b>INDUSTRY PATTERN</b> é prática padrão que nenhuma fonte afirma para este sistema; <b>SPECULATIVE</b> é plausível ou ilustrativo. Bordas tracejadas marcam padrões, pontilhadas marcam especulação.</>
  ),
  legendKinds: (
    <><b>Tipos:</b> um <i>sistema real</i> é descrito por seus próprios engenheiros; um <i>reference design</i> é um design padrão montado sobre peças verificadas e não é uma afirmação sobre nenhuma empresa.</>
  ),
  legendLog: "Cada nota termina com um verification log que diz o que foi verificado e o que não foi.",
  browse: "3. Navegue por tudo",
  browseConcept: (link) => <>Procurando uma ideia em vez de um sistema? {link}.</>,
  browseConceptLink: "Navegar por conceito",
  searchPlaceholder: "Busque nos títulos e no texto completo de todas as notas",
  search: "Buscar",
  pages: "Páginas",
  inText: "No texto",
  sections: "seções",
  typeMore: "Continue digitando: a busca no texto começa com três letras.",
  noMatch: "Nenhum resultado.",
  toolkit: "Toolkit",
  toolkitNote: "Material de prática em torno dos sistemas.",
  casebook: "Casebook: incidentes reais",
  primers: "Primers: temas transversais",
  workbook: "Workbook: prática com feedback",
  studiedAria: "estudado",

  trackProgress: (n, total, left, all) => `${n} de ${total} concluídos · faltam cerca de ${left} h de ${all} h`,
  trackComplete: (link) => <><b>Trilha concluída.</b> Revisite o workbook, ou escolha outro objetivo na {link}.</>,
  homePage: "página inicial",

  conceptsTitle: "Navegar por conceito",
  conceptsLede: "A mesma ideia aparece em vários sistemas. Escolha um conceito para ver onde ele é tratado e comparar como cada sistema o usa.",
  filterConcepts: "Filtrar conceitos",
  noConcept: "Nenhum conceito encontrado.",
  conceptsInNote: "Conceitos nesta nota:",

  mermaidSource: "Código Mermaid (o diagrama interativo o substitui)",
  livesInRepo: (href) => `Está no repositório: ${href}`,
  showInDiagram: "Mostrar no diagrama",
  view: "Visualização",
  legendLighter: "mais claro = component",
  legendBorder: " · Borda: sólida = confirmed, tracejada = industry pattern, pontilhada = speculative · Linhas: tracejada = async",
  notTranslated: "Esta página ainda não foi traduzida, por isso aparece em inglês.",

  jumpTo: "Ir para",
  jumpToAria: "Ir para a seção",
  sectionPlaceholder: "Seção…",
  contents: "Conteúdo",
  copyLink: "Copiar link desta seção",
  copied: "copiado",

  noComponentView: "Este sistema não tem visão de components",
  lineLabels: "Rótulos das linhas",
  lineLabelsTitle: "Mostrar ou esconder o texto sobre as linhas",
  svgTitle: "Baixar esta visão como imagem SVG",
  pngTitle: "Baixar esta visão como imagem PNG",
  resetLayout: "Restaurar layout",
  flows: "Flows",
  failureTitle: "Uma falha, sobrecarga ou outro caso anormal",
  noFlows: "Este sistema não tem flows.",
  step: (i, n) => `Passo ${i}/${n}.`,
  happensInside: (label) => <>Acontece dentro de <b>{label}</b> neste nível. Abra um nível mais baixo para ver.</>,
  notDrawn: "Não aparece nesta visão.",
  next: "Próximo →",
  arrowKeys: "ou use as teclas ← e →",
  openContainers: "Abrir a visão de Containers",
  openComponents: "Abrir a visão de Components",
  componentsOf: "Components:",
  quotesFrom: (n) => `Citações destas fontes (${n})`,
  quotesNote: "Palavras das fontes deste elemento que a nota cita e que o verificador encontrou na página. Podem sustentar afirmações próximas em vez de apenas este elemento.",
  discussedIn: "Discutido em:",
  rolledUp: "Agregado a partir destas interações",
  interaction: "Interação",
  clickForDetails: "Clique em um elemento ou linha para ver detalhes. Arraste os elementos para desembaraçar.",

  trustAria: "Quanto confiar nesta página",
  trustSummary: "Resumo de confiança",
  noSourceDate: "Sem data de fonte registrada",
  sourcesRead: (date, days, stale, limit) =>
    `Fontes lidas em ${date} (${days} dias atrás)${stale ? ` · mais de ${limit} dias, pode estar desatualizado` : ""}`,
  diagramFacts: (confirmed, pattern, speculative) =>
    `${confirmed} elementos confirmados por uma fonte, ${pattern} industry pattern${speculative ? `, ${speculative} speculative` : ""}.`,
  diagramLabel: "Diagrama:",
  quotationsLabel: "Citações:",
  noQuotations: "nenhuma nesta página.",
  quotesPrimary: (n) => `${n} encontradas em fonte primária`,
  quotesSecondary: (n) => `${n} só em fonte secundária`,
  quotesManual: (n) => `${n} conferidas à mão (página não legível por máquina)`,
  quotesUnverified: (n) => `${n} não encontradas`,
  quotesIgnored: (n) =>
    `${n} ${n === 1 ? "trecho citado não conferido" : "trechos citados não conferidos"} por máquina (palavras nossas, ou afirmação atribuída a fonte secundária; o ledger dá o motivo de cada um)`,
  quoteCaveat: "Uma citação encontrada significa que as palavras aparecem na página citada. Isso não prova que a afirmação construída sobre elas esteja certa; quem carrega esse julgamento são as tags e as reviewer notes.",
  tagsMeaning: "O que as tags significam",
  tagConfirmed: " uma fonte primária que lemos afirma isso.",
  tagPattern: " prática padrão que nenhuma fonte afirma para este sistema.",
  tagSpeculative: " plausível ou ilustrativo, sem respaldo de fonte.",
  tagKinds: (
    <><b>Sistema real</b> é descrito por seus próprios engenheiros; um <b>reference design</b> é um design padrão e não uma afirmação sobre nenhuma empresa.</>
  ),
  notVerifiedSummary: (n) => `O que esta página diz que não leu, não conferiu ou não afirma (${n})`,
  changeHistory: (date) => `Histórico de mudanças (última em ${date})`,
  historyNote: (n) => `Do log de commits do repositório: os ${n} commits mais recentes no texto desta nota.`,
  evidence: (n) => `Evidência das citações (${n})`,
  quotation: "Citação",
  foundIn: "Encontrada em",
  viaArchive: " via Internet Archive",
  readLog: "Ler o verification log completo",
  reportError: "Reportar um erro nesta página",
};

/** The dictionary for the language chosen in the settings. */
export const useT = (): Dict => (useSettings().lang === "pt-BR" ? ptBR : en);
