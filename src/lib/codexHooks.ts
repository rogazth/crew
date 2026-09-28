/**
 * Codex takes hooks and project trust on the command line (`-c`), so Crew
 * writes nothing in `~/.codex/config.toml`. Codex runs a hook only once the
 * user trusted it, by a hash of its definition that it keeps in `hooks.state`;
 * that state is passed along with the hooks, for Crew's own hooks alone. The
 * hooks are the same for every session, which names itself through the
 * terminal's CREW_SESSION_ID, so should a Codex update hash them differently
 * the user reviews them once, in Codex's own screen.
 */

/** Drops the hook's stdin in the daemon's bind folder, as Claude's do. */
export const CODEX_HOOK_COMMAND =
  'if [ -n "$CREW_CLAUDE_BIND_DIR" ] && [ -n "$CREW_SESSION_ID" ]; then f="$CREW_CLAUDE_BIND_DIR/$CREW_SESSION_ID.$(date +%s)-$$"; cat > "$f.tmp" && mv "$f.tmp" "$f.hook"; fi';

/**
 * Each event with the key Codex 0.154 files its trust under and the hash it
 * trusts: sha256 of the canonical JSON of `{event_name, hooks: [the hook with
 * its default timeout]}` (codex-rs hooks/src/engine/discovery.rs, `hook_hash`).
 * codexHooks.test.ts recomputes them.
 */
export const CODEX_HOOKS = [
  { event: "SessionStart", key: "session_start", timeout: 600, hash: "40993ec2ece8e76a2ee2dd8877090678173876f3305732d5125cacb8cdf74bd6" },
  { event: "UserPromptSubmit", key: "user_prompt_submit", timeout: 600, hash: "1f9b09c4ebc31846f66e2c2d0d2a7b2324f3acec620b3bba0afe98f15fa111a0" },
  { event: "PermissionRequest", key: "permission_request", timeout: 600, hash: "f0abd1ea17df33d2c78e519cc29c0d6c83bf7093c04ddfd1323a6b3d55c54209" },
  { event: "PostToolUse", key: "post_tool_use", timeout: 600, hash: "30e505c94d6b041b160e40b1b55c208db655f0b273586734170ae89342b4643e" },
  { event: "Stop", key: "stop", timeout: 600, hash: "02ef5fdcdf94018ab0a131e02ece53af8412c54d3d03b0e12a6117ed8fab8fb7" },
  // SessionEnd defaults to one second.
  { event: "SessionEnd", key: "session_end", timeout: 1, hash: "a293e14a5bc165408863e8b2005d45c74cc08fc830b59d71a6aee93620f184b3" },
] as const;

/** A TOML basic string. */
const toml = (text: string) => JSON.stringify(text);

/**
 * The `-c` overrides that give a Codex session Crew's hooks and trust `cwd`.
 * Codex splits a `-c` key on its dots, quoted or not, so keys holding a path
 * or a file name go in as inline tables.
 */
export function codexOverrides(cwd: string): string[] {
  const hooks = CODEX_HOOKS.flatMap(({ event }) => [
    "-c",
    `hooks.${event}=[{hooks=[{type="command",command=${toml(CODEX_HOOK_COMMAND)}}]}]`,
  ]);
  const state = CODEX_HOOKS.map(
    ({ key, hash }) => `${toml(`/<session-flags>/config.toml:${key}:0:0`)}={trusted_hash="sha256:${hash}"}`,
  ).join(",");
  return ["-c", `projects={${toml(cwd)}={trust_level="trusted"}}`, ...hooks, "-c", `hooks.state={${state}}`];
}
