import { describe, expect, it } from "vitest";
import { createAgentTools, USER_LOCK_MS, type BrowserCall, type Driver, type Page } from "./agent-tools";

type Sent = { method: string; params?: Record<string, unknown> };

/** A page that answers CDP from a table and records what it was sent. */
function fakePage(id: number, answers: Record<string, (params?: Record<string, unknown>) => unknown> = {}) {
  const sent: Sent[] = [];
  const page: Page & { sent: Sent[] } = {
    id,
    sent,
    async send<T>(method: string, params?: Record<string, unknown>) {
      sent.push(params === undefined ? { method } : { method, params });
      const answer = answers[method];
      return (answer ? await answer(params) : {}) as T;
    },
    capture: async () => null,
    url: () => "http://localhost:5173/",
    title: () => "App",
    loadURL: async () => {},
    back: () => true,
    forward: () => true,
    reload: () => {},
    waitForLoad: async () => {},
    navigates: async () => false,
    consoleLog: () => [],
    networkLog: () => [],
  };
  return page;
}

const TREE = {
  nodes: [
    { nodeId: "1", ignored: false, role: { value: "RootWebArea" }, name: { value: "App" }, childIds: ["2", "3"] },
    { nodeId: "2", parentId: "1", ignored: false, role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 20 },
    { nodeId: "3", parentId: "1", ignored: false, role: { value: "combobox" }, name: { value: "Size" }, backendDOMNodeId: 30 },
  ],
};

const BOX = { model: { content: [10, 10, 30, 10, 30, 20, 10, 20] } };

function setup(pages: Record<string, Page>) {
  let now = 1_000_000;
  const driver: Driver = {
    page: async (tab) => {
      const page = pages[tab];
      if (!page) throw new Error(`no ${tab}`);
      return page;
    },
    open: async (tab) => pages[tab]!,
    isMac: true,
    now: () => now,
  };
  const tools = createAgentTools(driver);
  let callId = 0;
  const call = (tab: string, tool: string, args: Record<string, unknown> = {}) =>
    tools.run({ callId: ++callId, tab, tool, args } satisfies BrowserCall);
  return { tools, call, advance: (ms: number) => (now += ms) };
}

const textOf = (content: { type: string; text?: string }[]) => content.map((block) => block.text ?? "").join("\n");

