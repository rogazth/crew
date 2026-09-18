/**
 * Dev-only bridge between a prototype and a real `crewd`.
 *
 * The app reaches the daemon through Electron's preload, which a browser
 * prototype does not have. This plugin does what `electron/main.ts` does: start
 * the binary, read the `{"url","token"}` line it prints on stdout, and hand it
 * to the page — here over `GET /__crew/daemon` instead of over IPC.
 *
 * It is lazy on purpose. Nothing starts until the page asks, so a prototype run
 * in fixture mode never spawns a daemon, and `npm run build` never touches one.
 *
 * ```ts
 * import { crewd } from "../tools/vite-crewd";
 * export default defineConfig({ plugins: [react(), tailwindcss(), crewd()] });
 * ```
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/**
 * Typed structurally rather than against `vite`, so the plugin can be imported
 * by prototypes that each resolve their own copy of vite: two installs produce
 * two nominally different `Plugin` types and TypeScript refuses the assignment.
 */
type Middleware = (
  req: { method?: string | undefined },
  res: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: string): void;
  },
) => void;

type DevServer = {
  middlewares: { use(path: string, handler: Middleware): void };
  httpServer?: { once(event: "close", handler: () => void): void } | null;
};

type CrewdPlugin = {
  name: string;
  apply: "serve";
  configureServer(server: DevServer): void;
  closeBundle(): void;
};

export type DaemonInfo = { url: string; token: string };

export type CrewdOptions = {
  /** Repo root that holds `target/`. Defaults to two levels above this file. */
  repoRoot?: string;
  /** Explicit binary path; otherwise release then debug. */
  binary?: string;
  /** Extra environment for the child. */
  env?: Record<string, string>;
  /** How long to wait for the info line before giving up. */
  timeoutMs?: number;
  /** Store location. Omit to let the daemon use a per-pid temp dir. */
  dataDir?: string;
};

const here = dirname(fileURLToPath(import.meta.url));

function findBinary(options: CrewdOptions): string | null {
  if (options.binary) return existsSync(options.binary) ? options.binary : null;
  const root = options.repoRoot ?? resolve(here, "../..");
  for (const candidate of [
    join(root, "target/release/crewd"),
    join(root, "target/debug/crewd"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

type State =
  | { status: "idle" }
  | { status: "starting"; promise: Promise<DaemonInfo> }
  | { status: "ready"; info: DaemonInfo }
  | { status: "failed"; error: string };

export function crewd(options: CrewdOptions = {}): CrewdPlugin {
  let child: ChildProcessWithoutNullStreams | null = null;
  let state: State = { status: "idle" };
  const timeout = options.timeoutMs ?? 15_000;

  function start(): Promise<DaemonInfo> {
    const binary = findBinary(options);
    if (!binary) {
      return Promise.reject(
        new Error(
          "No crewd binary. Build one first: `cargo build -p crewd` (debug) or `cargo build --release -p crewd`.",
        ),
      );
    }
    return new Promise<DaemonInfo>((ok, fail) => {
      // stdin stays piped and open: crewd reads EOF on stdin as "my parent is
      // gone" and shuts down, which is how Electron reaps it on quit.
      const proc = spawn(binary, options.dataDir ? [`--data-dir=${options.dataDir}`] : [], {
        cwd: options.repoRoot ?? resolve(here, "../.."),
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...options.env },
      });
      child = proc;

      let settled = false;
      const lines = createInterface({ input: proc.stdout });
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        lines.close();
        fail(new Error(`crewd printed no daemon info within ${timeout}ms`));
      }, timeout);

      lines.on("line", (line) => {
        if (settled) return;
        try {
          const parsed = JSON.parse(line) as Partial<DaemonInfo>;
          if (typeof parsed.url !== "string" || typeof parsed.token !== "string") return;
          settled = true;
          clearTimeout(timer);
          lines.close();
          // Past the handshake the daemon's stdout is logs; draining it keeps
          // the pipe from filling and blocking the process.
          proc.stdout.removeAllListeners();
          proc.stdout.resume();
          ok({ url: parsed.url, token: parsed.token });
        } catch {
          // A log line before the handshake. Ignore it.
        }
      });

      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
      });
      proc.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fail(error);
      });
      proc.once("exit", (code) => {
        child = null;
        state = { status: "failed", error: `crewd exited ${code}\n${stderr.slice(-1_500)}` };
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fail(new Error(`crewd exited ${code} before printing its info\n${stderr.slice(-1_500)}`));
      });
    });
  }

  function ensure(): Promise<DaemonInfo> {
    if (state.status === "ready") return Promise.resolve(state.info);
    if (state.status === "starting") return state.promise;
    const promise = start().then(
      (info) => {
        state = { status: "ready", info };
        return info;
      },
      (error: unknown) => {
        state = { status: "failed", error: error instanceof Error ? error.message : String(error) };
        throw error;
      },
    );
    state = { status: "starting", promise };
    return promise;
  }

  function stop() {
    if (!child) return;
    child.kill("SIGTERM");
    child = null;
    state = { status: "idle" };
  }

  return {
    name: "crew:crewd",
    apply: "serve",
    configureServer(server: DevServer) {
      server.middlewares.use("/__crew/daemon", (req, res) => {
        res.setHeader("content-type", "application/json");
        res.setHeader("cache-control", "no-store");
        if (req.method === "DELETE") {
          stop();
          res.end(JSON.stringify({ stopped: true }));
          return;
        }
        ensure().then(
          (info) => res.end(JSON.stringify(info)),
          (error: unknown) => {
            res.statusCode = 503;
            res.end(
              JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
            );
          },
        );
      });

      // A dev server that restarts must not leave an orphan daemon holding a port.
      server.httpServer?.once("close", stop);
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          stop();
          process.exit(0);
        });
      }
    },
    closeBundle: stop,
  };
}

export default crewd;
