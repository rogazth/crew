import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CODEX_HOOK_COMMAND, CODEX_HOOKS, codexOverrides } from "./codexHooks";

/** Codex's `version_for_toml`: sha256 of the value as JSON with its keys sorted, no spaces. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

describe("Codex hooks", () => {
  it("carry the hash Codex trusts each one by", () => {
    for (const { key, timeout, hash } of CODEX_HOOKS) {
      const identity = {
        event_name: key,
        hooks: [{ type: "command", command: CODEX_HOOK_COMMAND, timeout, async: false }],
      };
      expect(createHash("sha256").update(canonical(identity)).digest("hex"), key).toBe(hash);
    }
  });

  it("reproduce a hash Codex 0.154 wrote itself", () => {
    // Trusted by hand in Codex's review screen; this is what it put in config.toml.
    const command =
      "cat > /tmp/claude-1000/-home-agent-crew/961306c3-d446-466c-9516-773c86bbfa34/scratchpad/cxhk/$(date +%s%N).json";
    const identity = { event_name: "stop", hooks: [{ type: "command", command, timeout: 600, async: false }] };
    expect(createHash("sha256").update(canonical(identity)).digest("hex")).toBe(
      "c16186f2008720198477865ad9c125eb8314ae6620632cd3eb575e2d0aa09414",
    );
  });

  it("trust the folder and pass every hook with its state as inline tables", () => {
    const args = codexOverrides("/w/my.repo");
    expect(args[0]).toBe("-c");
    expect(args[1]).toBe('projects={"/w/my.repo"={trust_level="trusted"}}');
    expect(args.filter((arg) => arg.startsWith("hooks.") && !arg.startsWith("hooks.state"))).toHaveLength(CODEX_HOOKS.length);
    const state = args.at(-1) ?? "";
    expect(state).toContain('"/<session-flags>/config.toml:stop:0:0"={trusted_hash="sha256:');
  });
});
