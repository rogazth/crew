// A machine's actions go through this Mac's crewd, however the app runs it:
// as its child (dev) or as the LaunchAgent the packaged app installs. 0.1.22
// shipped with the actions reading the child's info only, so under the
// LaunchAgent every one of them said "Crew daemon is not running". The machine
// is a second crewd on loopback; the actions that go on to ssh are asked about
// a machine Crew does not have, so they stop at this Mac's crewd.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteEnv } from "../src/lib/protocol.ts";
import { addRemote, launchCrew, MOD, pressChord, waitFor, type RemoteDaemon } from "./harness.ts";

for (const daemon of ["child", "agent"] as const) {
  test(`with crewd as the app's ${daemon}, a machine is added, answers, and its actions reach this Mac's crewd`, async () => {
    const crew = await launchCrew({ daemon });
    let remote: RemoteDaemon | null = null;
    try {
      remote = await addRemote(crew, "devbox");
      const rows = await crew.request<RemoteEnv[]>("remote_list");
      assert.deepEqual(
        rows.map((row) => row.name),
        ["devbox"],
      );

      // ⌘O lists it, and its heartbeat comes back.
      await pressChord(crew, `${MOD}+o`);
      const machine = crew.window.getByRole("option", { name: /devbox/ });
      await machine.waitFor();
      await waitFor(() => machine.evaluate((row) => /\d+ ms/.test(row.textContent ?? "")), {
        message: "the machine answers its heartbeat",
      });
      await crew.window.keyboard.press("Escape");

      // Each action looks the machine up in this Mac's crewd before anything else.
      const errors = await crew.window.evaluate(async () => {
        const remotes = window.crewHost!.remotes!;
        const reason = (call: Promise<unknown>) =>
          call.then(
            () => "resolved",
            (error: unknown) => (error instanceof Error ? error.message : String(error)),
          );
        return {
          update: await reason(remotes.update("missing")),
          restart: await reason(remotes.restart("missing")),
          logs: await reason(remotes.logs("missing")),
          remove: await reason(remotes.remove("missing", false)),
        };
      });
      for (const [action, message] of Object.entries(errors)) {
        assert.match(message, /That machine is not in Crew/, `${action}: ${message}`);
      }
    } finally {
      await remote?.stop();
      await crew.close();
    }
  });
}
