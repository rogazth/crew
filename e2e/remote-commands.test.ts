// A command of a workspace on another machine: its run's terminal is named
// for the command alone, and the window has to reach that machine to watch it.
// The program asks the terminal who it is; only a view that gets its output
// answers, and only a view that writes to its machine is heard.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Process } from "../src/lib/protocol.ts";
import type { Workspace } from "../src/lib/types.ts";
import { addRemote, launchCrew, MOD, pressChord, remoteRequest, waitFor, type RemoteDaemon } from "./harness.ts";

const ASK = String.raw`
process.stdin.setRawMode(true);
process.stdin.once("data", (reply) => require("fs").writeFileSync("heard.txt", JSON.stringify(String(reply))));
process.stdout.write("asking\r\n\x1b[c");
setInterval(() => {}, 1000);
`;

test("a command on another machine shows its output and hears the terminal while it runs", async () => {
  const crew = await launchCrew();
  let remote: RemoteDaemon | null = null;
  try {
    remote = await addRemote(crew, "devbox");
    const api = await crew.makeRepo("api");
    await writeFile(path.join(api, "ask.cjs"), ASK);
    const window = crew.window;

    await pressChord(crew, `${MOD}+o`);
    const machine = window.getByRole("option", { name: /devbox/ });
    await machine.waitFor();
    await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), { message: "the machine answers" });
    await window.keyboard.press(`${MOD}+2`);
    const field = window.getByLabel("Folder on devbox");
    await field.waitFor();
    await field.fill(`${api}/`);
    await window.keyboard.press(`${MOD}+Enter`);
    await window.locator(`nav[aria-label="Workspaces"][data-sidebar-rail] button[data-nav][aria-label="api"]`).waitFor();
    const [workspace] = await remoteRequest<Workspace[]>(remote, "workspace_list");
    assert.ok(workspace);

    const ask = await remoteRequest<Process>(remote, "process_create", { workspaceId: workspace.id, name: "ask", command: "node ask.cjs" });
    await remoteRequest(remote, "process_start", { workspaceId: workspace.id, id: ask.id });

    await window.locator("[data-sidebar-panel]").getByRole("button", { name: /^Commands: 1 running/ }).click();
    await window.getByRole("region", { name: "ask" }).getByRole("button", { name: /^Logs of ask/ }).click();

    const heard = await waitFor(() => readFile(path.join(api, "heard.txt"), "utf8").catch(() => null), {
      message: "the terminal answers the command on its machine",
      timeout: 15_000,
    });
    assert.match(JSON.parse(heard) as string, /^\x1b\[\?[\d;]+c$/);
  } finally {
    await remote?.stop();
    await crew.close();
  }
});
