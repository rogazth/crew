import { describe, expect, it } from "vitest";
import { blockingScreen, takesInput } from "./blockingScreen";

// Screens as Claude Code 2.1.283 and Codex 0.154.0 draw them at 120 columns.
const CLAUDE_TRUST = [
  "────────────────────────────────────────────────",
  " Accessing workspace:",
  " /tmp/fresh-claude",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  " Enter to confirm · Esc to cancel",
];

const CLAUDE_PROMPT = [
  " ▐▛███▛█   Claude Code v2.1.283",
  "────────────────────────────────",
  "❯ Try \"how does <filepath> work?\"",
  "────────────────────────────────",
  "  ⏸ manual mode on · ? for shortcuts",
];

const CODEX_TRUST = [
  "> You are in /tmp/fresh-codex",
  "  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk of prompt",
  "  injection. Trusting the directory allows project-local config, hooks, and exec policies to load.",
  "› 1. Yes, continue",
  "  2. No, quit",
  "  Press enter to continue",
];

const CODEX_UPDATE = [
  "  ✨ Update available! 0.154.0 -> 0.158.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  "› 1. Update now (runs `sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh'`)",
  "  2. Skip",
  "  3. Skip until next version",
  "  Press enter to continue",
];

/** The banner Codex keeps above its prompt once the update was skipped: not a blocking screen. */
const CODEX_UPDATE_BANNER = [
  "│ ✨ Update available! 0.154.0 -> 0.158.0                     │",
  "│ Run sh -c 'curl -fsSL https://chatgpt.com/codex/install.sh' to update. │",
  "│ >_ OpenAI Codex (v0.154.0)                           │",
  "› Ask Codex to do anything",
];

// Claude Code 2.1.284, right after the trust prompt.
const CLAUDE_RENDERER = [
  " Try the new fullscreen renderer?",
  " · Flicker-free output",
  " · Mouse support — click to move your cursor or expand results",
  " ❯ 1. Yes, try it",
  "   2. Not now",
  " Enter to confirm · Esc to cancel",
];

describe("blockingScreen", () => {
  it("knows Claude's folder trust prompt", () => {
    expect(blockingScreen("claude", CLAUDE_TRUST)?.kind).toBe("trust");
  });

  it("knows a modal prompt of Claude's, named or not", () => {
    expect(blockingScreen("claude", CLAUDE_RENDERER)?.title).toBe("Claude offers its new fullscreen renderer");
    const other = [" Pick a theme", " ❯ 1. Dark", "   2. Light", " Enter to confirm · Esc to cancel"];
    expect(blockingScreen("claude", other)?.kind).toBe("dialog");
  });

  it("says nothing over a prompt that takes a message", () => {
    expect(blockingScreen("claude", CLAUDE_PROMPT)).toBeNull();
    expect(blockingScreen("codex", CODEX_UPDATE_BANNER)).toBeNull();
  });

  it("knows Codex's trust prompt and its update offer", () => {
    expect(blockingScreen("codex", CODEX_TRUST)?.kind).toBe("trust");
    expect(blockingScreen("codex", CODEX_UPDATE)?.kind).toBe("update");
  });

  it("reads a sentence the terminal wrapped across lines", () => {
    expect(blockingScreen("codex", ["  3 hooks need", "review before they can run."])?.kind).toBe("hooks");
  });

  it("knows opencode's permission prompt", () => {
    // opencode 1.18.33, reading outside the project.
    const screen = [
      "  ┃  △ Permission required",
      "  ┃    ← Access external directory /etc",
      "  ┃  Patterns",
      "  ┃  - /etc/*",
      "  ┃   Allow once   Allow always   Reject           ctrl+f fullscreen  ⇆ select  enter confirm",
    ];
    expect(blockingScreen("opencode", screen)?.title).toBe("opencode asks for a permission");
  });

  it("knows Cursor's trust prompt, its sign-in and its approvals", () => {
    // cursor-agent 2026.10.01 at 120 columns.
    const trust = [
      "  │  ⚠ Workspace Trust Required                                     │",
      "  │  Cursor Agent can execute code and access files in this directory. │",
      "  │  Do you trust the contents of this directory?                   │",
      "  │  ▶ [a] Trust this workspace                                     │",
      "  │    [q] Quit                                                     │",
    ];
    expect(blockingScreen("cursor", trust)?.kind).toBe("trust");
    // Answered: the box stays above the prompt, its choice no longer pointed at.
    const trusted = [...trust.map((line) => line.replace("▶", " ")), "  │  ⏳ Trusting workspace... │", "  → Plan, search, build anything"];
    expect(blockingScreen("cursor", trusted)).toBeNull();
    expect(blockingScreen("cursor", ["  Cursor Agent", "  Press any key to log in..."])?.kind).toBe("login");
    const command = [
      "  $ touch probe.txt Waiting for approval...",
      " $  touch probe.txt in .",
      " Run this command?",
      " Shell allowlist is empty",
      "  → Run (once) (y)",
      "    Add Shell(touch) to allowlist? (tab)",
      "    Run Everything (shift+tab)",
      "    Skip & tell the agent what to do instead (esc or n)",
    ];
    expect(blockingScreen("cursor", command)?.title).toBe("Cursor asks to run a command");
  });

  it("says nothing over Cursor's prompt, working or not", () => {
    const idle = ["  Cursor Agent", "  → Plan, search, build anything", "  Grok 4.7 256K Medium   Run Everything"];
    expect(blockingScreen("cursor", idle)).toBeNull();
    const queued = [" ⠀⠞ Working", " │ ○ Then tell me what 3+3 is. │", " │ enter steer · ↑ select/edit · esc cancel │"];
    expect(blockingScreen("cursor", queued)).toBeNull();
  });

  it("only reads the screens of the CLI it is asked about", () => {
    expect(blockingScreen("codex", CLAUDE_TRUST)).toBeNull();
    expect(blockingScreen("opencode", CODEX_TRUST)).toBeNull();
    expect(blockingScreen("opencode", ["  ┃  Ask anything… \"Fix a TODO in the codebase\""])).toBeNull();
  });
});

describe("takesInput", () => {
  it("waits for Cursor's prompt line, idle or working", () => {
    expect(takesInput("cursor", ["  Cursor Agent", "  v2026.10.01-14929f9"])).toBe(false);
    expect(takesInput("cursor", ["  │  ⏳ Trusting workspace... │"])).toBe(false);
    expect(takesInput("cursor", ["  Cursor Agent", "  → Plan, search, build anything"])).toBe(true);
    expect(takesInput("cursor", [" ⠀⠞ Working", "  → Add a follow-up        ctrl+c to stop"])).toBe(true);
  });

  it("does not gate a CLI whose screen it does not read", () => {
    expect(takesInput("claude", [])).toBe(true);
  });
});
