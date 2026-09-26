// Plan 2026-09-25, phase 1: a terminal session reaches Crew's tools. The daemon
// completes the argv the window builds: Claude gets `--mcp-config` (added to
// the user's own servers, never `--strict-mcp-config`), and the process gets a
// token of its own in CREW_TOKEN. From the CLI's shell, `crew call list_agents`
// answers with the agents of its workspace.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, newTerminal, typeInTerminal, waitFor } from "./harness.ts";

test("a terminal session lists the workspace's agents through the bridge", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [main] = crew.workspaces;
  assert.ok(main);

  const agent = await crew.request<Session>("session_create", {
    workspaceId: main.id,
    kind: "agent",
    name: "Reviewer",
    provider: "claude",
    model: "",
    description: "",
    autonomy: "ask",
  });
  const shell = await newTerminal(crew, main.id);

  const launch = (await crew.claudeLaunches()).find((row) => row.argv.includes(shell.id));
  assert.ok(launch, "the terminal's CLI started");
  const at = launch.argv.indexOf("--mcp-config");
  assert.ok(at > 0, `no --mcp-config in ${JSON.stringify(launch.argv)}`);
  assert.ok(!launch.argv.includes("--strict-mcp-config"), "the user's own servers would be dropped");
  const config = JSON.parse(launch.argv[at + 1] ?? "{}") as {
    mcpServers: { crew: { command: string; args: string[] } };
  };
  const crewd = config.mcpServers.crew.command;
  assert.deepEqual(config.mcpServers.crew.args, ["--mcp"]);

  // The fake claude's `!` runs a shell command in the session's cwd, with the
  // environment it was started with: the one the daemon handed it.
  const out = path.join(launch.cwd, `agents-${Date.now().toString(36)}.txt`);
  await typeInTerminal(crew, `!'${crewd}' call list_agents > '${out}' 2>&1`);
  const listed = await waitFor(() => readFile(out, "utf8").catch(() => ""), {
    timeout: 15_000,
    message: "crew call list_agents answers",
  });
  assert.ok(listed.includes(agent.id), `list_agents answered: ${listed}`);
  assert.ok(!listed.includes(shell.id), "a terminal session is not an agent");
});
