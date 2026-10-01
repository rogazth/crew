// Plan 2026-10-01: a session started with start_session is listed under
// whoever started it, and opens as Crew's chat. The terminal's CLI starts it
// from its own shell with `crew sessions start`, with the terminal's token, so
// the parent is the terminal; a fake opencode in $HOME/.local/bin answers.
import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Session } from "../src/lib/types.ts";
import { launchCrew, newTerminal, typeInTerminal, waitFor, type Crew } from "./harness.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CREW = path.join(ROOT, "target/debug/crew");

/** An opencode that answers each turn with the last line it was handed. */
async function installFakeOpencode(crew: Crew): Promise<void> {
  const bin = path.join(crew.home, ".local/bin");
  await mkdir(bin, { recursive: true });
  const file = path.join(bin, "opencode");
  await writeFile(
    file,
    `#!/usr/bin/env python3
import json, sys, uuid
prompt = sys.stdin.read()
args = sys.argv[1:]
sid = args[args.index("--session") + 1] if "--session" in args else "ses_" + uuid.uuid4().hex[:8]
last = prompt.strip().splitlines()[-1]
print(json.dumps({"type": "text", "sessionID": sid, "part": {"id": "t1", "type": "text", "text": "Done: " + last}}), flush=True)
print(json.dumps({"type": "step_finish", "sessionID": sid, "part": {"id": "s1", "type": "step-finish", "reason": "stop", "tokens": {"input": 1, "output": 1, "reasoning": 0, "cache": {"read": 0, "write": 0}}, "cost": 0}}), flush=True)
`,
  );
  await chmod(file, 0o755);
}

const sessions = (crew: Crew, workspaceId: string) => crew.request<Session[]>("session_list", { workspaceId });

test("a session a terminal started is listed under it and opens as a chat", async (t) => {
  const crew = await launchCrew();
  t.after(() => crew.close());
  const [main] = crew.workspaces;
  assert.ok(main);
  await installFakeOpencode(crew);

  const shell = await newTerminal(crew, main.id);
  await typeInTerminal(crew, `!'${CREW}' sessions start opencode --name "Lint pass" -- tidy the imports`);

  const child = await waitFor(
    async () => (await sessions(crew, main.id)).find((row) => row.kind === "child"),
    { timeout: 20_000, message: "the child reaches crewd" },
  );
  assert.equal(child.parentId, shell.id, "the terminal is its parent");
  assert.equal(child.name, "Lint pass");
  await waitFor(async () => (await sessions(crew, main.id)).find((row) => row.id === child.id)?.status === "idle", {
    timeout: 20_000,
    message: "its first turn ends",
  });

  // Listed under the terminal, not beside it.
  const nested = crew.window.locator('[data-child][data-session]', { hasText: "Lint pass" });
  await nested.waitFor({ timeout: 10_000 });
  const order = await crew.window.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-session]")].map((row) => ({
      text: row.textContent ?? "",
      child: row.dataset.child === "true",
    })),
  );
  const at = order.findIndex((row) => row.child && row.text.includes("Lint pass"));
  assert.ok(at > 0, JSON.stringify(order));
  assert.ok(!order[at - 1]?.child, `the row above is its parent's: ${JSON.stringify(order)}`);

  // Its tab is the chat Crew drives it from, with its report in it.
  await nested.click();
  await crew.window.getByText("Done: tidy the imports").waitFor({ timeout: 10_000 });
  await crew.window.getByText("Turn ended").waitFor({ timeout: 10_000 });
  if (process.env.E2E_SHOTS) await crew.window.screenshot({ path: path.join(process.env.E2E_SHOTS, "session-children.png") });
});
