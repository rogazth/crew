// PROTOTYPE — throwaway. The threads the header variants are drawn over:
// the case the user reported, a running writable session, a grandchild,
// and names long enough to break a line.

export type Level = { id: string; name: string; provider: string; bot: boolean };

export type Case = {
  key: string;
  label: string;
  /** The sessions above the thread, outermost first; the last one holds it. */
  crumbs: Level[];
  title: string;
  provider: string;
  kind: "subagent" | "session";
  model: string;
  state: "running" | "done" | "failed";
  elapsed: string;
  tokens?: string;
  writable: boolean;
  branch?: string;
  /** What the parent's chat says, behind the thread. */
  parentLines: string[];
  /** The handoff letter that opens the thread. */
  handoff: string;
};

const orchestrator: Level = { id: "orch", name: "orchestrator", provider: "claude", bot: true };
const refunds: Level = { id: "refunds", name: "refunds-api", provider: "codex", bot: false };

export const CASES: Case[] = [
  {
    key: "reported",
    label: "Done · read-only (the reported case)",
    crumbs: [{ id: "oc3", name: "opencode 3", provider: "opencode", bot: false }],
    title: "haiku long report test",
    provider: "claude",
    kind: "subagent",
    model: "claude-haiku-5-5",
    state: "done",
    elapsed: "31s",
    tokens: "12.4k",
    writable: false,
    parentLines: [
      "I'll hand the long report to a haiku subagent and read its summary when it lands.",
      "Started a subagent · haiku long report test",
    ],
    handoff:
      "Write a long report on the session store: how a turn is persisted, where compaction happens, and what the replay path reads back. Keep it under 2,000 words and end with a list of open questions.",
  },
  {
    key: "running",
    label: "Running · writable session",
    crumbs: [orchestrator],
    title: "refunds-api",
    provider: "codex",
    kind: "session",
    model: "gpt-5.5-codex",
    state: "running",
    elapsed: "2m 14s",
    writable: true,
    branch: "feat/partial-refunds",
    parentLines: [
      "Splitting this in two: refunds-api takes the handler, billing-ui the copy.",
      "Started a session · refunds-api",
    ],
    handoff:
      "Add partial refunds to the refunds handler. Keep the 90-day rule from policy.rs and reuse RefundError::TooOld. Run cargo test -p api refunds before you report.",
  },
  {
    key: "nested",
    label: "Nested · grandchild running · read-only",
    crumbs: [orchestrator, refunds],
    title: "Explore webhook fixtures",
    provider: "claude",
    kind: "subagent",
    model: "claude-haiku-5-5",
    state: "running",
    elapsed: "48s",
    tokens: "6.1k",
    writable: false,
    parentLines: ["Reading the webhook tests before touching the handler.", "Started a subagent · Explore webhook fixtures"],
    handoff: "Find every fixture the webhook tests load, and which of them assert a full refund amount.",
  },
  {
    key: "long",
    label: "Long names · nested · done · writable",
    crumbs: [
      { id: "orch-q", name: "quarterly-billing-migration-orchestrator", provider: "claude", bot: true },
      { id: "refunds-l", name: "refunds-api-partial-refunds-and-webhooks", provider: "codex", bot: false },
    ],
    title: "Investigate why the webhook integration test asserts a full refund amount instead of a partial one",
    provider: "cursor",
    kind: "session",
    model: "composer-2",
    state: "done",
    elapsed: "6m 02s",
    writable: true,
    branch: "fix/webhook-partial-amount-assertion",
    parentLines: ["Handing the flaky webhook assertion to its own session.", "Started a session · Investigate why the webhook…"],
    handoff: "The webhook integration test asserts a full amount. Find out why and fix the assertion, not the handler.",
  },
];

export const metaOf = (c: Case) => {
  const parent = c.crumbs.at(-1)!;
  const parts = [c.kind === "subagent" ? "Subagent" : "Session", c.model];
  parts.push(c.kind === "subagent" ? `reports to ${parent.name}` : `started by ${parent.name}`);
  return parts.join(" · ");
};

export const stateLabel = (c: Case) => c.state[0]!.toUpperCase() + c.state.slice(1);
