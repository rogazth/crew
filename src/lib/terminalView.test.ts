// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANSI_DARK, ANSI_LIGHT } from "./terminalColors";
import {
  ACK_FLUSH_MS,
  activityDue,
  applyTerminalKey,
  createAckFlow,
  cssColor,
  exitBanner,
  gridSettled,
  isOsc777Notification,
  isOsc9Notification,
  kittyParam,
  MAX_STABILITY_FRAMES,
  palette,
  pastePayload,
  proposeGrid,
  sizeStep,
  spawnErrorLine,
} from "./terminalView";

afterEach(() => {
  vi.useRealTimers();
});

describe("cssColor", () => {
  it("resolves a colour against the page as hex", () => {
    expect(cssColor("rgb(10, 20, 30)", "#ffffff")).toBe("#0a141e");
  });

  it("falls back when the page resolves nothing", () => {
    expect(cssColor("", "#123456")).toBe("#123456");
    expect(cssColor("var(--color-missing)", "#654321")).toBe("#654321");
  });

  it("leaves no probe behind", () => {
    const before = document.body.childElementCount;
    cssColor("rgb(1, 2, 3)", "#000000");
    expect(document.body.childElementCount).toBe(before);
  });
});

describe("palette", () => {
  const echo = (expr: string, fallback: string) => `${expr}|${fallback}`;

  it("takes the canvas and text colours, with light fallbacks and ANSI", () => {
    const colors = palette(false, echo);
    expect(colors.background).toBe("var(--color-canvas)|#ffffff");
    expect(colors.foreground).toBe("var(--color-text)|#2e2e2e");
    expect(colors.cursorAccent).toBe(colors.background);
    expect(colors.selectionBackground).toBe("rgba(0,0,0,0.16)");
    expect(colors.selectionInactiveBackground).toBe("rgba(0,0,0,0.07)");
    expect(colors).toMatchObject(ANSI_LIGHT);
  });

  it("uses dark fallbacks and the dark ANSI set in dark mode", () => {
    const colors = palette(true, echo);
    expect(colors.background).toBe("var(--color-canvas)|#1a1a1a");
    expect(colors.foreground).toBe("var(--color-text)|#e8eef2");
    expect(colors.selectionBackground).toBe("rgba(255,255,255,0.22)");
    expect(colors.selectionInactiveBackground).toBe("rgba(255,255,255,0.1)");
    expect(colors).toMatchObject(ANSI_DARK);
  });

  it("falls back to the foreground for the cursor", () => {
    const colors = palette(false, (expr, fallback) => (expr === "var(--color-accent)" ? fallback : "#abcdef"));
    expect(colors.cursor).toBe("#abcdef");
  });

  it("reads the page's theme variables by default", () => {
    const theme = document.createElement("style");
    theme.textContent = ":root { --color-canvas: rgb(1, 2, 3); --color-accent: rgb(7, 8, 9); }";
    document.head.appendChild(theme);
    try {
      const colors = palette(true);
      expect(colors.background).toBe("#010203");
      expect(colors.foreground).toBe("#e8eef2");
      expect(colors.cursor).toBe("#070809");
    } finally {
      theme.remove();
    }
  });
});

describe("exit and spawn lines", () => {
  it("names the exit code when there is one", () => {
    expect(exitBanner(3)).toBe("\r\n\x1b[2m[process exited (3)]\x1b[0m");
    expect(exitBanner(0)).toBe("\r\n\x1b[2m[process exited (0)]\x1b[0m");
    expect(exitBanner(null)).toBe("\r\n\x1b[2m[process exited]\x1b[0m");
  });

  it("prints an error's message, or the value itself", () => {
    expect(spawnErrorLine(new Error("no such shell"))).toBe("\x1b[31mno such shell\x1b[0m");
    expect(spawnErrorLine("denied")).toBe("\x1b[31mdenied\x1b[0m");
  });
});

describe("escape sequences", () => {
  it("reads the kitty flags from the first plain parameter", () => {
    expect(kittyParam([5])).toBe(5);
    expect(kittyParam([[1, 2]])).toBe(0);
    expect(kittyParam([])).toBe(0);
  });

  it("treats OSC 9 as a notification unless it is progress", () => {
    expect(isOsc9Notification("Build finished")).toBe(true);
    expect(isOsc9Notification("4;1;50")).toBe(false);
  });

  it("treats only OSC 777 notify as a notification", () => {
    expect(isOsc777Notification("notify;Done;body")).toBe(true);
    expect(isOsc777Notification("preexec")).toBe(false);
  });
});

describe("activityDue", () => {
  it("reports output only once per interval", () => {
    expect(activityDue(1000, 0)).toBe(true);
    expect(activityDue(1399, 1000)).toBe(false);
    expect(activityDue(1400, 1000)).toBe(true);
  });
});

