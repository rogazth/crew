// The Connectors page's reading of the provider servers' lists
// (surfaces/settings/integrations/servers.ts); here, where the tests run.
import { describe, expect, it } from "vitest";
import { brandOfServer, copiesPhrase, drifted, groupStatus, groupsOf, listJoin, rowStatus, scopeLine, offlinePhrase, serverLine, serviceOn, servicesOf } from "../surfaces/settings/integrations/servers";
import type { McpState, ProviderInventory, ProviderServer } from "./protocol";

function server(provider: string, name: string, state: McpState, extra: Partial<ProviderServer> = {}): ProviderServer {
  return {
    provider,
    name,
    transport: "http",
    target: "https://mcp.context7.com/mcp",
    scope: "user",
    state,
    error: null,
    tools: state === "connected" ? 2 : null,
    offInCrew: false,
    canSignIn: true,
    canRemove: true,
    ...extra,
  };
}

function inv(provider: string, servers: ProviderServer[], installed = true): ProviderInventory {
  return { provider, installed, servers, error: null, checkedAt: 1, checking: false };
}

const MAC: ProviderInventory[] = [
  inv("grok", []),
  inv("claude", [
    server("claude", "context7", "connected"),
    server("claude", "chrome-devtools", "connected", { transport: "stdio", target: "npx chrome-devtools-mcp" }),
    server("claude", "claude.ai Notion", "connected", { transport: "claude.ai", scope: "claude.ai", canSignIn: false }),
    server("claude", "plugin:figma:figma", "needs_auth", { scope: "plugin" }),
  ]),
  inv("codex", [server("codex", "context7", "needs_auth"), server("codex", "figma-nerb", "needs_auth"), server("codex", "chrome-devtools", "connected")]),
  inv("cursor", [server("cursor", "context7", "connected"), server("cursor", "figma-nerb", "needs_auth")]),
  inv("opencode", [], false),
];

const idle = () => null;

describe("listJoin", () => {
  it("joins with commas and a last and", () => {
    expect(listJoin([])).toBe("");
    expect(listJoin(["a"])).toBe("a");
    expect(listJoin(["a", "b"])).toBe("a and b");
    expect(listJoin(["a", "b", "c"])).toBe("a, b and c");
  });
});

describe("groupsOf", () => {
  it("makes one group per name, its copies in the CLIs' order, what needs the person first", () => {
    const groups = groupsOf(MAC);
    expect(groups.map((g) => g.name)).toEqual(["context7", "figma-nerb", "figma", "chrome-devtools", "Notion"]);
    expect(groups[0]!.servers.map((x) => x.provider)).toEqual(["claude", "codex", "cursor"]);
  });

  it("makes one group of the copies the registry knows as one server, under its name", () => {
    const notion = { name: "com.notion/mcp", title: "Notion MCP", description: "", publisher: "notion.com", remoteUrl: "https://mcp.notion.com/mcp", iconUrl: null, firstParty: true, updatedAt: "" };
    const claude = server("claude", "claude.ai Notion", "connected", { target: "https://mcp.notion.com/mcp" });
    const codex = server("codex", "notion-work", "connected", { target: "https://mcp.notion.com/mcp" });
    const groups = groupsOf([inv("claude", [claude]), inv("codex", [codex])], (x) => (x.target.includes("notion") ? notion : undefined));
    expect(groups.map((g) => [g.name, g.servers.length])).toEqual([["Notion", 2]]);
  });

  it("keeps two copies of one registry server in one CLI apart, as the accounts they are", () => {
    const figma = { name: "com.figma.mcp/mcp", title: "Figma", description: "", publisher: "figma.com", remoteUrl: "https://mcp.figma.com/mcp", iconUrl: null, firstParty: true, updatedAt: "" };
    const at = { target: "https://mcp.figma.com/mcp" };
    const groups = groupsOf(
      [inv("codex", [server("codex", "figma-nerb", "connected", at)]), inv("cursor", [server("cursor", "figma-nerb", "connected", at), server("cursor", "figma-cuddles", "connected", at)])],
      () => figma,
    );
    expect(groups.map((g) => [g.name, g.servers.length]).sort()).toEqual([["figma-cuddles", 1], ["figma-nerb", 2]]);
    expect(groups.every((g) => g.registry === figma)).toBe(true);
  });

  it("leaves out what a CLI's own app installs for itself", () => {
    const groups = groupsOf([inv("codex", [server("codex", "computer-use", "connected", { scope: "bundled" }), server("codex", "zed", "connected")])]);
    expect(groups.map((g) => g.name)).toEqual(["zed"]);
  });

  it("does not count a copy that is off as needing anything", () => {
    const groups = groupsOf([inv("codex", [server("codex", "linear", "needs_auth", { offInCrew: true }), server("codex", "zed", "failed")])]);
    expect(groups.map((g) => g.name)).toEqual(["zed", "linear"]);
  });
});

