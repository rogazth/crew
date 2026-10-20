// Builds the file-type icon sprite from the Symbols icon theme (Miguel Solorio, MIT).
//
//   node scripts/file-icons.mjs [source-dir]
//
// Reads the vendored theme (default: reference/zeron/crates/ui, gitignored) and writes
// what the app ships, all committed:
//   src/assets/file-icons/sprite.svg     one hidden <svg> of <symbol id="fi-…"> / "fid-…"
//   src/assets/file-icons/palette.css    the palette's dark-mode lifts, as light-dark() vars
//   src/assets/file-icons/LICENSE.symbols
//   src/lib/fileIconManifest.ts          name/extension/folder maps → symbol ids
//
// Each icon is lightly minified (prolog, comments, metadata, sizes and whitespace
// stripped, path numbers rounded to 2 decimals), its internal ids are prefixed so
// gradients and clip paths don't clash in one document, and every Tailwind palette
// colour it uses becomes `var(--fi-<colour>,#HEX)`. Icons still heavier than
// MAX_BYTES (raster or traced brand logos) are dropped and their manifest entries
// fall back to the generic file or folder.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The checkout's reference/, or the main checkout's when run from a worktree.
const candidates = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [path.join(repo, "reference/zeron/crates/ui"), path.resolve(repo, "../../../reference/zeron/crates/ui")];
const src = candidates.find((dir) => fs.existsSync(path.join(dir, "src/file-icons.json")));
if (!src) throw new Error(`Symbols theme not found in ${candidates.join(" or ")}`);
const assetsDir = path.join(src, "assets/file-icons");
const manifestPath = path.join(src, "src/file-icons.json");
const outDir = path.join(repo, "src/assets/file-icons");
const outManifest = path.join(repo, "src/lib/fileIconManifest.ts");

/** Heavier than this after minifying, an icon is dropped for the generic one. */
const MAX_BYTES = 8 * 1024;
/** Worth their weight even so: common in the repos Crew opens. */
const KEEP_HEAVY = new Set(["files/rust.svg", "files/claude.svg", "files/bun.svg", "files/svelte.svg", "files/yarn.svg", "folders/folder-claude.svg"]);

/** Referenced by the upstream manifest without a definition; zeron's aliases. */
const ALIASES = { less: "brackets-sky", yml: "yaml" };

/** Off-by-one exports of Tailwind colours, snapped so they share a variable. */
const SNAP = { "#E95A0C": "#EA580C", "#895BF6": "#8B5CF6", "#21C55D": "#22C55E", "#F87272": "#F87171", "#F471B4": "#F472B6", "#FDE049": "#FDE047" };

/**
 * The Tailwind colours the set uses: name, light (authored) and dark value. The
 * first seven dark values are zeron's `dark_icon_svg`; the rest lift the other
 * 600/700 shades the same way, and the light ones stay as authored.
 */
const PALETTE = [
  ["slate-500", "#64748B", "#CBD5E1"],
  ["zinc-500", "#71717A", "#D4D4D8"],
  ["blue-600", "#2563EB", "#60A5FA"],
  ["orange-600", "#EA580C", "#FB923C"],
  ["green-600", "#16A34A", "#4ADE80"],
  ["violet-500", "#8B5CF6", "#A78BFA"],
  ["purple-500", "#A855F7", "#C084FC"],
  ["slate-600", "#475569", "#94A3B8"],
  ["cyan-600", "#0891B2", "#22D3EE"],
  ["pink-600", "#DB2777", "#F472B6"],
  ["purple-700", "#7E22CE", "#C084FC"],
  ["blue-400", "#60A5FA"],
  ["blue-300", "#93C5FD"],
  ["red-400", "#F87171"],
  ["red-200", "#FECACA"],
  ["pink-400", "#F472B6"],
  ["teal-400", "#2DD4BF"],
  ["teal-500", "#14B8A6"],
  ["purple-400", "#C084FC"],
  ["violet-400", "#A78BFA"],
  ["green-500", "#22C55E"],
  ["green-400", "#4ADE80"],
  ["amber-500", "#F59E0B"],
  ["amber-400", "#FBBF24"],
  ["yellow-500", "#EAB308"],
  ["yellow-300", "#FDE047"],
  ["yellow-200", "#FEF08A"],
  ["sky-500", "#0EA5E9"],
  ["sky-400", "#38BDF8"],
  ["orange-400", "#FB923C"],
  ["orange-200", "#FED7AA"],
  ["zinc-400", "#A1A1AA"],
  ["slate-300", "#CBD5E1"],
  ["zinc-300", "#D4D4D8"],
];
const BY_HEX = new Map(PALETTE.map(([name, light, dark]) => [light, { name, light, dark }]));

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

