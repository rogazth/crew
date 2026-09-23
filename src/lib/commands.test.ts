import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function load() {
  return import("./commands");
}

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: "" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("command ids", () => {
  it("lists every command once", async () => {
    const { COMMANDS, COMMAND_IDS } = await load();
    expect(COMMAND_IDS).toEqual(Object.keys(COMMANDS));
    expect(new Set(COMMAND_IDS).size).toBe(COMMAND_IDS.length);
  });

  it("recognizes a command id and rejects anything else", async () => {
    const { isCommandId } = await load();
    expect(isCommandId("open-palette")).toBe(true);
    expect(isCommandId("launch-rockets")).toBe(false);
  });

  it("gives no two commands the same default binding", async () => {
    const { COMMAND_IDS, keysFor } = await load();
    const bindings = COMMAND_IDS.map((id) => JSON.stringify(keysFor(id)));
    expect(new Set(bindings).size).toBe(bindings.length);
  });
});

describe("keys", () => {
  it("binds a command to its default chord", async () => {
    const { keysFor } = await load();
    expect(keysFor("open-palette")).toBe("Mod+K");
    expect(keysFor("next-tab")).toEqual({ key: "]", mod: true, shift: true });
  });

  it("formats the chord for display on the current platform", async () => {
    const { commandKeys } = await load();
    expect(commandKeys("open-launcher")).toBe("Ctrl+T");
    expect(commandKeys("reopen-tab")).toBe("Ctrl+Shift+T");
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: "" });
    expect(commandKeys("open-launcher")).toBe("⌘ T");
  });
});

describe("registerCommand and runCommand", () => {
  it("does nothing, and says so, while no handler is registered", async () => {
    const { runCommand } = await load();
    expect(runCommand("toggle-sidebar")).toBe(false);
  });

  it("runs the registered handler", async () => {
    const { registerCommand, runCommand } = await load();
    const handler = vi.fn();
    registerCommand("toggle-sidebar", handler);
    expect(runCommand("toggle-sidebar")).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("stops running the handler once it unregisters", async () => {
    const { registerCommand, runCommand } = await load();
    const handler = vi.fn();
    const unregister = registerCommand("toggle-sidebar", handler);
    unregister();
    expect(runCommand("toggle-sidebar")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("lets the newest registration win, and a stale unregister leave it in place", async () => {
    const { registerCommand, runCommand } = await load();
    const older = vi.fn();
    const newer = vi.fn();
    const unregisterOlder = registerCommand("save-file", older);
    registerCommand("save-file", newer);
    unregisterOlder();
    expect(runCommand("save-file")).toBe(true);
    expect(newer).toHaveBeenCalledTimes(1);
    expect(older).not.toHaveBeenCalled();
  });
});

describe("listedCommands", () => {
  it("offers only commands with a live handler, in declaration order, with label and keys", async () => {
    const { listedCommands, registerCommand } = await load();
    registerCommand("open-settings", vi.fn());
    registerCommand("new-agent", vi.fn());
    expect(listedCommands()).toEqual([
      { id: "new-agent", label: "New Agent", keys: "Ctrl+Shift+N" },
      { id: "open-settings", label: "Settings", keys: "Ctrl+," },
    ]);
  });

  it("leaves out tab plumbing and the palette's own doors", async () => {
    const { listedCommands, registerCommand } = await load();
    for (const id of ["next-tab", "prev-tab", "workspace-1", "workspace-9", "close", "open-palette", "go-to-file", "open-actions"] as const) {
      registerCommand(id, vi.fn());
    }
    registerCommand("reopen-tab", vi.fn());
    registerCommand("next-workspace", vi.fn());
    expect(listedCommands().map((command) => command.id)).toEqual(["reopen-tab", "next-workspace"]);
  });

  it("is empty when nothing is registered", async () => {
    const { listedCommands } = await load();
    expect(listedCommands()).toEqual([]);
  });
});