describe("groupStatus", () => {
  const [context7] = groupsOf(MAC);

  it("speaks for the worst copy that is on", () => {
    expect(groupStatus(context7!, idle)).toEqual({ tone: "warning", text: "Sign in required · Codex" });
  });

  it("says a sign-in first, then a start", () => {
    expect(groupStatus(context7!, (x) => (x.provider === "codex" ? "signing-in" : null)).text).toBe("Signing in…");
    expect(groupStatus(context7!, (x) => (x.provider === "codex" ? "starting" : null)).tone).toBe("info");
  });

  it("is quiet when every copy is off", () => {
    const off = groupsOf([inv("claude", [server("claude", "x", "connected", { offInCrew: true })]), inv("grok", [server("grok", "x", "disabled")])])[0]!;
    expect(groupStatus(off, idle)).toEqual({ tone: undefined, text: "Off · Claude Code, Grok Build" });
  });
});

describe("rowStatus", () => {
  it("offers a sign-in where Crew can start one", () => {
    expect(rowStatus(server("codex", "context7", "needs_auth"), null)).toMatchObject({ text: "Sign in required", fix: "sign-in", problem: true });
  });

  it("sends a claude.ai connector to claude.ai", () => {
    const notion = server("claude", "claude.ai Notion", "needs_auth", { scope: "claude.ai", transport: "claude.ai", canSignIn: false });
    expect(rowStatus(notion, null)).toMatchObject({ text: "Sign in required", fix: "claude.ai" });
  });

  it("says what failed and offers a new try", () => {
    expect(rowStatus(server("cursor", "pw", "failed", { error: "npx exited 1" }), null)).toMatchObject({ text: "Failed to start · npx exited 1", fix: "retry" });
  });

  it("says where Cursor's and Grok's off reaches", () => {
    expect(rowStatus(server("claude", "a", "connected", { offInCrew: true }), null).text).toBe("Off");
    expect(rowStatus(server("cursor", "a", "connected", { offInCrew: true }), null).text).toBe("Off, also outside the app");
    expect(rowStatus(server("grok", "a", "disabled"), null).text).toBe("Disabled in Grok Build");
  });

  it("goes from authenticating to starting to where it's set up", () => {
    const figma = server("claude", "plugin:figma:figma", "needs_auth", { scope: "plugin" });
    expect(rowStatus(figma, "signing-in")).toMatchObject({ text: "Signing in…", working: true, fix: null });
    expect(rowStatus(figma, "starting")).toMatchObject({ text: "Starting…", working: true });
    expect(rowStatus({ ...figma, state: "pending" }, null)).toMatchObject({ text: "Starting…", working: true });
    expect(rowStatus({ ...figma, state: "connected", tools: 11 }, null)).toMatchObject({ text: "From a plugin · 11 tools", working: false, fix: null });
  });
});

