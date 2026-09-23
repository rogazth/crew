import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

import { fake } from "../test/fakeClient";
import { onSessionPatch, type SessionPatch } from "./agentRuntime";
import { transcriptPath } from "./claudeStorage";
import { DISCOVER_MS, launchCommand, learnMode, watchProviderSession } from "./terminalViewLaunch";
import type { Session } from "./types";

const base: Session = {
  id: "crew-1",
  workspaceId: "w",
  kind: "terminal",
  name: "s",
  provider: "claude",
  model: "",
  providerSessionId: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const session = (patch: Partial<Session>): Session => ({ ...base, ...patch });

let patches: Array<[string, SessionPatch]>;
let stopPatches: () => void;

beforeEach(() => {
  fake.reset();
  patches = [];
  stopPatches = onSessionPatch((id, patch) => patches.push([id, patch]));
});

afterEach(() => {
  stopPatches();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function host(homeDir: () => Promise<string>) {
  vi.stubGlobal("window", { crewHost: { homeDir } });
}

describe("launchCommand for Claude", () => {
  it("resumes when Claude already has a transcript for the session", async () => {
    host(async () => "/home/u");
    fake.respond("path_exists", () => true);
    const argv = await launchCommand(session({}), "/w/app", "dark");
    expect(fake.sent("path_exists")).toEqual([{ path: transcriptPath("/home/u", "/w/app", "crew-1") }]);
    expect(argv.slice(-2)).toEqual(["--resume", "crew-1"]);
  });

  it("looks for the session a /clear moved it to", async () => {
    host(async () => "/home/u");
    fake.respond("path_exists", () => true);
    await launchCommand(session({ providerSessionId: "cleared" }), "/w/app", "dark");
    expect(fake.sent("path_exists")).toEqual([{ path: transcriptPath("/home/u", "/w/app", "cleared") }]);
  });

  it("starts a new session under Crew's id when there is no transcript", async () => {
    host(async () => "/home/u");
    fake.respond("path_exists", () => false);
    const argv = await launchCommand(session({}), "/w/app", "light");
    expect(argv.slice(-2)).toEqual(["--session-id", "crew-1"]);
    expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!).theme).toBe("light");
  });

  it("starts fresh when the home directory is unknown", async () => {
    host(() => Promise.reject(new Error("no host")));
    const argv = await launchCommand(session({}), "/w/app", "dark");
    expect(fake.sent("path_exists")).toEqual([]);
    expect(argv).toContain("--session-id");
  });

  it("starts fresh when the daemon cannot say whether the transcript exists", async () => {
    host(async () => "/home/u");
    fake.respond("path_exists", () => {
      throw new Error("offline");
    });
    const argv = await launchCommand(session({}), "/w/app", "dark");
    expect(argv).toContain("--session-id");
  });
});

describe("launchCommand for a provider that binds before launch", () => {
  it("creates a session, binds it, and resumes it", async () => {
    fake.respond("session_provider_create", () => "chat-9");
    const argv = await launchCommand(session({ provider: "cursor" }), "/w/app", "dark");
    expect(fake.sent("session_provider_create")).toEqual([{ id: "crew-1" }]);
    expect(patches).toEqual([["crew-1", { providerSessionId: "chat-9" }]]);
    expect(argv).toEqual(["cursor-agent", "--resume", "chat-9"]);
  });

  it("launches unbound when creating the session fails", async () => {
    fake.respond("session_provider_create", () => {
      throw new Error("not logged in");
    });
    const argv = await launchCommand(session({ provider: "cursor", model: "auto" }), "/w/app", "dark");
    expect(patches).toEqual([]);
    expect(argv).toEqual(["cursor-agent", "--model", "auto"]);
  });

  it("launches unbound when the daemon creates nothing", async () => {
    fake.respond("session_provider_create", () => "");
    const argv = await launchCommand(session({ provider: "cursor" }), "/w/app", "dark");
    expect(patches).toEqual([]);
    expect(argv).toEqual(["cursor-agent"]);
  });

  it("resumes the bound session without creating another", async () => {
    const argv = await launchCommand(session({ provider: "cursor", providerSessionId: "chat-1" }), "/w/app", "dark");
    expect(fake.sent("session_provider_create")).toEqual([]);
    expect(argv).toEqual(["cursor-agent", "--resume", "chat-1"]);
  });
});

describe("launchCommand for other providers", () => {
  it("launches a provider that names its own session as is", async () => {
    const argv = await launchCommand(session({ provider: "codex" }), "/w/app", "dark");
    expect(fake.client.request).not.toHaveBeenCalled();
    expect(argv).toEqual(["codex"]);
  });

  it("runs an unknown provider as a bare command", async () => {
    expect(await launchCommand(session({ provider: "mystery" }), "/w/app", "dark")).toEqual(["mystery"]);
  });
});

describe("learnMode", () => {
  it("asks Claude whether /clear moved it", () => {
    expect(learnMode(session({}))).toBe("rebind");
    expect(learnMode(session({ providerSessionId: "cleared" }))).toBe("rebind");
  });

  it("looks for a session codex or opencode named only until one is bound", () => {
    expect(learnMode(session({ provider: "codex" }))).toBe("discover");
    expect(learnMode(session({ provider: "opencode" }))).toBe("discover");
    expect(learnMode(session({ provider: "codex", providerSessionId: "t-1" }))).toBeNull();
  });

  it("learns nothing for a session bound before launch or an unknown provider", () => {
    expect(learnMode(session({ provider: "cursor" }))).toBeNull();
    expect(learnMode(session({ provider: "mystery" }))).toBeNull();
  });
});

describe("watchProviderSession", () => {
  it("asks Claude on every interval and binds the session it moved to", async () => {
    vi.useFakeTimers();
    fake.respond("session_claude_rebind", () => "moved");
    const stop = watchProviderSession("rebind", "crew-1", "/w/app", 100);
    await vi.advanceTimersByTimeAsync(DISCOVER_MS - 1);
    expect(fake.sent("session_claude_rebind")).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sent("session_claude_rebind")).toEqual([{ id: "crew-1" }]);
    expect(patches).toEqual([["crew-1", { providerSessionId: "moved" }]]);
    stop();
  });

  it("looks for a session started in the directory since launch", async () => {
    vi.useFakeTimers();
    fake.respond("session_provider_discover", () => "thread-2");
    const stop = watchProviderSession("discover", "crew-1", "/w/app", 1234, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.sent("session_provider_discover")).toEqual([{ id: "crew-1", cwd: "/w/app", since: 1234 }]);
    expect(patches).toEqual([["crew-1", { providerSessionId: "thread-2" }]]);
    stop();
  });

  it("binds nothing while nothing is found, and keeps looking after a failure", async () => {
    vi.useFakeTimers();
    let calls = 0;
    fake.respond("session_provider_discover", () => {
      calls += 1;
      if (calls === 1) return null;
      throw new Error("offline");
    });
    const stop = watchProviderSession("discover", "crew-1", "/w/app", 0, 50);
    await vi.advanceTimersByTimeAsync(150);
    expect(calls).toBe(3);
    expect(patches).toEqual([]);
    stop();
  });

  it("does not ask again while a look is still out", async () => {
    vi.useFakeTimers();
    const stop = watchProviderSession("rebind", "crew-1", "/w/app", 0, 50);
    await vi.advanceTimersByTimeAsync(150);
    expect(fake.sent("session_claude_rebind")).toHaveLength(1);
    fake.take("session_claude_rebind").resolve(null);
    await vi.advanceTimersByTimeAsync(50);
    expect(fake.sent("session_claude_rebind")).toHaveLength(2);
    stop();
  });

  it("stops asking once stopped", async () => {
    vi.useFakeTimers();
    fake.respond("session_claude_rebind", () => null);
    const stop = watchProviderSession("rebind", "crew-1", "/w/app", 0, 50);
    await vi.advanceTimersByTimeAsync(50);
    stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(fake.sent("session_claude_rebind")).toHaveLength(1);
  });
});