// ---- minify -------------------------------------------------------------------

function round(token, places = 2) {
  const scale = 10 ** places;
  const n = Math.round(Number(token) * scale) / scale;
  let s = String(Object.is(n, -0) ? 0 : n);
  if (s.startsWith("0.")) s = s.slice(1);
  else if (s.startsWith("-0.")) s = "-" + s.slice(2);
  return s;
}

const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };

/**
 * Path data rewritten compactly: absolute coordinates rounded to 1 decimal (a
 * 24-unit box drawn at 16px: under 0.04px of error), each segment then written
 * absolute or relative, whichever is shorter, with repeated commands implicit.
 * Relative steps are taken between rounded points, so rounding never drifts.
 */
function roundPath(d) {
  // Arc flags may be packed ("011"), which a number tokenizer would misread.
  if (/[aA]/.test(d)) return d.replace(/\s+/g, " ").trim();
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const q = (n) => Math.round(n * 10) / 10;

  // 1. Absolute segments, every coordinate rounded.
  const segs = [];
  let x = 0, y = 0, sx = 0, sy = 0, i = 0, cmd = "";
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) return d; // malformed: leave as authored
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    if (!(up in ARITY)) return d;
    if (up === "Z") {
      segs.push(["Z", []]);
      x = sx; y = sy;
      cmd = ""; // a number after Z needs a new command
      continue;
    }
    const n = tokens.slice(i, i + ARITY[up]).map(Number);
    if (n.length < ARITY[up] || n.some(Number.isNaN)) return d;
    i += ARITY[up];
    let abs;
    if (up === "H") abs = [q(rel ? x + n[0] : n[0])];
    else if (up === "V") abs = [q(rel ? y + n[0] : n[0])];
    else abs = n.map((v, k) => q(rel ? v + (k % 2 ? y : x) : v));
    segs.push([up, abs]);
    if (up === "H") x = abs[0];
    else if (up === "V") y = abs[0];
    else { x = abs[abs.length - 2]; y = abs[abs.length - 1]; }
    if (up === "M") { sx = x; sy = y; cmd = rel ? "l" : "L"; }
  }

  // 2. Re-emit, shortest form per segment.
  const num = (v) => {
    let t = String(Object.is(v, -0) ? 0 : v);
    if (t.startsWith("0.")) t = t.slice(1);
    else if (t.startsWith("-0.")) t = "-" + t.slice(2);
    return t;
  };
  const join = (nums, prev) => {
    let out = "";
    for (const v of nums) {
      const t = num(v);
      if (prev && !(t.startsWith("-") || (t.startsWith(".") && /[.e]/i.test(prev)))) out += " ";
      out += t;
      prev = t;
    }
    return [out, prev];
  };
  let out = "", last = "", prevNum = "";
  x = 0; y = 0; sx = 0; sy = 0;
  for (let [up, abs] of segs) {
    if (up === "Z") {
      out += "z"; last = "z"; prevNum = "";
      x = sx; y = sy;
      continue;
    }
    if (up === "L" && abs[1] === y) [up, abs] = ["H", [abs[0]]];
    else if (up === "L" && abs[0] === x) [up, abs] = ["V", [abs[1]]];
    const relNums = up === "H" ? [q(abs[0] - x)] : up === "V" ? [q(abs[0] - y)] : abs.map((v, k) => q(v - (k % 2 ? y : x)));
    const forms = [up === "M" && !segs.length ? null : [up.toLowerCase(), relNums], [up, abs]].filter(Boolean);
    let best = null;
    for (const [letter, nums] of forms) {
      const implicit = letter === last && !/[mM]/.test(letter);
      const [text, endNum] = join(nums, implicit ? prevNum : "");
      const full = (implicit ? "" : letter) + text;
      if (!best || full.length < best[0].length) best = [full, letter, endNum];
    }
    out += best[0]; last = best[1]; prevNum = best[2];
    if (up === "H") x = abs[0];
    else if (up === "V") y = abs[0];
    else { x = abs[abs.length - 2]; y = abs[abs.length - 1]; }
    if (up === "M") { sx = x; sy = y; }
  }
  return out;
}