describe("agent tools", () => {
  it("runs one call at a time per tab, and tabs side by side", async () => {
    const log: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = fakePage(1, {
      "Accessibility.getFullAXTree": async () => {
        log.push("a:snapshot:start");
        await gate;
        log.push("a:snapshot:end");
        return TREE;
      },
      "Runtime.evaluate": () => {
        log.push("a:evaluate");
        return { result: { type: "number", value: 2 } };
      },
    });
    const other = fakePage(2, {
      "Runtime.evaluate": () => {
        log.push("b:evaluate");
        return { result: { type: "number", value: 3 } };
      },
    });
    const { call } = setup({ a: slow, b: other });
    const first = call("a", "browser_snapshot");
    const second = call("a", "browser_evaluate", { expression: "1+1" });
    const elsewhere = call("b", "browser_evaluate", { expression: "1+2" });
    await elsewhere;
    // b ran while a's snapshot was still waiting; a's second call has not started.
    expect(log).toEqual(["a:snapshot:start", "b:evaluate"]);
    release();
    await Promise.all([first, second]);
    expect(log).toEqual(["a:snapshot:start", "b:evaluate", "a:snapshot:end", "a:evaluate"]);
  });

  it("a failed call does not stall the tab's queue", async () => {
    const page = fakePage(1, { "Runtime.evaluate": () => ({ result: { type: "number", value: 1 } }) });
    const { call } = setup({ a: page });
    await expect(call("a", "browser_click", { uid: "9_9" })).rejects.toThrow(/older snapshot/);
    await expect(call("a", "browser_evaluate", { expression: "1" })).resolves.toEqual([{ type: "text", text: "1" }]);
  });

  it("clicks the middle of the element a uid names", async () => {
    const page = fakePage(1, { "Accessibility.getFullAXTree": () => TREE, "DOM.getBoxModel": () => BOX });
    const { call } = setup({ a: page });
    const snap = textOf(await call("a", "browser_snapshot"));
    const uid = /uid=(\S+) button/.exec(snap)?.[1];
    expect(uid).toBeDefined();
    const out = textOf(await call("a", "browser_click", { uid }));
    expect(out).toMatch(/^Clicked button "Go"\. Now at/);
    const presses = page.sent.filter((s) => s.method === "Input.dispatchMouseEvent").map((s) => s.params);
    expect(presses).toEqual([
      { type: "mouseMoved", x: 20, y: 15 },
      { type: "mousePressed", x: 20, y: 15, button: "left", clickCount: 1 },
      { type: "mouseReleased", x: 20, y: 15, button: "left", clickCount: 1 },
    ]);
    expect(page.sent.find((s) => s.method === "DOM.scrollIntoViewIfNeeded")?.params).toEqual({ backendNodeId: 20 });
  });

  it("uids die with the next snapshot and with a revived guest", async () => {
    const page = fakePage(1, { "Accessibility.getFullAXTree": () => TREE, "DOM.getBoxModel": () => BOX });
    const revived = fakePage(2, { "Accessibility.getFullAXTree": () => TREE, "DOM.getBoxModel": () => BOX });
    const pages: Record<string, Page> = { a: page };
    const { call } = setup(pages);
    const old = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    await call("a", "browser_snapshot");
    await expect(call("a", "browser_click", { uid: old })).rejects.toThrow("Take a new snapshot");
    const fresh = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    pages.a = revived;
    await expect(call("a", "browser_click", { uid: fresh })).rejects.toThrow("older snapshot");
  });

  it("the user's input holds off input tools for a moment, not reading", async () => {
    const page = fakePage(7, {
      "Accessibility.getFullAXTree": () => TREE,
      "DOM.getBoxModel": () => BOX,
    });
    const { tools, call, advance } = setup({ a: page });
    const uid = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    tools.noteUserInput(7);
    await expect(call("a", "browser_click", { uid })).rejects.toThrow(/The user is using this tab/);
    await expect(call("a", "browser_press", { key: "Enter" })).rejects.toThrow(/The user is using this tab/);
    await expect(call("a", "browser_snapshot")).resolves.toBeDefined();
    advance(USER_LOCK_MS);
    const again = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    await expect(call("a", "browser_click", { uid: again })).resolves.toBeDefined();
  });

  it("our own input echoing back is not the user", async () => {
    const page = fakePage(7, {
      "Accessibility.getFullAXTree": () => TREE,
      "DOM.getBoxModel": () => BOX,
      "Input.dispatchMouseEvent": () => tools.noteUserInput(7),
    });
    const { tools, call } = setup({ a: page });
    const uid = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    await call("a", "browser_click", { uid });
    const next = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    await expect(call("a", "browser_click", { uid: next })).resolves.toBeDefined();
  });

  it("fills a select by choosing its option, and says which ones there are when it misses", async () => {
    let wanted = "";
    const page = fakePage(1, {
      "Accessibility.getFullAXTree": () => TREE,
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
      "Runtime.callFunctionOn": (params) => {
        wanted = String((params?.arguments as { value: string }[] | undefined)?.[0]?.value ?? "");
        return { result: { value: wanted === "L" ? { chose: "L" } : { missing: ["S", "L"] } } };
      },
    });
    const { call } = setup({ a: page });
    const uid = /uid=(\S+) combobox/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    expect(textOf(await call("a", "browser_fill", { uid, value: "L" }))).toBe('Chose "L" in combobox "Size".');
    await expect(call("a", "browser_fill", { uid, value: "XL" })).rejects.toThrow('has no option "XL". It has: S, L.');
    // Nothing was typed into a select.
    expect(page.sent.some((s) => s.method === "Input.insertText")).toBe(false);
  });

  it("fills a text field by focusing it and writing over what is there, in the page", async () => {
    let calls = 0;
    const page = fakePage(1, {
      "Accessibility.getFullAXTree": () => TREE,
      "DOM.resolveNode": () => ({ object: { objectId: "obj-1" } }),
      // Not a select; then the field reads back what was written, or not.
      "Runtime.callFunctionOn": () => ({ result: { value: ++calls === 2 ? "hello" : calls === 4 ? "12" : null } }),
    });
    const { call } = setup({ a: page });
    const uid = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    expect(textOf(await call("a", "browser_fill", { uid, value: "hello" }))).toBe('Filled button "Go" with "hello".');
    const methods = page.sent.map((s) => s.method);
    expect(methods.slice(methods.indexOf("DOM.focus"))).toEqual(["DOM.focus", "Runtime.callFunctionOn"]);
    // A field that will not take the value says so.
    await expect(call("a", "browser_fill", { uid, value: "abc" })).rejects.toThrow('button "Go" kept "12"');
  });

  it("plays keys inside the page, never through the window's keyboard", async () => {
    const page = fakePage(1, { "Runtime.evaluate": () => ({ result: { value: "submitted the form" } }) });
    const { call } = setup({ a: page });
    expect(textOf(await call("a", "browser_press", { key: "Enter" }))).toMatch(/^Pressed Enter \(submitted the form\)\./);
    await call("a", "browser_type", { text: "hi" });
    expect(page.sent.some((s) => s.method.startsWith("Input."))).toBe(false);
    const played = page.sent.map((s) => String(s.params?.expression ?? ""));
    expect(played[0]).toContain('"key":"Enter"');
    expect(played[1]).toContain('"text":"h"');
    await expect(call("a", "browser_press", { key: "Hyper+Q" })).rejects.toThrow(/not a modifier/);
  });

  it("an element gone from the page asks for a new snapshot", async () => {
    const page = fakePage(1, {
      "Accessibility.getFullAXTree": () => TREE,
      "DOM.scrollIntoViewIfNeeded": () => {
        throw new Error("No node with given id found");
      },
    });
    const { call } = setup({ a: page });
    const uid = /uid=(\S+) button/.exec(textOf(await call("a", "browser_snapshot")))?.[1];
    await expect(call("a", "browser_click", { uid })).rejects.toThrow('button "Go" is no longer in the page. Take a new snapshot.');
  });

  it("evaluates to JSON, and a thrown error comes back as the error", async () => {
    const page = fakePage(1, {
      "Runtime.evaluate": (params) =>
        params?.expression === "boom()"
          ? { result: { type: "object" }, exceptionDetails: { text: "Uncaught", exception: { description: "ReferenceError: boom is not defined" } } }
          : { result: { type: "object", value: { a: [1] } } },
    });
    const { call } = setup({ a: page });
    expect(textOf(await call("a", "browser_evaluate", { expression: "({a:[1]})" }))).toBe('{\n  "a": [\n    1\n  ]\n}');
    await expect(call("a", "browser_evaluate", { expression: "boom()" })).rejects.toThrow("ReferenceError: boom is not defined");
  });

  it("a screenshot is an image block", async () => {
    const page = fakePage(1, { "Page.captureScreenshot": () => ({ data: "iVBOR" }) });
    const { call } = setup({ a: page });
    expect(await call("a", "browser_screenshot")).toEqual([{ type: "image", data: "iVBOR", mimeType: "image/png" }]);
  });

  it("a page nobody draws falls back to the last frame, or says why there is none", async () => {
    const stuck = () => {
      throw new Error("Page.captureScreenshot timed out");
    };
    const drawn = { ...fakePage(1, { "Page.captureScreenshot": stuck }), capture: async () => "LAST" };
    const blank = fakePage(2, { "Page.captureScreenshot": stuck });
    const { call } = setup({ a: drawn, b: blank });
    expect(await call("a", "browser_screenshot")).toEqual([{ type: "image", data: "LAST", mimeType: "image/png" }]);
    await expect(call("b", "browser_screenshot")).rejects.toThrow(/not being drawn right now/);
  });
});
