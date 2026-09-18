/**
 * Build and serve a prototype without touching its working tree.
 *
 * The tools used to run `vite build` in place and `vite preview` on top of it.
 * Both are hostile while someone is working in that directory: the build wipes
 * `dist/` under a running preview, and the preview fights the dev server for the
 * port. So a tool run builds into a scratch directory and serves it from a plain
 * node static server that depends on nothing in the prototype.
 */
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".map": "application/json; charset=utf-8",
};

/** Builds `cwd` into a fresh scratch directory and resolves its path. */
export async function buildTo(cwd, label) {
  const out = await mkdtemp(join(tmpdir(), `crew-${label}-`));
  const result = await new Promise((done) => {
    const child = spawn("npx", ["vite", "build", "--outDir", out, "--emptyOutDir"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.stderr.on("data", (c) => (text += c));
    child.on("exit", (code) => done({ code, text }));
  });
  if (result.code !== 0) throw new Error(result.text.slice(-2_000));
  return { dir: out, output: result.text };
}

/**
 * A static server for a built SPA: any path that is not a file falls back to
 * `index.html`, which is what makes hash routes and unknown paths both work.
 */
export function staticServer(dir, port) {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const wanted = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const candidate = resolve(root, `.${wanted}`);
    // Never serve outside the build directory, whatever the path claims.
    const safe = candidate === root || candidate.startsWith(root + sep);
    const target = safe ? candidate : root;

    const send = (file) => {
      res.setHeader("content-type", TYPES[extname(file)] ?? "application/octet-stream");
      res.setHeader("cache-control", "no-store");
      createReadStream(file).pipe(res);
    };

    stat(target)
      .then((info) => (info.isFile() ? send(target) : send(join(root, "index.html"))))
      .catch(() => send(join(root, "index.html")));
  });
  return new Promise((ok, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}

export function closeServer(server) {
  return new Promise((done) => server.close(() => done()));
}
