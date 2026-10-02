import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, parseAgentChoice, pickProvider } from "./providers";
import { sessionCommand } from "./sessionCommand";
import type { Session } from "./types";

const base: Session = {
  id: "crew-1",
  workspaceId: "w",
  kind: "terminal",
  name: "s",
  provider: "claude",
  model: "",
  providerSessionId: null,
  worktree: null,
  description: "",
  notifications: true,
  autonomy: "ask",
  status: "idle",
  createdAt: 0,
  updatedAt: 0,
};

const argv = (patch: Partial<Session>, resume = false) =>
  sessionCommand({ ...base, ...patch }, { resume, theme: "dark" });

describe("sessionCommand", () => {
  const settings = (a: string[]) => JSON.parse(a[a.indexOf("--settings") + 1] ?? "");

  it("hands a first message to every CLI after its flags, never as a flag or a subcommand", () => {
    const first = (provider: string, prompt: string) =>
      sessionCommand({ ...base, provider }, { resume: false, theme: "dark", bypass: true, prompt });
    expect(first("claude", "update my notes").slice(-3)).toEqual(["--dangerously-skip-permissions", "--", "update my notes"]);
    expect(first("codex", "-h means help?").slice(-2)).toEqual(["--", "-h means help?"]);
    expect(first("cursor", "hi").slice(-2)).toEqual(["--", "hi"]);
    expect(first("opencode", "hi").at(-1)).toBe("--prompt=hi");
  });

  it("starts without a message when none was written", () => {
    expect(argv({})).not.toContain("--");
  });

  it("leaves the model to Claude's own config when none is picked", () => {
    expect(argv({}).slice(3)).toEqual(["--session-id", "crew-1"]);
    expect(argv({ model: "claude-opus-5-5" })).toContain("--model");
  });

  it("resumes Claude by Crew's own id until a /clear moves it", () => {
    expect(argv({}, true).slice(3)).toEqual(["--resume", "crew-1"]);
    expect(argv({ providerSessionId: "cleared" }, true).slice(3)).toEqual(["--resume", "cleared"]);
    expect(argv({ providerSessionId: "cleared" }).slice(3)).toEqual(["--session-id", "cleared"]);
  });

  it("has Claude report every session it moves to, silently, one record each", () => {
    const { theme, hooks } = settings(argv({}));
    expect(theme).toBe("dark");
    const [command] = hooks.SessionStart[0].hooks;
    expect(command.type).toBe("command");
    expect(hooks.SessionStart[0].matcher).toBeUndefined();

    // Run as Claude runs it: sh, the payload on stdin. Two starts in the same
    // second (a quick /clear) both stay; a payload over several lines is kept whole.
    const dir = mkdtempSync(path.join(tmpdir(), "crew-bind-"));
    try {
      const payloads = ['{"session_id":"a","source":"startup"}', '{\n  "session_id": "b",\n  "source": "clear"\n}'];
      for (const input of payloads) {
        const run = spawnSync("sh", ["-c", command.command], { input, env: { ...process.env, CREW_CLAUDE_BIND_DIR: dir } });
        expect(run.status).toBe(0);
        expect(run.stdout.length).toBe(0);
      }
      const files = readdirSync(dir);
      expect(files).toHaveLength(2);
      for (const file of files) expect(file).toMatch(/^crew-1\.[0-9]+-[0-9]+\.start$/);
      const written = files.map((file) => readFileSync(path.join(dir, file), "utf8")).sort();
      expect(written).toEqual([...payloads].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has Claude report what it does through every hook, silently, in the bind folder", () => {
    const { hooks } = settings(argv({}));
    const events = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"];
    for (const event of events) expect(hooks[event], event).toBeDefined();
    expect(hooks.Notification).toBeUndefined();
    const live = hooks.PermissionRequest[0].hooks[0].command;
    expect(hooks.SessionStart[1].hooks[0].command).toBe(live);

    const dir = mkdtempSync(path.join(tmpdir(), "crew-bind-"));
    try {
      const input = '{"hook_event_name":"PermissionRequest","tool_name":"Bash"}';
      const run = spawnSync("sh", ["-c", live], { input, env: { ...process.env, CREW_CLAUDE_BIND_DIR: dir } });
      expect(run.status).toBe(0);
      expect(run.stdout.length).toBe(0);
      const [file, ...rest] = readdirSync(dir);
      expect(rest).toEqual([]);
      expect(file).toMatch(/^crew-1\.[0-9]+-[0-9]+\.hook$/);
      expect(readFileSync(path.join(dir, file!), "utf8")).toBe(input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resumes the others by the id their CLI handed out", () => {
    expect(argv({ provider: "cursor", providerSessionId: "chat", model: "auto" })).toEqual([
      "cursor-agent",
      "--resume",
      "chat",
      "--model",
      "auto",
    ]);
    expect(argv({ provider: "codex", providerSessionId: "t1" })).toEqual(["codex", "resume", "t1"]);
    // Where it runs, Codex trusts the folder and takes Crew's hooks, from the command line alone.
    const codex = sessionCommand({ ...base, provider: "codex", providerSessionId: "t1" }, {
      resume: false,
      theme: "dark",
      cwd: "/w/app",
    });
    expect(codex[0]).toBe("codex");
    expect(codex.slice(1, 3)).toEqual(["-c", 'projects={"/w/app"={trust_level="trusted"}}']);
    expect(codex.slice(-2)).toEqual(["resume", "t1"]);
    expect(argv({ provider: "opencode", providerSessionId: "ses_1", model: "opencode/x" })).toEqual([
      "opencode",
      "--session",
      "ses_1",
      "-m",
      "opencode/x",
    ]);
  });

  it("runs every provider without asking only when Settings bypasses permissions", () => {
    const bypassed = (patch: Partial<Session>, resume = false) =>
      sessionCommand({ ...base, ...patch }, { resume, theme: "dark", bypass: true });
    for (const provider of PROVIDERS) {
      expect(argv({ provider: provider.id })).not.toContain(provider.bypassFlag);
      expect(bypassed({ provider: provider.id })).toContain(provider.bypassFlag);
      expect(bypassed({ provider: provider.id, providerSessionId: "id" }, true)).toContain(provider.bypassFlag);
    }
    expect(bypassed({}, true).slice(3)).toEqual(["--resume", "crew-1", "--dangerously-skip-permissions"]);
    expect(bypassed({ provider: "codex", providerSessionId: "t1" })).toEqual([
      "codex",
      "resume",
      "t1",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(bypassed({ provider: "cursor", providerSessionId: "chat" })).toEqual(["cursor-agent", "--resume", "chat", "--force"]);
  });

  it("starts fresh until an id is known", () => {
    expect(argv({ provider: "codex", model: "gpt-6-astra" })).toEqual(["codex", "-m", "gpt-6-astra"]);
    expect(argv({ provider: "opencode" })).toEqual(["opencode"]);
  });
});

describe("pickProvider", () => {
  const only = (...ids: string[]) => PROVIDERS.filter((p) => ids.includes(p.id));

  it("keeps the preference while its CLI is installed", () => {
    const choice = { provider: "codex" as const, model: "gpt-5.5" };
    expect(pickProvider(choice, only("claude", "codex"))).toBe(choice);
  });

  it("falls back to the first installed provider on its default model", () => {
    expect(pickProvider({ provider: "codex", model: "gpt-5.5" }, only("opencode", "cursor"))).toEqual({
      provider: "cursor",
      model: "",
    });
  });
});

describe("parseAgentChoice", () => {
  it("rejects what is not a known provider", () => {
    expect(parseAgentChoice(null)).toBeNull();
    expect(parseAgentChoice('{"provider":"gemini"}')).toBeNull();
    expect(parseAgentChoice('{"provider":"codex"}')).toEqual({ provider: "codex", model: "" });
  });
});