describe("scopeLine and serverLine", () => {
  it("names the scope and the tool count when the CLI says them", () => {
    expect(scopeLine(server("claude", "a", "connected", { tools: 1 }))).toBe("User config · 1 tool");
    expect(scopeLine(server("grok", "a", "unknown", { scope: null }))).toBe("Grok Build’s config");
  });

  it("says where a server runs", () => {
    expect(serverLine(server("claude", "a", "connected", { tools: 26 }))).toBe("26 tools · mcp.context7.com");
    expect(serverLine(server("claude", "a", "connected", { transport: "stdio", target: "npx x", tools: null }))).toBe("Runs on the machine");
  });
});

describe("brandOfServer", () => {
  it("draws a remote server from its host, a claude.ai connector from its name, and a command from nothing", () => {
    expect(brandOfServer(server("codex", "context7", "connected"))).toMatchObject({ publisher: "mcp.context7.com", name: "context7" });
    expect(brandOfServer(server("claude", "claude.ai Notion", "connected", { transport: "claude.ai", scope: "claude.ai", target: "" }))).toMatchObject({ name: "Notion", publisher: "" });
    expect(brandOfServer(server("claude", "chrome-devtools", "connected", { transport: "stdio", target: "npx chrome-devtools-mcp" }))).toBeNull();
  });
});

describe("services across machines", () => {
  const studio: ProviderInventory[] = [
    inv("claude", [server("claude", "context7", "connected", { offInCrew: true }), server("claude", "linear", "needs_auth", { target: "https://mcp.linear.app/mcp" })]),
  ];
  const services = servicesOf([
    { envId: "local", inventory: MAC },
    { envId: "studio", inventory: studio },
  ]);

  it("merges a server's groups from every machine, each machine with its own copies", () => {
    const context7 = services.find((s) => s.key === "context7")!;
    expect(context7.machines.map((m) => [m.envId, m.servers.map((x) => x.provider)])).toEqual([
      ["local", ["claude", "codex", "cursor"]],
      ["studio", ["claude"]],
    ]);
    expect(context7.servers).toHaveLength(4);
    expect(services.find((s) => s.key === "linear")!.machines.map((m) => m.envId)).toEqual(["studio"]);
  });

  it("is on while any copy is, until the person chooses", () => {
    const context7 = services.find((s) => s.key === "context7")!;
    expect(serviceOn(context7, {})).toBe(true);
    expect(serviceOn(context7, { context7: false })).toBe(false);
  });

  it("finds the copies whose switch doesn't follow the choice", () => {
    const local = groupsOf(MAC).find((g) => g.key === "context7")!;
    expect(drifted(local, false).map((x) => x.provider)).toEqual(["claude", "codex", "cursor"]);
    expect(drifted(local, true)).toEqual([]);
    const away = groupsOf(studio).find((g) => g.key === "context7")!;
    expect(drifted(away, true).map((x) => x.provider)).toEqual(["claude"]);
  });
});

describe("machines in a sentence", () => {
  it("names two machines and counts more, by CLI", () => {
    expect(copiesPhrase([{ cli: "Grok Build", machine: "Studio" }])).toBe("Grok Build on Studio");
    expect(copiesPhrase([{ cli: "Cursor", machine: "this Mac" }, { cli: "Grok Build", machine: "Studio" }])).toBe("Cursor on this Mac and Grok Build on Studio");
    const many = ["a", "b", "c", "d", "e"].map((machine) => ({ cli: "Grok Build", machine }));
    expect(copiesPhrase([{ cli: "Cursor", machine: "this Mac" }, ...many])).toBe("Cursor on this Mac and Grok Build on 5 machines");
  });

  it("says machines away once", () => {
    expect(offlinePhrase(["Studio"])).toBe("Studio is offline. Showing its last report.");
    expect(offlinePhrase(["Studio", "box-a"])).toBe("Studio and box-a are offline. Showing their last report.");
    expect(offlinePhrase(["a", "b", "c", "d", "e"])).toBe("5 machines are offline. Showing their last report.");
  });
});
