/**
 * The browser tools, run in main where the pages live. crewd has already
 * decided the caller may drive this tab and holds the lease; what is left is
 * doing it: find the tab's current guest (mounting it when cold), talk CDP to
 * it, and answer with MCP content blocks.
 *
 * Calls on one tab run one at a time, so a click never lands in the middle of
 * the snapshot it was chosen from. Calls on different tabs run side by side.
 *
 * Electron stays out of this file: a `Page` is whatever can send CDP and
 * steer a guest, so the rules here are tested against a fake.
 */

import { formatAxTree, parseUid, type AXNode, type UidTarget } from "./ax-snapshot";
import { parseChord, STROKES_SCRIPT, typingStrokes, type Stroke } from "./press";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type PageRef = { context: string; url: string; title: string };

export type BrowserCall = {
  callId: number;
  tab: string;
  tool: string;
  args: Record<string, unknown>;
  page?: PageRef;
};

/** One live guest, as the tools need it. */
export interface Page {
  /** Its webContents id: a revived tab gets a new one, and its uids die with the old. */
  readonly id: number;
  /** Rejects with "<method> timed out" past `timeoutMs`, so one stuck command never wedges the tab. */
  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** What the guest last drew, as base64 PNG, through Electron rather than CDP; null when it has nothing. */
  capture(): Promise<string | null>;
  url(): string;
  title(): string;
  loadURL(url: string): Promise<void>;
  back(): boolean;
  forward(): boolean;
  reload(): void;
  /** Resolves once the page stops loading, or at the timeout. */
  waitForLoad(timeoutMs: number): Promise<void>;
  /** Whether a main-frame navigation starts within `ms`. */
  navigates(ms: number): Promise<boolean>;
  /** Console lines and requests seen since the debugger attached. */
  consoleLog(): readonly string[];
  networkLog(): readonly string[];
}

export type Driver = {
  /** The tab's live page, mounting the tab first when it is cold or its workspace is not open. */
  page(tab: string, ref: PageRef | undefined): Promise<Page>;
  /** Adds a new tab to the window and resolves with its page once it attaches. */
  open(tab: string, ref: PageRef): Promise<Page>;
  isMac: boolean;
  now(): number;
};

/** Input tools wait this long after the user clicked or typed in the tab. */
export const USER_LOCK_MS = 3000;
/** Our own synthetic input echoes back as input events; these are not the user. */
const ECHO_MS = 150;
const LOAD_WAIT_MS = 30_000;
/** A click that starts a navigation is answered once the new page has loaded, up to this. */
const SETTLE_MS = 10_000;
const EVAL_MAX = 20_000;
const FULL_PAGE_MAX = 16_384;
/** A guest that is not being drawn never answers a screenshot; this long is enough for one that is. */
const SCREENSHOT_MS = 8000;

const INPUT_TOOLS = new Set(["browser_click", "browser_hover", "browser_fill", "browser_type", "browser_press"]);

type TabState = { pageId: number; snapshot: number; uids: Map<string, UidTarget> };

const text = (body: string): Content[] => [{ type: "text", text: body }];

function str(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  return typeof value === "string" ? value : "";
}

/** CDP's own words for a node that went away, turned into what to do about it. */
function nodeError(error: unknown, label: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/No node|Could not find node|does not belong|not found/i.test(message)) {
    return new Error(`${label} is no longer in the page. Take a new snapshot.`);
  }
  if (/box model/i.test(message)) {
    return new Error(`${label} is not visible, so it cannot be clicked. Take a new snapshot, or scroll to it.`);
  }
  return new Error(message);
}

