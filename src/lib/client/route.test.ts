import { describe, expect, it } from "vitest";
import { LOCAL, envForPath, routeEnv, type RouteMaps } from "./route";

function maps(partial: Partial<RouteMaps> = {}): RouteMaps {
  return {
    workspace: partial.workspace ?? new Map(),
    session: partial.session ?? new Map(),
    path: partial.path ?? new Map(),
    routine: partial.routine ?? new Map(),
  };
}

describe("routeEnv", () => {
  it("keeps preferences, the browser and the address book on this Mac", () => {
    const known = maps({ workspace: new Map([["w", "vps"]]) });
    expect(routeEnv("state_get", { key: "rail_order" }, known)).toBe(LOCAL);
    expect(routeEnv("browser_history_list", {}, known)).toBe(LOCAL);
    expect(routeEnv("messages_search", { text: "hi" }, known)).toBe(LOCAL);
    expect(routeEnv("remote_list", {}, known)).toBe(LOCAL);
  });

  it("follows a workspace, a session and a path to the daemon that owns them", () => {
    const known = maps({
      workspace: new Map([["w", "vps"]]),
      session: new Map([["s", "vps"]]),
      path: new Map([["/home/agent/app", "vps"]]),
      routine: new Map([["r", "vps"]]),
    });
    expect(routeEnv("session_list", { workspaceId: "w" }, known)).toBe("vps");
    expect(routeEnv("turn_start", { sessionId: "s" }, known)).toBe("vps");
    expect(routeEnv("pty_spawn", { id: "s" }, known)).toBe("vps");
    expect(routeEnv("workspace_rename", { id: "w" }, known)).toBe("vps");
    expect(routeEnv("read_text_file", { path: "/home/agent/app/src/main.ts" }, known)).toBe("vps");
    expect(routeEnv("routine_delete", { id: "r" }, known)).toBe("vps");
    expect(routeEnv("read_text_file", { path: "/Users/me/notes.md" }, known)).toBe(LOCAL);
  });

  it("sends a path no workspace holds, and the machine questions, to the focused machine", () => {
    const known = maps({ path: new Map([["/home/agent/app", "vps"]]) });
    expect(routeEnv("path_exists", { path: "/etc/hosts" }, known, undefined, "vps")).toBe("vps");
    expect(routeEnv("path_exists", { path: "/etc/hosts" }, known)).toBe(LOCAL);
    expect(routeEnv("agent_installed", { names: ["claude"] }, known, undefined, "vps")).toBe("vps");
    expect(routeEnv("write_temp_file", { extension: "png" }, known, undefined, "vps")).toBe("vps");
  });

  it("follows a terminal's PTY, named for its pane, to the session's machine", () => {
    const known = maps({ workspace: new Map([["w", "vps"]]), session: new Map([["s", "vps"]]) });
    expect(routeEnv("pty_attach", { id: "w/session:s", from: 0 }, known)).toBe("vps");
    expect(routeEnv("pty_write", { id: "w@/home/agent/app-wt/session:s", data: "x" }, known)).toBe("vps");
    expect(routeEnv("pty_kill", { id: "w/session:unknown" }, known)).toBe("vps");
    expect(routeEnv("pty_kill", { id: "other/session:unknown" }, known)).toBe(LOCAL);
  });

  it("lets the caller name the machine, as opening a folder does", () => {
    expect(routeEnv("workspace_create", { name: "app", path: "/home/agent/app" }, maps(), "vps")).toBe("vps");
  });

  it("picks the longest directory when a worktree sits inside a workspace", () => {
    const paths = new Map([
      ["/home/agent/app", "vps"],
      ["/home/agent/app-other", "home"],
    ]);
    expect(envForPath("/home/agent/app/src/a.ts", paths)).toBe("vps");
    expect(envForPath("/home/agent/app-other/x", paths)).toBe("home");
  });
});