function roundList(value) {
  return value.trim().split(/[\s,]+/).map(round).join(" ");
}

function attrs(tag) {
  const map = {};
  for (const [, key, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) map[key] = value;
  return map;
}

const KEEP_ON_ROOT = /^(fill|stroke|stroke-.*|fill-rule|fill-opacity|clip-rule|opacity|color|style|shape-rendering)$/;

function colour(hex) {
  let h = hex.toUpperCase();
  if (h.length === 4) h = "#" + [...h.slice(1)].map((c) => c + c).join("");
  h = SNAP[h] ?? h;
  const entry = BY_HEX.get(h);
  return entry ? `var(--fi-${entry.name},${h})` : h;
}

const used = new Set();

function minify(svg, symbolId) {
  let s = svg
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(metadata|title|desc|sodipodi:[\w-]+|inkscape:[\w-]+)\b[\s\S]*?(<\/\1>|\/>)/g, "");
  const open = s.match(/<svg\b[^>]*>/);
  if (!open) throw new Error(`${symbolId}: no <svg>`);
  const root = attrs(open[0]);
  const body = s.slice(open.index + open[0].length, s.lastIndexOf("</svg>"));
  const viewBox = root.viewBox ?? `0 0 ${parseFloat(root.width) || 24} ${parseFloat(root.height) || 24}`;

  let inner = body
    .replace(/\s+/g, " ")
    .replace(/>\s+</g, "><")
    .replace(/\s+(\/?>)/g, "$1")
    .trim()
    .replace(/xlink:href=/g, "href=")
    .replace(/\s(?:xmlns(?::\w+)?|data-[\w-]+|inkscape:[\w-]+|sodipodi:[\w-]+)="[^"]*"/g, "")
    .replace(/\s(fill|stroke)="None"/g, ' $1="none"')
    .replace(/\sd="([^"]*)"/g, (_, d) => ` d="${roundPath(d)}"`)
    .replace(/\spoints="([^"]*)"/g, (_, p) => ` points="${roundList(p)}"`)
    .replace(/\s(x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|stroke-width|offset)="(-?[\d.]+)"/g, (_, k, v) => ` ${k}="${round(v)}"`);

  // Internal ids: short and per-icon, so one document can hold every icon.
  const ids = [...inner.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  ids.forEach((id, i) => {
    const next = `${symbolId}_${i.toString(36)}`;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    inner = inner
      .replace(new RegExp(`\\sid="${esc}"`, "g"), ` id="${next}"`)
      .replace(new RegExp(`url\\(\\s*['"]?#${esc}['"]?\\s*\\)`, "g"), `url(#${next})`)
      .replace(new RegExp(`href="#${esc}"`, "g"), `href="#${next}"`);
  });

  // Palette colours → variables (attributes and inline styles alike).
  inner = inner.replace(/((?:fill|stroke|stop-color|flood-color|color)\s*(?:=\s*"|:\s*))(#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})\b/g, (_, lead, hex) => {
    const out = colour(hex);
    if (out.startsWith("var(")) used.add(out.slice(9, out.indexOf(",")));
    return lead + out;
  });

  const keep = Object.entries(root)
    .filter(([k]) => KEEP_ON_ROOT.test(k))
    .map(([k, v]) => ` ${k}="${v.replace(/#[0-9a-fA-F]{3,6}\b/g, colour)}"`)
    .join("");
  const content = keep ? `<g${keep}>${inner}</g>` : inner;
  return { viewBox: viewBox.trim().split(/[\s,]+/).map(round).join(" "), content };
}

// ---- build --------------------------------------------------------------------

const definitionPath = (definition) => manifest.iconDefinitions[ALIASES[definition] ?? definition]?.iconPath?.replace(/^\.\/icons\//, "");

const symbols = new Map(); // asset path → { id, viewBox, content, bytes }
const byContent = new Map(); // viewBox+content → id (identical art shares a symbol)
const dropped = [];
const idOf = (asset) => (asset.startsWith("folders/") ? "fid-" : "fi-") + path.basename(asset, ".svg");

function symbolFor(asset) {
  if (symbols.has(asset)) return symbols.get(asset).id;
  const file = path.join(assetsDir, asset);
  if (!fs.existsSync(file)) return null;
  const id = idOf(asset);
  const raw = fs.readFileSync(file, "utf8");
  const { viewBox, content } = minify(raw, id);
  const key = viewBox + "|" + content.replaceAll(id + "_", "@_");
  const bytes = Buffer.byteLength(content);
  if (/<image\b/.test(content) || (bytes > MAX_BYTES && !KEEP_HEAVY.has(asset))) {
    dropped.push(`${asset} (${(bytes / 1024).toFixed(1)} KB)`);
    symbols.set(asset, { id: null });
    return null;
  }
  const twin = byContent.get(key);
  if (twin) {
    symbols.set(asset, { id: twin });
    return twin;
  }
  byContent.set(key, id);
  symbols.set(asset, { id, viewBox, content, bytes });
  return id;
}

const defaultFile = symbolFor(definitionPath(manifest.file) ?? "files/document.svg");
const defaultFolder = symbolFor(definitionPath(manifest.folder) ?? "folders/folder.svg");

function mapOf(table, fallback) {
  const out = {};
  for (const key of Object.keys(table).sort()) {
    const asset = definitionPath(table[key]);
    const id = (asset && symbolFor(asset)) ?? fallback;
    // Entries that would only restate the default are left to the fallback.
    if (id !== fallback) out[key.toLowerCase()] = id;
  }
  return out;
}

const fileNames = mapOf(manifest.fileNames ?? {}, defaultFile);
const fileExtensions = mapOf(manifest.fileExtensions ?? {}, defaultFile);
const languageIds = mapOf(manifest.languageIds ?? {}, defaultFile);
const folderNames = mapOf(manifest.folderNames ?? {}, defaultFolder);

const live = [...symbols.values()].filter((s) => s.content).sort((a, b) => a.id.localeCompare(b.id));
const sprite =
  `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">` +
  live.map((s) => `<symbol id="${s.id}" viewBox="${s.viewBox}">${s.content}</symbol>`).join("") +
  `</svg>\n`;

const vars = PALETTE.filter(([name, , dark]) => dark && used.has(name));
const palette =
  `/* Generated by scripts/file-icons.mjs — do not edit.\n` +
  ` * The Symbols palette, lifted for dark mode. Icons read var(--fi-<colour>, #light);\n` +
  ` * light-dark() follows color-scheme, so the OS and Crew's forced modes both apply. */\n` +
  `:root {\n` +
  vars.map(([name, light, dark]) => `  --fi-${name}: light-dark(${light}, ${dark});\n`).join("") +
  `}\n`;

const ts =
  `// Generated by scripts/file-icons.mjs — do not edit. Symbols icon theme (MIT), see\n` +
  `// src/assets/file-icons/LICENSE.symbols. Keys are lowercase; values are sprite symbol ids.\n\n` +
  `export const DEFAULT_FILE_ICON = ${JSON.stringify(defaultFile)};\n` +
  `export const DEFAULT_FOLDER_ICON = ${JSON.stringify(defaultFolder)};\n\n` +
  `export const FILE_NAMES: Record<string, string> = ${JSON.stringify(fileNames)};\n\n` +
  `export const FILE_EXTENSIONS: Record<string, string> = ${JSON.stringify(fileExtensions)};\n\n` +
  `export const LANGUAGE_IDS: Record<string, string> = ${JSON.stringify(languageIds)};\n\n` +
  `export const FOLDER_NAMES: Record<string, string> = ${JSON.stringify(folderNames)};\n`;

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "sprite.svg"), sprite);
fs.writeFileSync(path.join(outDir, "palette.css"), palette);
fs.copyFileSync(path.join(assetsDir, "LICENSE.symbols"), path.join(outDir, "LICENSE.symbols"));
fs.writeFileSync(outManifest, ts);

const { gzipSync } = await import("node:zlib");
const kb = (n) => (n / 1024).toFixed(1) + " KB";
console.log(`${live.length} symbols, sprite ${kb(Buffer.byteLength(sprite))} (${kb(gzipSync(sprite).length)} gzip)`);
console.log(`${Object.keys(fileNames).length} names, ${Object.keys(fileExtensions).length} extensions, ${Object.keys(folderNames).length} folders, ${vars.length} dark vars`);
if (dropped.length) console.log(`dropped: ${dropped.join(", ")}`);
