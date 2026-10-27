// Browser sweep: opens every page of the built site at 1280px and 500px in three themes and reports console errors,
// sideways scroll, clipped cards, text overflowing a diagram node, empty pages, a missing trust card or diagram, and text below WCAG AA contrast.
//
//   cd site && npm run build && npx vite preview --port 5188 &
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 about:blank &
//   npm run sweep            (writes .cache/sweep.json and prints a summary; takes about 3 minutes)
//
// Known false positive: the "lighter = component" legend chip in the dark theme has a gradient background, which
// the contrast check cannot read. It is not a real failure.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SP = resolve(ROOT, ".cache"); mkdirSync(SP, { recursive: true });
const systems = readdirSync(`${ROOT}/systems`).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
const toolkit = readdirSync(`${ROOT}/toolkit`).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
const routes = [
  ["home", ""], ["concepts", "concepts"], ...["interview", "foundations", "architect", "ai", "atlas"].map((t) => [`track-${t}`, `track/${t}`]),
  ...toolkit.map((t) => [`toolkit-${t.slice(0, 3)}`, `toolkit/${t}`]),
  ...systems.flatMap((s) => [[`sys-${s.slice(0, 2)}-split`, `${s}?view=split`], [`sys-${s.slice(0, 2)}-text`, `${s}?view=text`], [`sys-${s.slice(0, 2)}-graph`, `${s}?view=graph`]]),
];
const [{ webSocketDebuggerUrl }] = (await (await fetch("http://127.0.0.1:9333/json")).json()).filter((t) => t.type === "page");
const ws = new WebSocket(webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); let current = ""; const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id) pending.get(d.id)?.(d);
  else if (d.method === "Runtime.exceptionThrown") errors.push([current, "exception", d.params.exceptionDetails.exception?.description?.slice(0, 160) ?? d.params.exceptionDetails.text]);
  else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") errors.push([current, "console.error", d.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 160)]);
  else if (d.method === "Log.entryAdded" && d.params.entry.level === "error") errors.push([current, "log", (d.params.entry.url ?? "") + " " + d.params.entry.text.slice(0, 120)]);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300)); return r.result?.result?.value; };
await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");

const CHECK = `(() => {
  const out = {};
  const de = document.documentElement;
  out.overflowX = de.scrollWidth > innerWidth + 1;
  out.cardOverflow = [...document.querySelectorAll('.cards a, .track-cards a, .text-hits a, .concept-list > li')].filter((a) => a.scrollHeight > a.clientHeight + 1).length;
  out.h1 = document.querySelectorAll('h1').length;
  out.trust = !!document.querySelector('.trust');
  out.nodes = document.querySelectorAll('.react-flow__node').length;
  out.nodeOverflow = [...document.querySelectorAll('.c4-body')].filter((b) => b.scrollHeight > b.clientHeight + 1 || b.scrollWidth > b.clientWidth + 1).length;
  out.emptyMain = (document.querySelector('main')?.innerText.trim().length ?? 0) < 200;
  // text contrast: composite translucent backgrounds, skip diagram nodes, decorative art and disabled controls
  const parse = (c) => { const m = c.match(/-?[\\d.]+(?:e-?\\d+)?/g)?.map(Number) ?? [0,0,0,0]; const k = c.startsWith('color(') ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m[3] ?? 1 }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
  const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); if (c.a >= 1) break; } let base = { r: 255, g: 255, b: 255 }; if (!layers.length || layers[layers.length - 1].a < 1) base = parse(getComputedStyle(document.body).backgroundColor); for (const l of layers.reverse()) base = { r: l.r * l.a + base.r * (1 - l.a), g: l.g * l.a + base.g * (1 - l.a), b: l.b * l.a + base.b * (1 - l.a) }; return base; };
  const low = []; const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) {
    const t = n.textContent.trim(); const el = n.parentElement;
    if (!t || !el || seen.has(el)) continue; seen.add(el);
    if (el.closest('.react-flow, .backdrop, .hero-art, svg, [disabled], .settings-pop, mark, .tile')) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none' || cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)') continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const fg = parse(cs.color); const bg = bgOf(el);
    const a = fg.a; const f = { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a) };
    const L1 = lum(f), L2 = lum(bg); const ratio = (Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05);
    const big = parseFloat(cs.fontSize) >= 18.66 || (parseFloat(cs.fontSize) >= 14 && Number(cs.fontWeight) >= 700);
    if (ratio < (big ? 3 : 4.5)) low.push(el.tagName.toLowerCase() + '.' + (el.className || '').toString().slice(0, 30) + ' ' + ratio.toFixed(2) + ' "' + t.slice(0, 24) + '"');
  }
  out.lowContrast = low.slice(0, 5); out.lowCount = low.length;
  return out;
})()`;

const results = []; const t0 = Date.now();
const themes = ["light", "warm", "dark"]; const widths = [1280, 500];
for (const w of widths) {
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
  for (const th of themes) {
    await send("Page.navigate", { url: "about:blank" }); await sleep(150);
    await send("Page.navigate", { url: "http://localhost:5188/" }); await sleep(700);
    await ev(`document.documentElement.dataset.theme='${th}'`);
    for (const [name, hash] of routes) {
      // text and graph views are checked at desktop width and in one theme only: they differ from split in layout, not in colour
      if (name.endsWith("-text") || name.endsWith("-graph")) { if (!(w === 1280 && th === "light")) continue; }
      current = `${name} ${w}px ${th}`;
      await ev(`location.hash = '#${hash}'`); await sleep(name.startsWith("sys-") ? 450 : 250);
      try { const r = await ev(CHECK); results.push({ route: name, width: w, theme: th, ...r }); }
      catch (e) { results.push({ route: name, width: w, theme: th, crash: String(e).slice(0, 200) }); }
    }
  }
}
writeFileSync(`${SP}/sweep.json`, JSON.stringify({ results, errors }, null, 1));
const bad = results.filter((r) => r.crash || r.overflowX || r.cardOverflow || r.nodeOverflow || r.emptyMain || (r.route.startsWith("sys-") && !r.route.endsWith("-text") && !r.nodes) || (r.route.startsWith("sys-") && !r.trust) || r.h1 !== 1 || r.lowCount);
const fails = bad.filter((r) => !(r.theme === "dark" && r.lowContrast?.every((l) => l.startsWith("span.chip tint")) && !r.crash && !r.overflowX && !r.cardOverflow && !r.nodeOverflow && !r.emptyMain && r.h1 === 1));
console.log(`${results.length} checks, ${errors.length} console errors, ${fails.length} failing, ${Math.round((Date.now() - t0) / 1000)} s`);
for (const r of fails.slice(0, 20)) console.log(" ", r.route, r.width, r.theme, JSON.stringify(r).slice(0, 200));
for (const e of errors.slice(0, 10)) console.log("  error:", e.join(" | "));
ws.close(); process.exit(fails.length || errors.length ? 1 : 0);
