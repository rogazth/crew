// K1: on a Latin American Mac, ⌘⌥ on the brace keys is a dead key, which
// leaves a focused terminal or field composing. The workspace chord must keep
// switching through that, press after press.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchCrew, newTerminal, waitFor } from "./harness.ts";

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

  const order = crew.workspaces.map((w) => w.id);
  const withTerminal = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const before = (await crew.request<string>("active_workspace_get")) as string;
    if (!withTerminal.has(before)) {
      await newTerminal(crew, before);
      withTerminal.add(before);
    }
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
