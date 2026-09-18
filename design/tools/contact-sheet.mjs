/**
 * Builds `design/shots.html`: every screenshot the three prototypes produced, laid
 * out one route per row so the same surface can be compared side by side.
 *
 *   node tools/contact-sheet.mjs
 */
import { readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const designRoot = resolve(here, "..");
const PROTOS = ["proto-ink", "proto-console", "proto-canvas"];
const TITLES = { "proto-ink": "Ink", "proto-console": "Console", "proto-canvas": "Canvas" };

const ROUTE_TITLES = {
  "chat-long": "Long conversation — s-harness",
  "chat-agents": "Agent-to-agent — s-relay",
  "chat-short": "Short conversation — s-renderer",
  "chat-empty": "Empty conversation — s-triage",
  "chat-failed": "Failed run — s-scribe",
  "chat-huge": "30-call run — s-daemon",
  terminal: "Terminal",
  file: "File editor",
  search: "Search",
  routines: "Routines",
  settings: "Settings — Appearance",
  keybindings: "Settings — Keybindings",
  "real-capture": "Captured from a real daemon run — s-lead",
  "spawned-agent": "The agent it created — s-reviewer",
  "stress-sidebar": "400 sessions in the sidebar",
  "stress-thread": "A 5 000-block transcript",
};

/** shots are named `<theme>-<route>.png`. */
async function shotsOf(proto) {
  const dir = join(designRoot, proto, "shots");
  if (!existsSync(dir)) return new Map();
  const found = new Map();
  for (const file of await readdir(dir)) {
    const match = /^(light|dark)-(.+)\.png$/.exec(file);
    if (!match) continue;
    found.set(`${match[1]}/${match[2]}`, `${proto}/shots/${file}`);
  }
  return found;
}

const byProto = new Map();
for (const proto of PROTOS) byProto.set(proto, await shotsOf(proto));

const keys = [...new Set([...byProto.values()].flatMap((m) => [...m.keys()]))];
const routes = [...new Set(keys.map((k) => k.split("/")[1]))].sort(
  (a, b) => Object.keys(ROUTE_TITLES).indexOf(a) - Object.keys(ROUTE_TITLES).indexOf(b),
);
const themes = ["light", "dark"].filter((t) => keys.some((k) => k.startsWith(`${t}/`)));

const cell = (proto, theme, route) => {
  const src = byProto.get(proto)?.get(`${theme}/${route}`);
  if (!src) return `<figure class="miss"><div>not captured</div><figcaption>${TITLES[proto]}</figcaption></figure>`;
  return `<figure><a href="${src}" target="_blank"><img loading="lazy" src="${src}" alt="${TITLES[proto]} ${route} ${theme}"></a><figcaption>${TITLES[proto]}</figcaption></figure>`;
};

const body = themes
  .map(
    (theme) => `
<section class="theme" id="${theme}">
  <h2>${theme}</h2>
  ${routes
    .map(
      (route) => `
  <div class="route">
    <h3>${ROUTE_TITLES[route] ?? route}</h3>
    <div class="grid">${PROTOS.map((p) => cell(p, theme, route)).join("")}</div>
  </div>`,
    )
    .join("")}
</section>`,
  )
  .join("");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Crew — design prototypes</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: light-dark(oklch(0.985 0 0), oklch(0.17 0 0));
    --fg: light-dark(oklch(0.22 0 0), oklch(0.94 0 0));
    --dim: light-dark(oklch(0.52 0 0), oklch(0.66 0 0));
    --rule: light-dark(oklch(0.88 0 0), oklch(0.30 0 0));
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 24px 64px;
    background: var(--bg); color: var(--fg);
    font: 400 14px/1.5 ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  header { max-width: 1600px; margin: 0 auto 32px; }
  h1 { font-size: 22px; letter-spacing: -0.02em; margin: 0 0 4px; }
  header p { color: var(--dim); margin: 0; }
  nav { margin-top: 16px; display: flex; gap: 12px; }
  nav a { color: inherit; text-decoration: none; border: 1px solid var(--rule); border-radius: 6px; padding: 4px 10px; }
  section.theme { max-width: 1600px; margin: 0 auto 48px; }
  section.theme > h2 {
    position: sticky; top: 0; z-index: 2;
    margin: 0 0 16px; padding: 8px 0;
    background: var(--bg);
    font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--dim);
    border-bottom: 1px solid var(--rule);
  }
  .route { margin-bottom: 36px; }
  .route h3 { font-size: 13px; font-weight: 600; margin: 0 0 10px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  figure { margin: 0; }
  figure img {
    display: block; width: 100%; height: auto;
    border: 1px solid var(--rule); border-radius: 8px; background: var(--bg);
  }
  figcaption { margin-top: 6px; font-size: 12px; color: var(--dim); }
  .miss > div {
    display: grid; place-items: center; aspect-ratio: 16 / 10;
    border: 1px dashed var(--rule); border-radius: 8px; color: var(--dim); font-size: 12px;
  }
</style>
</head>
<body>
<header>
  <h1>Crew — three design systems</h1>
  <p>Same routes, same fixtures, three answers. Click any shot for full size.</p>
  <nav>${themes.map((t) => `<a href="#${t}">${t}</a>`).join("")}</nav>
</header>
${body || "<p style='max-width:1600px;margin:0 auto;color:var(--dim)'>No screenshots yet — run <code>node tools/shoot.mjs --all</code> first.</p>"}
</body>
</html>
`;

const out = join(designRoot, "shots.html");
await writeFile(out, html);
console.log(`${out} — ${routes.length} routes × ${themes.length} themes × ${PROTOS.length} prototypes`);