describe("grid sizing", () => {
  it("proposes nothing when the fit addon cannot measure", () => {
    expect(proposeGrid({ proposeDimensions: () => ({ cols: 80, rows: 24 }) })).toEqual({ cols: 80, rows: 24 });
    expect(proposeGrid({ proposeDimensions: () => undefined })).toBeNull();
    expect(
      proposeGrid({
        proposeDimensions: () => {
          throw new Error("no renderer");
        },
      }),
    ).toBeNull();
  });

  const current = { cols: 80, rows: 24 };

  it("settles when there is nothing to propose or it already matches", () => {
    expect(gridSettled(null, current, null, 1)).toBe(true);
    expect(gridSettled({ cols: 80, rows: 24 }, current, null, 1)).toBe(true);
  });

  it("settles once two frames agree", () => {
    expect(gridSettled({ cols: 100, rows: 30 }, current, { cols: 100, rows: 30 }, 1)).toBe(true);
    expect(gridSettled({ cols: 100, rows: 30 }, current, { cols: 100, rows: 31 }, 1)).toBe(false);
    expect(gridSettled({ cols: 100, rows: 30 }, current, { cols: 99, rows: 30 }, 1)).toBe(false);
    expect(gridSettled({ cols: 100, rows: 30 }, current, null, 1)).toBe(false);
  });

  it("gives up waiting after the frame budget", () => {
    expect(gridSettled({ cols: 100, rows: 30 }, current, { cols: 90, rows: 30 }, MAX_STABILITY_FRAMES - 1)).toBe(false);
    expect(gridSettled({ cols: 100, rows: 30 }, current, { cols: 90, rows: 30 }, MAX_STABILITY_FRAMES)).toBe(true);
  });

  it("spawns on the first measurement even when it repeats, then resizes only on change", () => {
    expect(sizeStep(null, { cols: 80, rows: 24 })).toBe("spawn");
    expect(sizeStep({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe("same");
    expect(sizeStep({ cols: 80, rows: 24 }, { cols: 81, rows: 24 })).toBe("resize");
    expect(sizeStep({ cols: 80, rows: 24 }, { cols: 80, rows: 25 })).toBe("resize");
  });
});

describe("applyTerminalKey", () => {
  function setup() {
    const term = { selectAll: vi.fn(), scrollToTop: vi.fn(), scrollToBottom: vi.fn() };
    const event = { preventDefault: vi.fn() };
    const write = vi.fn();
    return { term, event, write };
  }

  it("leaves xterm's keys to xterm and lets app chords bubble", () => {
    const { term, event, write } = setup();
    expect(applyTerminalKey({ type: "xterm" }, term, event, write)).toBe(true);
    expect(applyTerminalKey({ type: "app" }, term, event, write)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("selects all", () => {
    const { term, event, write } = setup();
    expect(applyTerminalKey({ type: "select-all" }, term, event, write)).toBe(false);
    expect(term.selectAll).toHaveBeenCalledOnce();
  });

  it("scrolls to either end", () => {
    const { term, event, write } = setup();
    applyTerminalKey({ type: "scroll", to: "top" }, term, event, write);
    expect(term.scrollToTop).toHaveBeenCalledOnce();
    expect(term.scrollToBottom).not.toHaveBeenCalled();
    applyTerminalKey({ type: "scroll", to: "bottom" }, term, event, write);
    expect(term.scrollToBottom).toHaveBeenCalledOnce();
  });

  it("writes spelled-out input and keeps the browser from acting on the key", () => {
    const { term, event, write } = setup();
    expect(applyTerminalKey({ type: "input", data: "\x15" }, term, event, write)).toBe(false);
    expect(write).toHaveBeenCalledWith("\x15");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("pastePayload", () => {
  const file = (type: string) => ({ type, name: "x" }) as File;
  const clipboard = (text: string, files: File[] = []) => ({ getData: () => text, files });

  it("prefers text", () => {
    expect(pastePayload(clipboard("ls -la", [file("image/png")]))).toEqual({ kind: "text", text: "ls -la" });
  });

  it("takes the first image when there is no text", () => {
    const png = file("image/png");
    expect(pastePayload(clipboard("", [file("application/pdf"), png, file("image/jpeg")]))).toEqual({
      kind: "image",
      file: png,
    });
  });

  it("has nothing to paste without text or an image", () => {
    expect(pastePayload(clipboard("", [file("application/pdf")]))).toBeNull();
    expect(pastePayload(null)).toBeNull();
    expect(pastePayload(undefined)).toBeNull();
  });
});

describe("createAckFlow", () => {
  it("batches parsed chunks into one ack after the flush delay", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const flow = createAckFlow(send);
    flow.parsed(10);
    flow.parsed(5);
    vi.advanceTimersByTime(ACK_FLUSH_MS - 1);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledExactlyOnceWith(15);
  });

  it("arms a new flush once the last one went out, with the running total", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const flow = createAckFlow(send, 10);
    flow.parsed(4);
    vi.advanceTimersByTime(10);
    flow.parsed(6);
    vi.advanceTimersByTime(10);
    expect(send.mock.calls).toEqual([[4], [10]]);
  });

  it("counts from where a reattach starts", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const flow = createAckFlow(send);
    flow.parsed(100);
    flow.reset(2048);
    flow.parsed(2);
    vi.advanceTimersByTime(ACK_FLUSH_MS);
    expect(send).toHaveBeenCalledExactlyOnceWith(2050);
  });

  it("sends nothing once cancelled", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const flow = createAckFlow(send);
    flow.cancel();
    flow.parsed(7);
    flow.cancel();
    vi.advanceTimersByTime(100);
    expect(send).not.toHaveBeenCalled();
  });
});
