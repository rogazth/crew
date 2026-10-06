/**
 * A screen a CLI stops on before it takes a prompt: the chat cannot answer it
 * by typing a message, so it says what it is and offers the terminal.
 */
export type BlockingScreen = {
  kind: "trust" | "login" | "update" | "hooks" | "dialog";
  /** What the chat says in its place. */
  title: string;
};

type Rule = BlockingScreen & { test: RegExp };

/** Matched on the screen's text with its lines joined, as the CLI wraps it to the terminal's width. */
const RULES: Record<string, Rule[]> = {
  claude: [
    {
      kind: "trust",
      title: "Claude asks whether you trust this folder",
      test: /Is this a project you created or one you trust|Yes, I trust this folder/,
    },
    { kind: "login", title: "Claude needs you to sign in", test: /Select login method/ },
    // 2.1.284 offers it once, after the trust prompt.
    { kind: "dialog", title: "Claude offers its new fullscreen renderer", test: /Try the new fullscreen renderer\?/ },
    // Any other of its modal prompts: a message typed now would answer it.
    { kind: "dialog", title: "Claude is asking something in its terminal", test: /Enter to confirm · Esc to cancel/ },
  ],
  codex: [
    {
      kind: "trust",
      title: "Codex asks whether you trust this folder",
      test: /Do you trust the contents of this directory\?/,
    },
    { kind: "update", title: "Codex offers an update", test: /Update available!.*Update now.*Skip/ },
    { kind: "hooks", title: "Codex wants its hooks reviewed", test: /hooks need review/ },
    { kind: "login", title: "Codex needs you to sign in", test: /Sign in with ChatGPT/ },
  ],
  cursor: [
    // Answered, the box stays drawn above the prompt; only the ▶ says it still waits.
    { kind: "trust", title: "Cursor asks whether you trust this folder", test: /Workspace Trust Required.*▶ \[a\] Trust this workspace/ },
    { kind: "login", title: "Cursor needs you to sign in", test: /Press any key to log in/ },
    // It runs no hooks Crew hears, so an approval is only ever on its screen, and Enter would give it.
    { kind: "dialog", title: "Cursor asks to run a command", test: /Run this command\?.*Skip & tell the agent what to do instead/ },
    { kind: "dialog", title: "Cursor asks for an approval", test: /Skip & tell the agent what to do instead/ },
  ],
  opencode: [
    // It runs no hooks, so its permission prompt is only ever on its screen.
    { kind: "dialog", title: "opencode asks for a permission", test: /Permission required.*Allow once.*Reject/ },
  ],
};

/** The blocking screen `provider`'s CLI shows in `lines` (its visible rows), if any. */
export function blockingScreen(provider: string, lines: readonly string[]): BlockingScreen | null {
  const rules = RULES[provider];
  if (!rules) return null;
  const text = lines.join(" ").replace(/\s+/g, " ");
  const hit = rules.find((rule) => rule.test.test(text));
  return hit ? { kind: hit.kind, title: hit.title } : null;
}

/**
 * Whether `provider`'s CLI shows the line a message is typed on, where Crew
 * can tell. cursor-agent takes no keys while it starts, or loads once its
 * folder is trusted, and drops what is typed meanwhile.
 */
export function takesInput(provider: string, lines: readonly string[]): boolean {
  if (provider !== "cursor") return true;
  return lines.some((line) => /^\s*→ /.test(line));
}
