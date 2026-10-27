// Decorative artwork, drawn as SVG so it follows the theme colours and needs no image files.
const NODES: [number, number][] = [
  [120, 120], [340, 70], [560, 190], [820, 90], [1080, 170], [1320, 80],
  [220, 380], [470, 430], [700, 330], [960, 410], [1230, 340],
  [150, 660], [420, 720], [700, 640], [980, 740], [1280, 660], [1380, 840],
];
const EDGES: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4], [4, 5], [0, 6], [2, 8], [1, 7], [6, 7], [7, 8], [8, 9], [9, 10], [4, 10], [6, 11],
  [7, 12], [8, 13], [9, 14], [10, 15], [11, 12], [12, 13], [13, 14], [14, 15], [15, 16],
];
const BOXES = new Set([1, 4, 7, 10, 13, 15, 6]);

// Elbow connectors between nodes, boxes and dots: the look of an architecture diagram, far too faint to read as content.
export function Backdrop() {
  return (
    <svg className="backdrop" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
      <defs>
        <pattern id="bd-dots" width="28" height="28" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.4" fill="currentColor" /></pattern>
      </defs>
      <rect width="1440" height="900" fill="url(#bd-dots)" opacity=".55" />
      <g fill="none" stroke="currentColor" strokeWidth="1.6">
        {EDGES.map(([a, b]) => {
          const [x1, y1] = NODES[a], [x2, y2] = NODES[b], xm = (x1 + x2) / 2;
          return <path key={`${a}-${b}`} d={`M${x1} ${y1}H${xm}V${y2}H${x2}`} />;
        })}
        {NODES.map(([x, y], i) => BOXES.has(i)
          ? <rect key={i} x={x - 32} y={y - 20} width="64" height="40" rx="8" fill="var(--bg)" />
          : <circle key={i} cx={x} cy={y} r="8" fill="var(--bg)" />)}
      </g>
    </svg>
  );
}

// A small C4-style picture for the hero: a person, an API container and three stores inside a dashed system boundary.
export function HeroArt() {
  const box = (x: number, y: number, w: number, h: number, fill: string) =>
    <rect x={x} y={y} width={w} height={h} rx="9" fill={fill} stroke="rgb(255 255 255 / .55)" strokeWidth="2" />;
  return (
    <svg className="hero-art" viewBox="0 0 420 270" aria-hidden="true" focusable="false">
      <defs>
        <marker id="ha-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--muted)" /></marker>
      </defs>
      <rect x="128" y="14" width="284" height="242" rx="14" fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="7 6" />
      <g fill="none" stroke="var(--muted)" strokeWidth="2" markerEnd="url(#ha-arrow)">
        <path d="M72 135H160" /><path d="M250 120H282V68H296" /><path d="M250 135H296" /><path d="M250 150H282V202H296" />
      </g>
      <g fill="var(--p-person)" stroke="rgb(255 255 255 / .55)" strokeWidth="2">
        <circle cx="46" cy="110" r="14" />
        <path d="M20 160c0-22 12-32 26-32s26 10 26 32z" />
      </g>
      {box(160, 106, 90, 58, "var(--p-service)")}
      {box(296, 40, 100, 46, "var(--p-edge)")}
      {box(296, 112, 100, 46, "var(--p-data)")}
      {box(296, 184, 100, 46, "var(--p-queue)")}
      <g stroke="rgb(255 255 255 / .85)" strokeWidth="3" strokeLinecap="round">
        <path d="M178 126h54M178 142h34" /><path d="M314 58h40M314 70h24" /><path d="M314 130h54M314 142h30" /><path d="M314 202h40M314 214h60" />
      </g>
    </svg>
  );
}
