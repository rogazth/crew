// Walks a local build through real updates, the way an installed copy takes a
// release: Crew bundles of made-up versions, a release feed on localhost signed
// with a throwaway key, and the bundle installed where a user would keep it.
// Nothing touches the installed Crew: the bundles have an appId of their own and
// run on "Crew Local" data.
//
//   node scripts/update-e2e.mjs build 50.0.1 50.0.2 50.0.3   → bundles and zips, one per version
//   node scripts/update-e2e.mjs serve                        → the feed, on 127.0.0.1:47321
//   node scripts/update-e2e.mjs publish 50.0.2 [--bad-sha]   → makes a version the latest release
//   node scripts/update-e2e.mjs install 50.0.1               → puts that bundle in <dir>/Applications
//
// Everything lives in CREW_UPDATE_E2E_DIR (default: $TMPDIR/crew-update-e2e).
// crewd answers with its crate version and the app refuses one that differs, so
// each version builds its own crewd, from a copy of the workspace.
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile } from "@electron/asar";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
process.chdir(ROOT);
const { compileElectron } = await import("./compile-electron.mjs");

const DIR = process.env.CREW_UPDATE_E2E_DIR || path.join(tmpdir(), "crew-update-e2e");
const PORT = 47321;
const FEED = `http://127.0.0.1:${PORT}`;
const APP_ID = "rogazth.crew.update-e2e";
const KEYS = path.join(DIR, "keys.json");
const SRC = path.join(DIR, "src");
const TARGET = path.join(DIR, "target");
const APP = path.join(DIR, "app");
const zipName = (version) => `Crew-${version}-arm64.zip`;
const zipOf = (version) => path.join(DIR, "feed", "download", `v${version}`, zipName(version));
const bundleOf = (version) => path.join(DIR, "builds", version, "mac-arm64", "Crew.app");

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false", ...options.env },
      cwd: options.cwd ?? ROOT,
    });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited ${code}`))));
  });
}

function keys() {
  if (!existsSync(KEYS)) {
    const pair = generateKeyPairSync("ed25519");
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      KEYS,
      JSON.stringify({
        public: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        private: pair.privateKey.export({ format: "pem", type: "pkcs8" }),
      }),
    );
  }
  return JSON.parse(readFileSync(KEYS, "utf8"));
}

// Paths in package.json's build config are relative to the repo; the app is packed from a folder of its own.
function absolute(entries) {
  return entries.map((entry) => ({ ...entry, from: path.resolve(ROOT, entry.from) }));
}

async function build(versions) {
  const { public: key } = keys();
  // The parts of the app that do not change with the version, once.
  await run("swift", ["build", "-c", "release", "--package-path", "macos/menubar"]);
  await run("node", ["scripts/licenses.mjs"]);
  await run("npm", ["run", "build"]);
  // Packed from APP, not the repo: another build or a dev run there rewrites
  // electron-dist and dist meanwhile, and the bundle would miss the feed.
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });
  execFileSync("cp", ["-R", "dist", APP]);
  await compileElectron({ updateFeed: { releases: FEED, key }, outdir: path.join(APP, "electron-dist") });
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const { dependencies: _deps, devDependencies: _dev, build: config, ...meta } = pkg;
  writeFileSync(path.join(APP, "package.json"), JSON.stringify(meta, null, 2));
  const electronVersion = JSON.parse(readFileSync("node_modules/electron/package.json", "utf8")).version;
  rmSync(SRC, { recursive: true, force: true });
  mkdirSync(SRC, { recursive: true });
  for (const item of ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", "package.json", "crates"]) {
    execFileSync("cp", ["-R", item, SRC]);
  }
  for (const version of versions) {
    const cargo = path.join(SRC, "Cargo.toml");
    writeFileSync(cargo, readFileSync(cargo, "utf8").replace(/^version = ".*"$/m, `version = "${version}"`));
    await run("cargo", ["build", "--release", "-p", "crewd", "-p", "crew-cli"], {
      cwd: SRC,
      env: { CARGO_TARGET_DIR: TARGET },
    });
    const out = path.join(DIR, "builds", version);
    rmSync(out, { recursive: true, force: true });
    const file = path.join(DIR, `builder-${version}.json`);
    const ours = { crewd: path.join(TARGET, "release/crewd"), crew: path.join(TARGET, "release/crew") };
    writeFileSync(
      file,
      JSON.stringify({
        ...config,
        appId: APP_ID,
        electronVersion,
        npmRebuild: false,
        extraMetadata: { version },
        directories: { output: out, buildResources: path.resolve(ROOT, config.directories.buildResources) },
        extraResources: absolute(config.extraResources).map((entry) => (ours[entry.to] ? { ...entry, from: ours[entry.to] } : entry)),
        afterSign: path.resolve(ROOT, config.afterSign),
        mac: {
          ...config.mac,
          extraResources: absolute(config.mac.extraResources),
          entitlements: path.resolve(ROOT, config.mac.entitlements),
          entitlementsInherit: path.resolve(ROOT, config.mac.entitlementsInherit),
          target: [{ target: "dir", arch: ["arm64"] }],
        },
      }),
    );
    await run("npx", ["electron-builder", "--mac", "--arm64", "--projectDir", APP, "--config", file, "--publish", "never"]);
    const asar = path.join(bundleOf(version), "Contents/Resources/app.asar");
    if (!extractFile(asar, "electron-dist/main.cjs").toString().includes(FEED)) throw new Error(`${version} was packed without the feed`);
    const zip = zipOf(version);
    mkdirSync(path.dirname(zip), { recursive: true });
    rmSync(zip, { force: true });
    await run("/usr/bin/ditto", ["-c", "-k", "--keepParent", bundleOf(version), zip]);
    console.log(`built ${version}: ${zip}`);
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function publish(version, bad) {
  const zip = zipOf(version);
  if (!existsSync(zip)) throw new Error(`${version} is not built`);
  const manifest = {
    version,
    zip: `${FEED}/download/v${version}/${zipName(version)}`,
    sha256: bad ? "0".repeat(64) : await sha256(zip),
    size: statSync(zip).size,
    date: new Date().toISOString(),
    notes: [{ kind: "new", text: `Update e2e release ${version}` }],
  };
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  const signature = sign(null, Buffer.from(text, "utf8"), keys().private).toString("base64");
  const latest = path.join(DIR, "feed", "latest", "download", "latest.signed.json");
  mkdirSync(path.dirname(latest), { recursive: true });
  writeFileSync(latest, JSON.stringify({ manifest: text, signature }));
  console.log(`published ${version}${bad ? " with a wrong checksum" : ""}`);
}

function serve() {
  const root = path.join(DIR, "feed");
  createServer((request, response) => {
    const file = path.join(root, decodeURIComponent(new URL(request.url ?? "/", FEED).pathname));
    const ok = file.startsWith(root) && existsSync(file) && statSync(file).isFile();
    console.log(`${new Date().toISOString()} ${request.method} ${request.url} ${ok ? 200 : 404}`);
    if (!ok) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-length": statSync(file).size });
    createReadStream(file).pipe(response);
  }).listen(PORT, "127.0.0.1", () => console.log(`feed on ${FEED}, from ${root}`));
}

async function install(version) {
  const target = path.join(DIR, "Applications", "Crew.app");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(path.dirname(target), { recursive: true });
  await run("/usr/bin/ditto", [bundleOf(version), target]);
  console.log(`installed ${version} at ${target}`);
}

const [command, ...rest] = process.argv.slice(2);
switch (command) {
  case "build":
    await build(rest);
    break;
  case "serve":
    serve();
    break;
  case "publish":
    await publish(rest[0], rest.includes("--bad-sha"));
    break;
  case "install":
    await install(rest[0]);
    break;
  default:
    console.error("usage: update-e2e.mjs build <version...> | serve | publish <version> [--bad-sha] | install <version>");
    process.exit(1);
}
