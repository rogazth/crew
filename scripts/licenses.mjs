// Writes target/licenses.txt: the licenses of the npm packages Crew ships (the
// non-dev entries of package-lock.json), each with the text of its license file.
// electron-builder copies it into the bundle (package.json › extraResources) and
// Settings › About › Licenses opens it. Run by app:build and release-publish.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "target", "licenses.txt");
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|$|-)/i;

function licenseName(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license && typeof license.type === "string") return license.type;
  if (Array.isArray(licenses)) return licenses.map((entry) => entry.type ?? String(entry)).join(" OR ");
  return "UNKNOWN";
}

async function licenseText(dir) {
  const files = (await readdir(dir).catch(() => [])).filter((name) => LICENSE_FILE.test(name)).sort();
  const texts = [];
  for (const name of files) texts.push((await readFile(path.join(dir, name), "utf8")).trim());
  return texts.join("\n\n");
}

const lock = JSON.parse(await readFile(path.join(ROOT, "package-lock.json"), "utf8"));
const entries = [];
for (const [key, meta] of Object.entries(lock.packages ?? {})) {
  if (!key || meta.dev || meta.link) continue;
  const dir = path.join(ROOT, key);
  if (!existsSync(path.join(dir, "package.json"))) continue;
  const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
  entries.push({ name: manifest.name ?? key.replace(/^.*node_modules\//, ""), version: manifest.version ?? "", license: licenseName(manifest), text: await licenseText(dir) });
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const rule = "=".repeat(72);
const body = entries
  .map((entry) => `${rule}\n${entry.name} ${entry.version}\nLicense: ${entry.license}\n${rule}\n\n${entry.text || "(No license file ships with this package.)"}\n`)
  .join("\n");
const header = `Crew is MIT licensed. It includes the open source software below.\n\n`;
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, header + body);
console.log(`licenses: ${entries.length} packages -> ${path.relative(ROOT, OUT)}`);
