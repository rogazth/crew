// K1: on a Latin American Mac, ⌘⌥ on the brace keys is a dead key, which
// leaves a focused terminal or field composing. The workspace chord must keep
// switching through that, press after press.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Workspace } from "../src/lib/types.ts";
import { launchCrew, MOD, openShell, pressChord, waitFor } from "./harness.ts";

test("K1: ⌘⌥ dead-key chord switches workspaces repeatedly while a terminal is composing", async (t) => {
  const crew = await launchCrew({ repos: ["app", "lib", "web"] });
  t.after(() => crew.close());
  const page = crew.window;
  const cdp = await page.context().newCDPSession(page);
  await page.evaluate(() => {
    (window as unknown as { seen: boolean[] }).seen = [];
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.metaKey && e.altKey) (window as unknown as { seen: boolean[] }).seen.push(e.isComposing);
      },
      true,
    );
  });

  // The chord walks the rail top to bottom: home first, then the projects.
  const home = (await crew.request<Workspace[]>("workspace_list")).find((w) => w.home);
  assert.ok(home, "home was never made");
  const order = [home.id, ...crew.workspaces.map((w) => w.id)];
  // A shell in each workspace first, while the field is clean: an open
  // composition would eat the launcher's Enter.
  for (const key of ["1", "2", "3"]) {
    await pressChord(crew, `${MOD}+${key}`);
    // The workspace restores its tabs as it opens: a tab opened before that is lost.
    await page.waitForTimeout(800);
    await openShell(crew);
  }
  await pressChord(crew, `${MOD}+Shift+H`);
  await page.waitForTimeout(800);
  await openShell(crew);
  assert.equal(await crew.request("active_workspace_get"), home.id, "home is where the chord starts");
  for (let i = 0; i < 6; i++) {
    const before = (await crew.request<string>("active_workspace_get")) as string;
    await waitFor(
      () =>
        page.evaluate(() => {
          const area = [...document.querySelectorAll<HTMLTextAreaElement>(".xterm-helper-textarea")].find(
            (a) => a.closest("[hidden]") === null && a.getClientRects().length > 0,
          );
          area?.focus();
          return area !== undefined && document.activeElement === area;
        }),
      { message: "a terminal on screen has focus" },
    );
    // The dead key's marked text, as macOS leaves it in the focused field.
    await cdp.send("Input.imeSetComposition", { text: "´", selectionStart: 1, selectionEnd: 1 });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      modifiers: 1 | 4,
      key: i % 2 ? "Process" : "Dead",
      code: "Backslash",
      windowsVirtualKeyCode: 220,
    });
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 1 | 4, key: "Dead", code: "Backslash", windowsVirtualKeyCode: 220 });
    const want = order[(order.indexOf(before) + 1) % order.length];
    await waitFor(async () => (await crew.request("active_workspace_get")) === want, {
      message: `press ${i + 1}: next workspace`,
    });
  }
  const seen = await page.evaluate(() => (window as unknown as { seen: boolean[] }).seen);
  assert.ok(seen.some(Boolean), "the chord arrived while composing");
});