export function createAgentTools(driver: Driver) {
  const queues = new Map<string, Promise<unknown>>();
  const tabs = new Map<string, TabState>();
  const userInput = new Map<number, number>();
  const driving = new Map<number, number>();
  let snapshots = 0;

  /** Chains `work` after whatever this tab is already doing. */
  function serialize<T>(tab: string, work: () => Promise<T>): Promise<T> {
    const before = queues.get(tab) ?? Promise.resolve();
    const run = before.catch(() => {}).then(work);
    const tail = run.catch(() => {});
    queues.set(tab, tail);
    void tail.then(() => {
      if (queues.get(tab) === tail) queues.delete(tab);
    });
    return run;
  }

  /** The user clicked or typed in this guest: input tools stand back for a moment. */
  function noteUserInput(webContentsId: number): void {
    const now = driver.now();
    if ((driving.get(webContentsId) ?? 0) > now) return;
    userInput.set(webContentsId, now + USER_LOCK_MS);
  }

  function checkLock(page: Page): void {
    const until = userInput.get(page.id) ?? 0;
    const left = until - driver.now();
    if (left > 0) {
      throw new Error(
        `The user is using this tab. Input tools wait ~${Math.ceil(left / 1000)} s after they stop; reading (snapshot, screenshot) still works.`,
      );
    }
  }

  /** Marks our own input, so its echo is not taken for the user's. */
  async function drive<T>(page: Page, work: () => Promise<T>): Promise<T> {
    driving.set(page.id, Number.POSITIVE_INFINITY);
    try {
      return await work();
    } finally {
      driving.set(page.id, driver.now() + ECHO_MS);
    }
  }

  function target(tab: string, page: Page, uid: string): UidTarget {
    const state = tabs.get(tab);
    const parsed = parseUid(uid);
    if (!uid.trim()) throw new Error("uid is required: take a browser_snapshot and pass one of its uids.");
    if (!parsed) throw new Error(`"${uid}" is not a uid. They look like 3_12 and come from browser_snapshot.`);
    if (!state || state.pageId !== page.id || parsed.snapshot !== state.snapshot) {
      throw new Error(`uid ${uid} is from an older snapshot of this tab. Take a new snapshot.`);
    }
    const found = state.uids.get(uid.trim());
    if (!found) throw new Error(`There is no uid ${uid} in the last snapshot. Take a new snapshot.`);
    return found;
  }

  async function center(page: Page, node: UidTarget): Promise<{ x: number; y: number }> {
    try {
      await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node.backendNodeId });
      const { model } = await page.send<{ model: { content: number[] } }>("DOM.getBoxModel", {
        backendNodeId: node.backendNodeId,
      });
      const q = model.content;
      const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
      const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
      return { x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 };
    } catch (error) {
      throw nodeError(error, node.label);
    }
  }

  /** Plays keys inside the page; see press.ts for why not CDP's key events. */
  async function strokes(page: Page, list: Stroke[]): Promise<string> {
    const out = await page.send<{ result: { value?: unknown }; exceptionDetails?: { text: string } }>("Runtime.evaluate", {
      expression: `(${STROKES_SCRIPT})(${JSON.stringify(list)})`,
      returnByValue: true,
      userGesture: true,
    });
    if (out.exceptionDetails) throw new Error(`The page refused the keys: ${out.exceptionDetails.text}`);
    return typeof out.result.value === "string" ? out.result.value : "";
  }

  /** Where the page stands after an action that may have navigated it. */
  async function settle(page: Page): Promise<string> {
    if (await page.navigates(200)) await page.waitForLoad(SETTLE_MS);
    return `Now at ${page.url()}`;
  }

  async function snapshot(tab: string, page: Page): Promise<Content[]> {
    const { nodes } = await page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
    snapshots += 1;
    const { text: body, uids } = formatAxTree(nodes, snapshots);
    tabs.set(tab, { pageId: page.id, snapshot: snapshots, uids });
    return text(body || "The page is empty.");
  }

  async function click(tab: string, page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const node = target(tab, page, str(args, "uid"));
    const at = await center(page, node);
    await drive(page, async () => {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at });
      await page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at, button: "left", clickCount: 1 });
      await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at, button: "left", clickCount: 1 });
    });
    return text(`Clicked ${node.label}. ${await settle(page)}`);
  }

  async function hover(tab: string, page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const node = target(tab, page, str(args, "uid"));
    const at = await center(page, node);
    await drive(page, () => page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at }));
    return text(`Hovering over ${node.label}.`);
  }

  async function fill(tab: string, page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const node = target(tab, page, str(args, "uid"));
    const value = typeof args.value === "string" ? args.value : String(args.value ?? "");
    let objectId: string;
    try {
      const resolved = await page.send<{ object: { objectId: string } }>("DOM.resolveNode", {
        backendNodeId: node.backendNodeId,
      });
      objectId = resolved.object.objectId;
    } catch (error) {
      throw nodeError(error, node.label);
    }
    // A select has no text to type into: pick the option by its label or value, as a person would.
    const picked = await page.send<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      arguments: [{ value }],
      functionDeclaration: `function (wanted) {
        if (!(this instanceof HTMLSelectElement)) return null;
        const option = [...this.options].find((o) => o.label === wanted || o.value === wanted || o.text.trim() === wanted.trim());
        if (!option) return { missing: [...this.options].map((o) => o.label) };
        this.value = option.value;
        this.dispatchEvent(new Event("input", { bubbles: true }));
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return { chose: option.label };
      }`,
    });
    const outcome = picked.result.value as { missing?: string[]; chose?: string } | null;
    if (outcome?.missing) throw new Error(`${node.label} has no option "${value}". It has: ${outcome.missing.join(", ")}.`);
    if (outcome?.chose !== undefined) return text(`Chose "${outcome.chose}" in ${node.label}.`);

    try {
      await page.send("DOM.focus", { backendNodeId: node.backendNodeId });
    } catch (error) {
      throw nodeError(error, node.label);
    }
    // Select what is there and type over it, the way editing does, so the page
    // hears the input events it would from a person. A field the editing
    // commands cannot write (a date, a number) gets its value set directly,
    // through the element's own setter, which frameworks watch.
    const filled = await page.send<{ result: { value?: unknown } }>("Runtime.callFunctionOn", {
      objectId,
      returnByValue: true,
      userGesture: true,
      arguments: [{ value }],
      functionDeclaration: `function (value) {
        const rich = this.isContentEditable;
        if (typeof this.select === "function") this.select();
        else {
          const range = document.createRange();
          range.selectNodeContents(this);
          getSelection().removeAllRanges();
          getSelection().addRange(range);
        }
        if (value) document.execCommand("insertText", false, value);
        else document.execCommand("delete");
        const read = () => (rich ? this.textContent : this.value);
        if (read() !== value) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set;
          if (rich) this.textContent = value;
          else if (setter) setter.call(this, value);
          else this.value = value;
          this.dispatchEvent(new Event("input", { bubbles: true }));
        }
        this.dispatchEvent(new Event("change", { bubbles: true }));
        return read();
      }`,
    });
    if (typeof filled.result.value === "string" && filled.result.value !== value) {
      throw new Error(`${node.label} kept "${filled.result.value}"; it may not accept "${value}".`);
    }
    return text(`Filled ${node.label} with "${value}".`);
  }

  async function typeText(page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const typed = str(args, "text");
    if (!typed) throw new Error("text is required.");
    const did = await strokes(page, typingStrokes(typed));
    return text(`Typed ${typed.length} characters${did ? `; the last one ${did}` : ""}.`);
  }

  async function press(page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const chord = str(args, "key");
    const did = await strokes(page, [parseChord(chord, driver.isMac)]);
    return text(`Pressed ${chord}${did ? ` (${did})` : ""}. ${await settle(page)}`);
  }

  async function screenshot(page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const params: Record<string, unknown> = { format: "png" };
    if (args.full_page === true) {
      const metrics = await page.send<{ cssContentSize: { width: number; height: number } }>("Page.getLayoutMetrics");
      const { width, height } = metrics.cssContentSize;
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: Math.ceil(width), height: Math.min(Math.ceil(height), FULL_PAGE_MAX), scale: 1 };
    }
    try {
      const { data } = await page.send<{ data: string }>("Page.captureScreenshot", params, SCREENSHOT_MS);
      return [{ type: "image", data, mimeType: "image/png" }];
    } catch (error) {
      if (!(error instanceof Error && /timed out/.test(error.message))) throw error;
    }
    // CDP waits for a new frame, which a page nobody is drawing never makes; the last one drawn may still be there.
    const data = await page.capture();
    if (data) return [{ type: "image", data, mimeType: "image/png" }];
    throw new Error(
      "The tab is not being drawn right now (Crew's window is hidden or minimized, or a page like Settings covers the tabs), so there is nothing to capture. browser_snapshot still reads it.",
    );
  }

  async function waitFor(page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const wanted = str(args, "text");
    const seconds = typeof args.timeout_s === "number" ? args.timeout_s : 10;
    const deadline = driver.now() + seconds * 1000;
    for (;;) {
      const { result } = await page.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression: "document.body ? document.body.innerText : ''",
        returnByValue: true,
      });
      if (typeof result.value === "string" && result.value.includes(wanted)) return text(`"${wanted}" is on the page.`);
      if (driver.now() >= deadline) throw new Error(`"${wanted}" did not appear within ${seconds} s.`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  async function evaluate(page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const expression = str(args, "expression");
    if (!expression.trim()) throw new Error("expression is required.");
    const out = await page.send<{
      result: { type: string; value?: unknown; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (out.exceptionDetails) {
      throw new Error(out.exceptionDetails.exception?.description ?? out.exceptionDetails.text);
    }
    const { result } = out;
    const body =
      result.type === "undefined"
        ? "undefined"
        : "value" in result
          ? JSON.stringify(result.value, null, 2) ?? String(result.value)
          : (result.description ?? result.type);
    return text(body.length > EVAL_MAX ? `${body.slice(0, EVAL_MAX)}\n… cut at ${EVAL_MAX} characters.` : body);
  }

  async function navigate(page: Page, args: Record<string, unknown>): Promise<Content[]> {
    const url = str(args, "url");
    const action = str(args, "action");
    if (url) {
      // A failure arrives as the rejection; its message is Chromium's error name.
      await page.loadURL(url).catch((error: unknown) => {
        throw new Error(`Could not load ${url}: ${error instanceof Error ? error.message : String(error)}`);
      });
    } else if (action === "back" || action === "forward") {
      const moved = action === "back" ? page.back() : page.forward();
      if (!moved) return text(`There is no page to go ${action} to. Still at ${page.url()}`);
      await page.navigates(500);
    } else if (action === "reload") {
      page.reload();
      await page.navigates(500);
    } else {
      throw new Error("Give a url, or an action: back, forward or reload.");
    }
    await page.waitForLoad(LOAD_WAIT_MS);
    return text(`Now at ${page.url()} — "${page.title()}"`);
  }

  async function perform(call: BrowserCall): Promise<Content[]> {
    const { tab, tool, args } = call;
    if (tool === "open_tab") {
      const url = str(args, "url");
      const page = await driver.open(tab, call.page ?? { context: "", url, title: "" });
      await page.waitForLoad(LOAD_WAIT_MS);
      return text(`Opened ${tab} at ${page.url()} — "${page.title()}". It is yours; browser_snapshot reads it.`);
    }
    const page = await driver.page(tab, call.page);
    if (INPUT_TOOLS.has(tool)) checkLock(page);
    switch (tool) {
      case "claim_tab":
        return text(`${tab} is yours: "${page.title()}" at ${page.url()}.`);
      case "browser_navigate":
        return navigate(page, args);
      case "browser_snapshot":
        return snapshot(tab, page);
      case "browser_click":
        return click(tab, page, args);
      case "browser_hover":
        return hover(tab, page, args);
      case "browser_fill":
        return fill(tab, page, args);
      case "browser_type":
        return typeText(page, args);
      case "browser_press":
        return press(page, args);
      case "browser_screenshot":
        return screenshot(page, args);
      case "browser_wait_for":
        return waitFor(page, args);
      case "browser_console": {
        const lines = page.consoleLog();
        return text(lines.length ? lines.join("\n") : "Nothing in the console since you started driving this tab.");
      }
      case "browser_network": {
        const lines = page.networkLog();
        return text(lines.length ? lines.join("\n") : "No requests since you started driving this tab.");
      }
      case "browser_evaluate":
        return evaluate(page, args);
      default:
        throw new Error(`Unknown browser tool "${tool}".`);
    }
  }

  return {
    run: (call: BrowserCall) => serialize(call.tab, () => perform(call)),
    noteUserInput,
    /** A tab nobody drives any more: its uids go, so a later driver starts from a fresh snapshot. */
    forgetTab: (tab: string) => void tabs.delete(tab),
  };
}

export type AgentTools = ReturnType<typeof createAgentTools>;
