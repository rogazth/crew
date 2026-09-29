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
