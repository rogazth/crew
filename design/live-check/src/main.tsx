/**
 * Not a prototype — a harness.
 *
 * It mounts the live `DataSource` in a real browser against a real `crewd` and
 * reports what answered, so round 3 ("point a prototype at the daemon") is a
 * wiring job rather than an investigation. Also runs the same checks against the
 * fixture source, so the two implementations are compared on identical calls.
 *
 *   npm run dev   →  http://localhost:5190/?source=live
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  fixtureSource,
  liveSource,
  rosterFrom,
  graph,
  type DataSource,
  type Session,
  type Workspace,
} from "@crew/fixtures";

type Check = { label: string; ok: boolean; detail: string; ms: number };

async function timed(label: string, run: () => Promise<string>): Promise<Check> {
  const started = performance.now();
  try {
    const detail = await run();
    return { label, ok: true, detail, ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      label,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      ms: Math.round(performance.now() - started),
    };
  }
}

async function runChecks(source: DataSource, push: (check: Check) => void) {
  let workspaces: Workspace[] = [];
  let sessions: Session[] = [];

  push(
    await timed("workspaces()", async () => {
      workspaces = await source.workspaces();
      return `${workspaces.length} workspace(s)`;
    }),
  );

  // A live daemon started for this check has an empty store, which is correct
  // and useless. Seed it so every call below has something to answer about.
  if (workspaces.length === 0) {
    push(
      await timed("createWorkspace()", async () => {
        const created = await source.createWorkspace("live-check", "/home/agent/crew");
        workspaces = [created];
        return created.id;
      }),
    );
  }

  const workspace = workspaces[0];
  if (!workspace) {
    push({ label: "sessions()", ok: false, detail: "no workspace to list", ms: 0 });
    return;
  }

  if (source.kind === "live") {
    push(
      await timed("createSession()", async () => {
        const created = await source.createSession(workspace.id, "agent", {
          name: "check",
          provider: "opencode",
          model: "opencode/ling-3.0-flash-fin-free",
          description: "Created by the live check. Never spoken to.",
          autonomy: "ask",
        });
        return created.id;
      }),
    );
  }

  push(
    await timed("sessions()", async () => {
      sessions = await source.sessions(workspace.id);
      return `${sessions.length} session(s)`;
    }),
  );
  push(
    await timed("projectFiles()", async () => {
      const files = await source.projectFiles(workspace.path);
      return `${files.length} file(s)`;
    }),
  );
  push(
    await timed("routines()", async () => {
      const routines = await source.routines();
      return `${routines.length} routine(s)`;
    }),
  );
  push(
    await timed("search()", async () => {
      const hits = await source.search({ query: "agent", limit: 20 });
      return `${hits.length} hit(s)`;
    }),
  );

  const agent = sessions.find((s) => s.kind === "agent");
  if (agent) {
    push(
      await timed("thread().subscribe()", async () => {
        const handle = source.thread(agent.id);
        const state = await new Promise<{ blocks: unknown[]; status: string }>((resolve) => {
          // `subscribe` calls its listener synchronously before it returns, so
          // the unsubscribe function does not exist yet inside the first call.
          // Every consumer of this interface has to hold it in a mutable box.
          let off: (() => void) | null = null;
          let settled = false;
          const finish = (next: { blocks: unknown[]; status: string }) => {
            if (settled) return;
            settled = true;
            off?.();
            resolve(next);
          };
          // The live handle answers empty first, then again when the page lands.
          off = handle.subscribe((next) => {
            if (next.blocks.length > 0) finish(next);
          });
          if (settled) off();
          setTimeout(() => finish(handle.snapshot()), 4_000);
        });
        return `${state.blocks.length} block(s), status ${state.status}`;
      }),
    );
  }

  push(
    await timed("readTextFile()", async () => {
      const text = await source.readTextFile(`${workspace.path}/package.json`);
      return `${text.length} bytes`;
    }),
  );

  // Purely local, but it is the model the prototypes render, so a smoke test of
  // it belongs next to the transport it will eventually read from.
  push(
    await timed("graph(roster)", async () => {
      const roster = rosterFrom(sessions, {});
      const g = graph(roster);
      return `${g.nodes.length} node(s), ${g.edges.length} edge(s)`;
    }),
  );
}

function App() {
  const params = new URLSearchParams(location.search);
  const kind = params.get("source") === "live" ? "live" : "fixtures";
  const [checks, setChecks] = useState<Check[]>([]);
  const [done, setDone] = useState(false);
  const [connection, setConnection] = useState<string>("—");

  useEffect(() => {
    const source = kind === "live" ? liveSource() : fixtureSource();
    const offConnection = source.onConnectionChange?.((up) => setConnection(up ? "open" : "down"));
    let cancelled = false;
    void runChecks(source, (check) => {
      if (!cancelled) setChecks((held) => [...held, check]);
    }).finally(() => !cancelled && setDone(true));
    return () => {
      cancelled = true;
      offConnection?.();
      source.dispose?.();
    };
  }, [kind]);

  const failed = checks.filter((c) => !c.ok).length;

  return (
    <main
      style={{
        font: "13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
        padding: 24,
        maxWidth: 760,
      }}
    >
      <h1 style={{ font: "600 16px/1.3 ui-sans-serif, system-ui", margin: "0 0 4px" }}>
        DataSource check — {kind}
      </h1>
      <p style={{ color: "#666", margin: "0 0 20px" }}>
        socket {connection} · <a href="?source=fixtures">fixtures</a> ·{" "}
        <a href="?source=live">live</a>
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <tbody>
          {checks.map((check) => (
            <tr key={check.label} style={{ borderBottom: "1px solid #eee" }}>
              <td style={{ padding: "6px 8px 6px 0", width: 24 }}>{check.ok ? "✓" : "✕"}</td>
              <td style={{ padding: "6px 8px 6px 0", width: 200 }}>{check.label}</td>
              <td style={{ padding: "6px 8px 6px 0", color: check.ok ? "#333" : "#b00" }}>
                {check.detail}
              </td>
              <td style={{ padding: "6px 0", color: "#999", textAlign: "right" }}>{check.ms}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p data-testid="verdict" style={{ marginTop: 20, fontWeight: 600 }}>
        {done ? (failed === 0 ? `PASS ${checks.length}/${checks.length}` : `FAIL ${failed}`) : "running…"}
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
