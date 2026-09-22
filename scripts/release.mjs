import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { compileElectron } from "./compile-electron.mjs";

const REPO = "rogazth/crew";
const ROOT = path.resolve(import.meta.dirname, "..");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
      cwd: ROOT,
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" },
    });
    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

const { version } = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const tag = `v${version}`;

if (await run("git", ["status", "--porcelain"], { capture: true })) {
  fail("The working tree is dirty. Commit or stash before releasing.");
}

const cargo = await readFile(path.join(ROOT, "Cargo.toml"), "utf8");
const crateVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (crateVersion !== version) {
  fail(`package.json is ${version} but Cargo.toml is ${crateVersion}. Bump both.`);
}

const tags = await run("git", ["tag", "--list", tag], { capture: true });
if (tags) fail(`${tag} already exists. Bump the version in package.json and Cargo.toml.`);

await run("cargo", ["build", "--release", "-p", "crewd"]);
await run("npm", ["run", "build"]);
await compileElectron();
await run("npx", ["electron-builder", "--mac", "--arm64"]);

const zipName = `Crew-${version}-arm64.zip`;
const zip = path.join(ROOT, "release", zipName);
const manifest = {
  version,
  zip: `https://github.com/${REPO}/releases/download/${tag}/${zipName}`,
  sha256: await sha256(zip),
};
const manifestPath = path.join(ROOT, "release", "latest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

await run("git", ["tag", tag]);
await run("git", ["push", "origin", tag]);
await run("gh", [
  "release",
  "create",
  tag,
  zip,
  manifestPath,
  "--title",
  `Crew ${version}`,
  "--generate-notes",
]);

console.log(`\nReleased ${tag}. Installed copies pick it up within 6 hours, or from Crew › Check for Updates.`);
