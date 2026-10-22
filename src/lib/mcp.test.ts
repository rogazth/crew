import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer, McpState, McpStatus } from "./protocol";

const request = vi.fn();
const on = vi.fn();
const onReconnect = vi.fn();
vi.mock("./client", () => ({ client: { request, on, onReconnect } }));

function server(name: string, state: McpState, extra: Partial<McpServer> = {}): McpServer {
  return { name, state, ...extra };
}

function status(...servers: McpServer[]): McpStatus {
  return { servers, reported: true };
}

/** The one the bridge registered for "mcp-changed". */
function remote(): (payload: unknown) => void {
  const hook = on.mock.calls.find(([event]) => event === "mcp-changed");
  if (!hook) throw new Error("the bridge never subscribed");
  return hook[1] as (payload: unknown) => void;
}

const flush = () => new Promise((done) => setTimeout(done, 0));

async function mcp() {
  return import("./mcp");
}

beforeEach(() => {
  vi.resetModules();
  request.mockReset();
  on.mockReset();
  onReconnect.mockReset();
});

describe("the chip", () => {
  it("says nothing while every server works, connects or is off", async () => {
    const { chipLabel } = await mcp();
    expect(chipLabel(null)).toBeNull();
    expect(chipLabel(status())).toBeNull();
    expect(chipLabel(status(server("a", "connected"), server("b", "pending"), server("c", "disabled"), server("d", "unknown")))).toBeNull();
  });

  it("counts the servers that need a sign-in and the ones that failed", async () => {
    const { chipLabel } = await mcp();
    expect(chipLabel(status(server("a", "needs_auth")))).toBe("1 needs sign-in");
    expect(chipLabel(status(server("a", "needs_auth"), server("b", "needs_auth")))).toBe("2 need sign-in");
    expect(chipLabel(status(server("a", "failed"), server("b", "connected")))).toBe("1 failed");
    expect(chipLabel(status(server("a", "needs_auth"), server("b", "failed"), server("c", "failed")))).toBe("1 needs sign-in · 2 failed");
  });
});

describe("the sheet's rows", () => {
  it("lists the servers to act on first, the rest in the provider's order", async () => {
    const { sortedServers } = await mcp();
    const rows = sortedServers(status(server("a", "connected"), server("b", "failed"), server("c", "needs_auth"), server("d", "pending")));
    expect(rows.map((row) => row.name)).toEqual(["c", "b", "a", "d"]);
    expect(sortedServers(null)).toEqual([]);
  });

  it("offers a sign-in to a server that needs one and a new try to one that failed", async () => {
    const { actionOf } = await mcp();
    expect(actionOf(server("a", "needs_auth"))).toBe("sign-in");
    expect(actionOf(server("a", "failed"))).toBe("reconnect");
    expect(["connected", "pending", "disabled", "unknown"].map((state) => actionOf(server("a", state as McpState)))).toEqual([null, null, null, null]);
  });

  it("says each state, with why when the provider did", async () => {
    const { stateLabel } = await mcp();
    expect(stateLabel(server("a", "connected"))).toBe("Connected");
    expect(stateLabel(server("a", "pending"))).toBe("Connecting");
    expect(stateLabel(server("a", "failed", { error: "ENOENT" }))).toBe("Failed: ENOENT");
    expect(stateLabel(server("a", "failed"))).toBe("Failed");
    expect(stateLabel(server("a", "needs_auth"))).toBe("Needs sign-in");
  });

  it("says a provider that reports nothing does not", async () => {
    const { unreportedNote } = await mcp();
    expect(unreportedNote({ servers: [], reported: false }, "Cursor")).toBe("Cursor does not report its servers");
    expect(unreportedNote(status(), "Cursor")).toBeNull();
    expect(unreportedNote(null, "Cursor")).toBeNull();
  });
});

describe("the store", () => {
  it("asks the daemon for a session's servers the first time it is watched", async () => {
    const { subscribeMcp, readMcp } = await mcp();
    request.mockResolvedValue(status(server("a", "connected")));
    subscribeMcp("s1", () => {});
    expect(request).toHaveBeenCalledWith("mcp_list", { sessionId: "s1" });
    await flush();
    expect(readMcp("s1")).toEqual(status(server("a", "connected")));
    expect(readMcp("s2")).toBeNull();
  });

  it("keeps the newest push and tells the listener", async () => {
    const { subscribeMcp, readMcp } = await mcp();
    request.mockResolvedValue({ servers: [], reported: false });
    const listener = vi.fn();
    subscribeMcp("s1", listener);
    await flush();
    remote()({ sessionId: "s1", status: status(server("a", "needs_auth"), server("b", "connected")) });
    expect(readMcp("s1")?.servers.map((row) => row.name)).toEqual(["a", "b"]);
    expect(listener).toHaveBeenCalled();
  });

  it("does not let a status asked before a push overwrite that push", async () => {
    const { subscribeMcp, readMcp } = await mcp();
    let answer: (value: McpStatus) => void = () => {};
    request.mockReturnValue(new Promise<McpStatus>((done) => (answer = done)));
    subscribeMcp("s1", () => {});
    remote()({ sessionId: "s1", status: status(server("a", "connected")) });
    answer(status(server("a", "pending")));
    await flush();
    expect(readMcp("s1")?.servers[0]?.state).toBe("connected");
  });
});

describe("after a sign-in terminal", () => {
  it("has the session connect the server once, whatever the tab's shell does after", async () => {
    const { reconnectAfterSignIn, readMcp } = await mcp();
    request.mockResolvedValue(status(server("sentry", "connected")));
    await reconnectAfterSignIn("tab1", "s1", "sentry");
    await reconnectAfterSignIn("tab1", "s1", "sentry");
    expect(request.mock.calls.filter(([method]) => method === "mcp_reconnect")).toEqual([["mcp_reconnect", { sessionId: "s1", name: "sentry" }]]);
    expect(readMcp("s1")).toEqual(status(server("sentry", "connected")));
  });

  it("leaves the status alone when the try is refused", async () => {
    const { reconnectAfterSignIn, readMcp } = await mcp();
    request.mockRejectedValue(new Error("Server status: needs-auth"));
    await reconnectAfterSignIn("tab2", "s1", "sentry");
    expect(readMcp("s1")).toBeNull();
  });
});
