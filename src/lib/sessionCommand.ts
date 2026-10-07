import { claudeSessionId } from "./claudeStorage";
import { codexOverrides } from "./codexHooks";
import { providerOf } from "./providers";
import type { Session } from "./types";

export type ClaudeTheme = "light" | "dark";

type Options = {
  /** Claude already has a transcript for its current session. Other providers resume by `providerSessionId`. */
  resume: boolean;
  theme: ClaudeTheme;
  /** Settings bypasses permissions: the CLI runs without asking, whatever the session's access. */
  bypass?: boolean;
  /** Where it runs: Codex is told to trust it, rather than ask. */
  cwd?: string;
  /** A message the CLI starts on: the first one, or the one a relaunch carries. */
  prompt?: string;
};

/** The model, effort, service tier and access a CLI starts in: what the session's row says, as flags. */
export function optionArgs(session: Pick<Session, "provider" | "model" | "effort" | "autonomy" | "serviceTier">, bypass = false): string[] {
  const provider = providerOf(session.provider);
  if (!provider) return [];
  const access = bypass ? "full" : session.autonomy;
  const effort = provider.efforts.find((e) => e === session.effort);
  const tier = session.serviceTier ?? "";
  return [
    ...(session.model ? [provider.modelFlag, session.model] : []),
    ...(effort ? provider.effortArgs(effort) : []),
    ...(tier && provider.tierArgs ? provider.tierArgs(tier) : []),
    ...(provider.access[access] ?? provider.access.ask ?? []),
  ];
}

/**
 * argv for the provider CLI that fills a session's terminal. Crew's session id
 * doubles as Claude's until a `/clear` moves Claude to a new one, which the
 * SessionStart hook reports back; the bound id resumes on every later launch.
 * `--name` is deliberately absent: it lands as a `custom-title`, which outranks
 * the name Claude generates, so passing one means Claude never names anything.
 * Claude paints from its own configured theme and never asks the terminal, so
 * the theme is forced to match the app. Model, effort, service tier and access
 * go on every launch, a resume too: a relaunch is how a change to them reaches the CLI,
 * since its own `/model` and `/effort` would rewrite the user's defaults.
 */
export function sessionCommand(session: Session, { resume, theme, bypass = false, cwd, prompt }: Options): string[] {
  const provider = providerOf(session.provider);
  if (!provider) return [session.provider];
  const options = optionArgs(session, bypass);
  const first = prompt ? provider.promptArgs(prompt) : [];
  if (provider.binding !== "own") {
    const bound = session.providerSessionId;
    return [
      provider.binary,
      ...(provider.id === "codex" && cwd ? codexOverrides(cwd) : []),
      ...(bound ? provider.resumeArgs(bound) : []),
      ...options,
      ...first,
    ];
  }
  const argv = [provider.binary, "--settings", JSON.stringify({ theme, hooks: bindHooks(session.id) })];
  const id = claudeSessionId(session);
  argv.push(...(resume ? ["--resume", id] : ["--session-id", id]));
  return [...argv, ...options, ...first];
}

/** What the chat follows a session's CLI by: its turns, and what it stops to ask. */
const LIVE_HOOKS = [
  "UserPromptSubmit",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionDenied",
  "Stop",
  "StopFailure",
  "SessionEnd",
] as const;

/**
 * Hands each hook's stdin to the daemon's bind folder, one record per run,
 * written aside and moved in so the daemon never reads half of one; the
 * seconds and the hook's pid name it. SessionStart's `.start` carries Claude's
 * current session id, which a `/clear` changes; every hook's `.hook` (that one
 * included) tells the daemon what the CLI is doing. They print nothing:
 * SessionStart's stdout is added to the model's context, and a permission
 * hook that answers would take the decision from the user.
 */
function bindHooks(crewId: string) {
  const record = (ext: string) =>
    `if [ -n "$CREW_CLAUDE_BIND_DIR" ]; then f="$CREW_CLAUDE_BIND_DIR/${crewId}.$(date +%s)-$$"; cat > "$f.tmp" && mv "$f.tmp" "$f.${ext}"; fi`;
  const live = { hooks: [{ type: "command", command: record("hook") }] };
  return {
    SessionStart: [{ hooks: [{ type: "command", command: record("start") }] }, live],
    ...Object.fromEntries(LIVE_HOOKS.map((event) => [event, [live]])),
  };
}
