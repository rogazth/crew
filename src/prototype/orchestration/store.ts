// PROTOTYPE — orchestration UI: bots, child sessions, checkpoints, one thread per pair.
// Fake state only: every state the plan describes is a preset world, reachable directly.
import { useSyncExternalStore } from "react";
import type { Block, TurnUsage } from "../../lib/blocks";
import type { BlockTool } from "../../lib/protocol";
import type { Session, SessionStatus } from "../../lib/types";
import { pairKey } from "./labels";

/** Who a session belongs to: a child of the bot that started it, or the user's own. */
export type Owner = "me" | "user";

/** Where a child stands, as its parent's strip says it. */
export type ChildState = "working" | "waiting" | "reported" | "failed";

export type ProtoSession = Session & {
  /** For a session a bot started: its parent's name. */
  parentName?: string;
  owner?: Owner;
  childState?: ChildState;
  /** A finished turn nobody has read. */
  unread?: boolean;
  branch?: string;
};

/** Who wrote to whom, at one point in a chat. */
export type Checkpoint = {
  kind: "checkpoint";
  from: string;
  to: string;
  /** What it was: a session started, a message, a report, a steer into a running turn, a handoff. */
  what: "start" | "message" | "report" | "steer" | "handoff";
  /** For the receiver: it opened a turn, joined one already opened by another, or went into a running one.
   *  For the sender: it went out. */
  turn: "new" | "batched" | "mid" | "sent";
  text: string;
  at: number;
  failed?: boolean;
};

export type Subagent = {
  kind: "subagent";
  title: string;
  agentType: string;
  live: boolean;
  steps: { text: string; done: boolean }[];
  summary?: string;
};

/** A command the session left running in the background: it outlives the turn that started it. */
export type Task = {
  id: string;
  command: string;
  startedAt: number;
  state: "running" | "exited" | "stopped";
  exitCode?: number;
  /** What it printed, newest last: the tail the inspector shows. */
  output: string;
};

/** Where in the transcript commands went to the background: a marker that links to the tray. */
export type Background = { kind: "background"; tasks: string[] };

/** A message Crew would not deliver: no checkpoint, the reason on the row. */
export type Refused = { kind: "refused"; to: string; text: string; reason: string };

export type Mark = Checkpoint | Subagent | Background | Refused;

export type Chat = {
  blocks: Block[];
  working: boolean;
  /** What the composer sent while a turn ran, not picked up yet. */
  queued: { id: string; text: string; at: number }[];
  /** What the prototype draws in place of a block: keyed by block id. */
  marks: Record<string, Mark>;
  /** Background commands, running or finished: the tray above the composer. */
  tasks: Task[];
  /** Pairs whose thread was opened since their last message. */
  read: string[];
};

/** What covers the transcript: the thread of one pair (by `pairKey`), or one background command's output. */
export type View = { kind: "thread"; pair: string; focus: string | null } | { kind: "output"; task: string };

export type World = {
  sessions: ProtoSession[];
  chats: Record<string, Chat>;
  tabs: string[];
  active: string;
  view: View | null;
  /** The Conversations menu, open. */
  menu: boolean;
  /** The background tray, unfolded to its list. Folded by default: one row. */
  trayOpen: boolean;
  /** The "N done" group in a bot's strip, unfolded. */
  doneOpen: boolean;
};

// ——— Builders ———————————————————————————————————————————————————————————————

const T = Date.now() - 2 * 3600_000;
const min = (m: number) => T + m * 60_000;
let seq = 0;
const nid = (prefix: string) => `${prefix}-${(seq += 1)}`;

function session(id: string, kind: Session["kind"], name: string, provider: string, model: string, status: SessionStatus, extra: Partial<ProtoSession> = {}): ProtoSession {
  return {
    id,
    workspaceId: "w1",
    kind,
    name,
    provider,
    model,
    effort: "",
    providerSessionId: null,
    worktree: null,
    description: "",
    notifications: true,
    autonomy: "full",
    status,
    createdAt: min(0),
    updatedAt: min(90),
    ...extra,
  } as ProtoSession;
}

const usage = (durationMs: number): TurnUsage => ({ inputTokens: 48_200, outputTokens: 2_900, costUsd: 0.41, durationMs });

class ChatBuilder {
  chat: Chat = { blocks: [], working: false, queued: [], marks: {}, tasks: [], read: [] };
  user(text: string, at: number) {
    this.chat.blocks.push({ id: nid("u"), role: "user", text, at });
    return this;
  }
  say(text: string, at: number, ms = 95_000) {
    this.chat.blocks.push({ id: nid("a"), role: "assistant", text, at, usage: usage(ms) });
    return this;
  }
  think(text: string) {
    this.chat.blocks.push({ id: nid("r"), role: "reasoning", text });
    return this;
  }
  tool(title: string, detail: BlockTool["detail"], status: BlockTool["status"] = "completed") {
    const id = nid("t");
    this.chat.blocks.push({ id, role: "tool", text: "", tool: { callId: id, name: title, title, status, ...(detail ? { detail } : {}) } });
    return this;
  }
  /** A message that opened a turn here: a user row, so turns fold where they really start. */
  received(from: string, to: string, what: Checkpoint["what"], turn: "new" | "batched", text: string, at: number, failed = false) {
    const id = nid("in");
    this.chat.blocks.push({ id, role: "user", text, at, fromAgent: { id: from, name: from } });
    this.chat.marks[id] = { kind: "checkpoint", from, to, what, turn, text, at, ...(failed ? { failed } : {}) };
    return this;
  }
  /** A message sent from here, or one steered into the running turn: a row of the run. */
  point(from: string, to: string, what: Checkpoint["what"], turn: "sent" | "mid", text: string, at: number) {
    const id = nid("cp");
    this.chat.blocks.push({ id, role: "system", text: `${from} → ${to}`, at });
    this.chat.marks[id] = { kind: "checkpoint", from, to, what, turn, text, at };
    return this;
  }
  /** Commands sent to the background here: they join the tray, and the transcript keeps a marker. */
  background(...tasks: Omit<Task, "id">[]) {
    const ids = tasks.map((task) => {
      const id = nid("task");
      this.chat.tasks.push({ id, ...task });
      return id;
    });
    return this.mark({ kind: "background", tasks: ids });
  }
  mark(mark: Subagent | Background | Refused) {
    const id = nid("mk");
    this.chat.blocks.push({ id, role: "system", text: mark.kind });
    this.chat.marks[id] = mark;
    return this;
  }
  working() {
    this.chat.working = true;
    return this;
  }
  queue(...texts: string[]) {
    for (const text of texts) this.chat.queued.push({ id: nid("q"), text, at: Date.now() });
    return this;
  }
  done() {
    return this.chat;
  }
}

const chat = () => new ChatBuilder();

// ——— The workspace ——————————————————————————————————————————————————————————

export const LEAD = "Lead";
export const AUTH = "Auth refactor";
export const BILLING = "Billing tests";
export const PAYMENTS = "Payments v2";

const AUTH_PROMPT = `Move session signing out of the legacy module and into a file of its own.

**Scope**
- Create \`src/auth/session.ts\` with \`signSession(payload, opts)\` and \`verifySession(token)\`: the same HMAC-SHA256 as today, the same 14-day expiry.
- Replace every \`legacySign(...)\` call. There are about seven: \`rg -n "legacySign\\(" src\`.
- Delete \`legacySign\` and \`legacyVerify\` from \`src/auth/legacy.ts\` once nothing imports them.

**Constraints**
- Keep the cookie format byte for byte: sessions issued before the deploy must stay valid after it.
- Leave \`src/billing/\` alone; another session is working there.

**Done means** \`npm test -- auth\` passes and \`npm run typecheck\` is clean. Report what you ran and what it printed. Do not commit.`;

const BILLING_PROMPT = `Add tests for proration in \`src/billing/invoice.ts\`.

Cover upgrade, downgrade and cancel, each mid-cycle, monthly and annual. Prefer a small fixture builder over copy-pasted subscriptions. Don't change \`invoice.ts\` itself: if a case fails, report it, don't fix it.

Run \`npm test -- billing\` before you report. Do not commit.`;

const AUTH_REPORT = `**Done**
- New \`src/auth/session.ts\` (64 lines): \`signSession\` and \`verifySession\`, HMAC-SHA256, 14-day expiry, same cookie layout.
- Replaced \`legacySign\` in 6 call sites: \`src/api/login.ts\`, \`src/api/refresh.ts\`, \`src/api/oauth/callback.ts\`, \`src/admin/impersonate.ts\`, \`src/jobs/rotate-keys.ts\` and \`src/test/fixtures/session.ts\`.
- \`src/auth/legacy.ts\` is down to \`legacyVerify\`, still used by the middleware (see Left).

**Checked**
\`\`\`
$ npm test -- auth
 PASS  src/auth/session.test.ts (12 tests)
 PASS  src/api/login.test.ts (18 tests)
 PASS  src/api/refresh.test.ts (12 tests)
Tests:       42 passed, 42 total
$ npm run typecheck
✓ no errors
\`\`\`
I also fed a cookie minted by the old code to \`verifySession\`: it validates. I did **not** run the e2e suite.

**Left**
- \`src/middleware/session.ts\` still imports \`legacySign\` for the sliding refresh. Moving it changes the refresh window, so I stopped there.

**Questions**
1. Switch the middleware now, accepting that sessions refreshed in the next hour get a new cookie?
2. Keep the cookie name \`sid\` for one more release, or rename it to \`__Host-session\` now?`;

const BILLING_REPORT = `**Done**
- 14 tests in \`src/billing/invoice.test.ts\` covering proration:
  - upgrade mid-cycle: monthly → annual, annual → monthly, same plan with more seats
  - downgrade mid-cycle, with and without a credit balance
  - cancel mid-cycle: immediately, and at the end of the period
- A fixture builder, \`makeSubscription({ plan, startedAt, seats })\`, so each case reads as data.

**Checked**
\`\`\`
$ npm test -- billing
 PASS  src/billing/invoice.test.ts (14 tests)
Tests:       14 passed, 14 total
\`\`\`

**Left**
- Nothing in scope. Tax on prorated lines is untested; it lives in \`src/billing/tax.ts\`, outside what you asked for.`;

const FOLLOW_UP = `Thanks, this is close. Two things before I call it done:

1. Move the middleware off \`legacySign\` now. The refresh-window change is fine: a session refreshed in the next hour gets a new cookie, and the old one stays valid until it expires.
2. Keep the cookie name \`sid\` for this release. Put a \`TODO(remove-after: 2026-11-01)\` next to it; I'll schedule the rename.

When that's in, delete \`legacySign\` and \`legacyVerify\` from \`src/auth/legacy.ts\`, rerun \`npm test -- auth\` and \`npm run typecheck\`, and report again with the output.`;

const STEER = `Stop before the tests: the sessions table was renamed this morning.

- It's \`users_v2\` now, not \`users\` (migration \`0042_users_v2.sql\`, merged at 09:12).
- \`verifySession\` reads \`users.session_epoch\`; point it at \`users_v2.session_epoch\`.
- The column went from \`int\` to \`bigint\`, so the comparison in \`isRevoked()\` needs \`BigInt(...)\` on both sides.

Then run the tests as planned.`;

const DIRECT = `Also keep the old cookie name \`sid\` working for one release: read both \`sid\` and \`__Host-session\`, write only \`__Host-session\`. Support tickets mention people with two tabs open, so don't log anyone out on deploy.`;

const HANDOFF = `Implement the Payments v2 plan in \`docs/plans/payments-v2.md\` on this branch, starting with the checkout flow.

- The plan's step 1 (checkout on the new API) and step 2 (webhook retries through the queue) are independent; the user wants step 1 first.
- \`src/payments/legacy-client.ts\` stays until step 3.

The user takes it from here: report to them, not to me.`;

const FAILED_REPORT = `**Done**
- 14 tests in \`src/billing/invoice.test.ts\` for upgrade, downgrade and cancel mid-cycle.

**Checked**
\`\`\`
$ npm test -- billing
 FAIL  src/billing/invoice.test.ts
  ✕ downgrade mid-cycle, annual → monthly (12 ms)
    Expected: 1450
    Received: 1449
Tests:       1 failed, 13 passed, 14 total
\`\`\`
The failure is real, not the test: \`prorate()\` rounds each day's credit with \`Math.floor\` before summing, so a 31-day month loses a cent.

**Questions**
1. Round half up, or half to even? Finance's spreadsheet uses half to even.
2. Fix \`prorate()\` here, or leave it to a separate session? You said not to change \`invoice.ts\`.`;

const devTask = (): Omit<Task, "id"> => ({
  command: "npm run dev",
  startedAt: min(61),
  state: "running",
  output: `> storefront@4.2.0 dev
> vite --port 3000

  VITE v7.3.6  ready in 812 ms
  ➜  Local:   http://localhost:3000/
14:02:11 [vite] page reload src/checkout/discounts.ts
14:02:40 [vite] hmr update /src/checkout/Cart.tsx
14:03:02 GET /api/checkout/quote 200 in 1843ms
14:03:05 GET /api/checkout/quote 200 in 1911ms
14:03:09 GET /api/tax/rates?region=CL 200 in 46ms (x40)`,
});

const profileTask = (): Omit<Task, "id"> => ({
  command: "npm run profile:checkout",
  startedAt: min(62),
  state: "running",
  output: `> storefront@4.2.0 profile:checkout
> node scripts/profile.mjs --route /api/checkout/quote --runs 50

run  10/50  p50 1.82s  p95 2.31s
run  20/50  p50 1.84s  p95 2.29s
run  30/50  p50 1.83s  p95 2.35s
  hottest: applyDiscounts  71.4%
           fetchTaxRates   64.9%  (40 calls / request)
           renderQuote      3.1%`,
});

const analyzeTask = (): Omit<Task, "id"> => ({
  command: "npm run build -- --analyze",
  startedAt: min(61),
  state: "exited",
  exitCode: 0,
  output: `> storefront@4.2.0 build
> vite build --analyze

✓ 1204 modules transformed.
dist/assets/checkout-3f9a1c.js   182.40 kB │ gzip: 58.12 kB
dist/assets/vendor-91bd02.js     412.77 kB │ gzip: 131.03 kB
✓ built in 9.81s
Report written to dist/stats.html`,
});

function baseSessions(): ProtoSession[] {
  return [
    session("lead", "agent", LEAD, "claude", "claude-opus-5", "idle", { description: "Plans work and hands it out." }),
    session("reviewer", "agent", "Reviewer", "codex", "gpt-5", "idle"),
    session("auth", "child", AUTH, "claude", "claude-sonnet-5", "working", { parentId: "lead", parentName: LEAD, owner: "me", childState: "working", branch: "feat/auth-refactor" }),
    session("billing", "child", BILLING, "codex", "gpt-5", "working", { parentId: "lead", parentName: LEAD, owner: "me", childState: "working", branch: "test/billing" }),
    session("docs", "child", "Docs pass", "claude", "claude-sonnet-5", "idle", { parentId: "reviewer", parentName: "Reviewer", owner: "me", childState: "reported" }),
    session("term", "terminal", "claude", "claude", "claude-sonnet-5", "idle"),
  ];
}

/** Lead's first turn: two sessions started, each one a checkpoint. */
function delegate(c: ChatBuilder, live: boolean) {
  c.user("Split the auth refactor and the billing tests into two sessions, each in its own worktree. Tell me when both are done.", min(0))
    .think("Two independent jobs; each gets its own worktree so they cannot collide.")
    .tool("Read", { kind: "file", path: "docs/plans/auth.md" })
    .point(LEAD, AUTH, "start", "sent", AUTH_PROMPT, min(1))
    .point(LEAD, BILLING, "start", "sent", BILLING_PROMPT, min(1));
  if (live) return c.working();
  return c.say(`Started two sessions: **${AUTH}** in \`feat/auth-refactor\` and **${BILLING}** in \`test/billing\`. I'll pick this up when their reports come in.`, min(2), 80_000);
}

/** Both reports land together: one turn, two checkpoints. */
function reviewBoth(c: ChatBuilder, live: boolean) {
  c.received(AUTH, LEAD, "report", "new", AUTH_REPORT, min(38))
    .received(BILLING, LEAD, "report", "batched", BILLING_REPORT, min(38))
    .tool("Bash", { kind: "command", command: "git -C ../feat-auth-refactor diff --stat", output: " 7 files changed, 112 insertions(+), 96 deletions(-)" })
    .tool("Bash", { kind: "command", command: "npm test -- billing", output: "Tests: 14 passed, 14 total" })
    .tool("Search", { kind: "search", query: "legacySign", matches: 1 });
  if (live) return c.working();
  return c
    .point(LEAD, AUTH, "message", "sent", FOLLOW_UP, min(40))
    .say(`**${BILLING}** is in and green. **${AUTH}** left one import of \`legacySign\`; I sent it back to remove it, and kept the old cookie name for a release. Waiting on its next report.`, min(40), 120_000);
}

/** Lead asks another bot: a third pair in Lead's chat, bot to bot. */
function askReviewer(c: ChatBuilder) {
  return c
    .point(LEAD, "Reviewer", "message", "sent", `Can you review \`feat/auth-refactor\` once Auth refactor reports again? Focus on:

- the cookie compatibility (\`sid\` read, \`__Host-session\` written);
- \`isRevoked()\` after the \`bigint\` change;
- anything in \`src/middleware/session.ts\` that changes the refresh window.

No need to run e2e; I'll do that before merging.`, min(43))
    .received("Reviewer", LEAD, "message", "new", `Sure. I'll pick it up when the branch settles. One thing to decide first: \`__Host-\` cookies require \`Secure\` and \`Path=/\` and no \`Domain\`. The admin app on \`admin.storefront.dev\` reads the session cookie today, so the rename breaks it unless admin gets its own login. Do you want me to flag that in the review or is it already planned?`, min(47))
    .say("Reviewer raised a real one: renaming to `__Host-session` locks out the admin subdomain. Keeping `sid` this release covers it; I'll plan the admin login before the rename.", min(48), 40_000);
}

function authChat(state: "first" | "follow" | "steer" | "user") {
  const c = chat()
    .received(LEAD, AUTH, "start", "new", AUTH_PROMPT, min(1))
    .think("Find every caller first.")
    .tool("Search", { kind: "search", query: "legacySign", matches: 7 })
    .tool("Edit", { kind: "edit", path: "src/auth/session.ts", added: 64, removed: 0 })
    .tool("Edit", { kind: "edit", path: "src/auth/legacy.ts", added: 2, removed: 58 })
    .tool("Bash", { kind: "command", command: "npm test -- auth", output: "Tests: 42 passed, 42 total" })
    .say(AUTH_REPORT, min(37), 2_100_000);
  if (state === "first") return c.done();
  if (state === "user") {
    return c
      .user(DIRECT, min(39))
      .think("The user asked directly; Lead will see this in its thread.")
      .tool("Edit", { kind: "edit", path: "src/auth/cookies.ts", added: 6, removed: 1 }, "pending")
      .working()
      .done();
  }
  c.received(LEAD, AUTH, "message", "new", FOLLOW_UP, min(40))
    .tool("Edit", { kind: "edit", path: "src/middleware/session.ts", added: 3, removed: 4 });
  if (state === "steer") {
    c.tool("Bash", { kind: "command", command: "npm test -- auth" }, "pending")
      .point(LEAD, AUTH, "steer", "mid", STEER, min(42))
      .think("Redirected mid-turn: switch the table before the tests finish.")
      .tool("Edit", { kind: "edit", path: "src/auth/session.ts", added: 2, removed: 2 }, "pending");
  }
  return c.working().done();
}

function billingChat(failed = false) {
  const c = chat()
    .received(LEAD, BILLING, "start", "new", BILLING_PROMPT, min(1))
    .tool("Read", { kind: "file", path: "src/billing/invoice.ts" })
    .tool("Edit", { kind: "edit", path: "src/billing/invoice.test.ts", added: 186, removed: 0 });
  if (failed) {
    return c
      .tool("Bash", { kind: "command", command: "npm test -- billing", exitCode: 1, output: "FAIL src/billing/invoice.test.ts\n  ✕ downgrade mid-cycle (12 ms)\n    Expected: 1450, Received: 1449" }, "failed")
      .say(FAILED_REPORT, min(36), 1_900_000)
      .done();
  }
  return c.tool("Bash", { kind: "command", command: "npm test -- billing", output: "Tests: 14 passed, 14 total" }).say(BILLING_REPORT, min(35), 1_900_000).done();
}

function paymentsChat() {
  return chat()
    .received(LEAD, PAYMENTS, "handoff", "new", HANDOFF, min(50))
    .tool("Read", { kind: "file", path: "docs/plans/payments-v2.md" })
    .say("Read the plan. Before I start: should the webhook retries move to the queue now, or in a second step?", min(51), 40_000)
    .user("Second step. Start with the checkout flow.", min(55))
    .tool("Edit", { kind: "edit", path: "src/payments/checkout.ts", added: 140, removed: 32 })
    .tool("Bash", { kind: "command", command: "npm test -- payments", output: "Tests: 23 passed, 23 total" })
    .say("Checkout flow is on the new API, tests green (23). Webhook retries are untouched for the second step.", min(88), 1_500_000)
    .done();
}

function world(partial: Partial<World> & { chats: Record<string, Chat> }): World {
  return {
    sessions: baseSessions(),
    tabs: ["lead", "term"],
    active: "lead",
    view: null,
    menu: false,
    trayOpen: false,
    doneOpen: false,
    ...partial,
  };
}

function setSession(w: World, id: string, patch: Partial<ProtoSession>) {
  w.sessions = w.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
  return w;
}

/** A story about one chat's own work: Lead's children would only be noise in it. */
function alone(w: World) {
  w.sessions = w.sessions.filter((s) => s.parentId !== "lead");
  return w;
}

function addSession(w: World, s: ProtoSession) {
  w.sessions = [...w.sessions, s];
  return w;
}

const payments = (status: SessionStatus, unread: boolean) =>
  session("payments", "terminal", PAYMENTS, "claude", "claude-opus-5", status, { owner: "user", parentName: LEAD, unread, branch: "feat/payments-v2", worktree: "/Users/me/.crew/worktrees/storefront/feat-payments-v2" });

// ——— States ——————————————————————————————————————————————————————————————

export type State = { id: string; group: string; title: string; note: string; build: () => World };

export const STATES: State[] = [
  {
    id: "delegating",
    group: "Delegate",
    title: "Lead starts two sessions",
    note: "Each start_session is a checkpoint, Lead → Auth refactor, that opens their thread. The children are not in the sidebar: they appear in Lead's Sessions strip.",
    build: () => {
      const w = world({ chats: { lead: delegate(chat(), true).done(), auth: authChat("first"), billing: billingChat() } });
      setSession(w, "lead", { status: "working" });
      return w;
    },
  },
  {
    id: "children-running",
    group: "Delegate",
    title: "Lead idle while a session works",
    note: "Billing reported and woke Lead; Lead answered and ended its turn. Auth refactor still works: the strip in Lead's chat says so, the sidebar doesn't.",
    build: () => {
      const lead = delegate(chat(), false)
        .received(BILLING, LEAD, "report", "new", BILLING_REPORT, min(35))
        .tool("Bash", { kind: "command", command: "npm test -- billing", output: "Tests: 14 passed, 14 total" })
        .say(`**${BILLING}** is done: 14 tests, all green. Still waiting on **${AUTH}**.`, min(36), 60_000)
        .done();
      const w = world({ chats: { lead, auth: authChat("first"), billing: billingChat() } });
      return setSession(w, "billing", { status: "idle", childState: "reported" });
    },
  },
  {
    id: "reports-batched",
    group: "Reports",
    title: "Two reports wake Lead in one turn",
    note: "Both finished while Lead was busy: one turn opens with both checkpoints, each just who → whom. Lead is reviewing.",
    build: () => {
      const lead = reviewBoth(delegate(chat(), false), true).done();
      const w = world({ chats: { lead, auth: authChat("first"), billing: billingChat() } });
      setSession(w, "lead", { status: "working" });
      setSession(w, "auth", { status: "idle", childState: "reported" });
      return setSession(w, "billing", { status: "idle", childState: "reported" });
    },
  },
  {
    id: "thread",
    group: "Reports",
    title: "A pair's thread, opened from a checkpoint",
    note: "One thread per pair: Lead ⇄ Auth refactor. Clicking its report in the chat opens the thread already at that message. Esc or Close goes back.",
    build: () => {
      const lead = askReviewer(reviewBoth(delegate(chat(), false), false)).done();
      const focus = Object.entries(lead.marks).find(([, m]) => m.kind === "checkpoint" && m.what === "report")?.[0] ?? null;
      const w = world({ chats: { lead, auth: authChat("follow"), billing: billingChat() }, view: { kind: "thread", pair: pairKey(LEAD, AUTH), focus } });
      return setSession(w, "billing", { status: "idle", childState: "reported" });
    },
  },
  {
    id: "conversations",
    group: "Reports",
    title: "Conversations: one thread per pair",
    note: "Lead has spoken with three peers: Auth refactor, Billing tests and the Reviewer bot. Each is its own thread; the dot marks the one with a message Lead hasn't opened.",
    build: () => {
      const lead = askReviewer(reviewBoth(delegate(chat(), false), false)).done();
      lead.read = [pairKey(LEAD, AUTH), pairKey(LEAD, BILLING)];
      const w = world({ chats: { lead, auth: authChat("follow"), billing: billingChat() }, menu: true });
      return setSession(w, "billing", { status: "idle", childState: "reported" });
    },
  },
  {
    id: "steer-sent",
    group: "Steer",
    title: "Lead steers a running session",
    note: "send_message with steer goes into Auth refactor's running turn. The checkpoint still says only Lead → Auth refactor.",
    build: () => {
      const lead = reviewBoth(delegate(chat(), false), false)
        .user("Heads up: the sessions table was renamed to users_v2 this morning.", min(41))
        .point(LEAD, AUTH, "steer", "mid", STEER, min(42))
        .say(`Told **${AUTH}** mid-turn; it was about to run the tests against the old table.`, min(42), 20_000)
        .done();
      const w = world({ chats: { lead, auth: authChat("steer"), billing: billingChat() } });
      return setSession(w, "billing", { status: "idle", childState: "reported" });
    },
  },
  {
    id: "steer-received",
    group: "Steer",
    title: "The child receives the steer",
    note: "Auth refactor's own chat: the steer lands inside the running turn, between two tool calls. The bar: who started it, and its one conversation.",
    build: () => {
      const lead = reviewBoth(delegate(chat(), false), false).done();
      const w = world({ chats: { lead, auth: authChat("steer"), billing: billingChat() }, tabs: ["lead", "auth", "term"], active: "auth" });
      return setSession(w, "billing", { status: "idle", childState: "reported" });
    },
  },
  {
    id: "user-to-child",
    group: "Steer",
    title: "You write to Lead's child directly",
    note: "Allowed. Open Lead's tab: its chat shows You → Auth refactor at that point, and Conversations has that pair.",
    build: () => {
      const lead = delegate(chat(), false)
        .point("You", AUTH, "message", "sent", DIRECT, min(39))
        .done();
      return world({ chats: { lead, auth: authChat("user"), billing: billingChat() }, tabs: ["lead", "auth", "term"], active: "auth" });
    },
  },
  {
    id: "subagents",
    group: "Activity",
    title: "Native subagent and background commands",
    note: "The harness's own subagent is a nested block with live steps. Commands sent to the background get a tray above the composer that survives scrolling; the transcript keeps a small marker that opens them.",
    build: () => {
      const lead = chat()
        .user("Checkout got slow after yesterday's deploy. Find out why.", min(60))
        .think("Profile it and read the deploy diff in parallel.")
        .background(devTask(), profileTask())
        .tool("Bash", { kind: "command", command: "git log --oneline -8 origin/main", output: "a1c9e2f perf: cache tax rates\n7b21d0c feat: line-item discounts" })
        .mark({
          kind: "subagent",
          title: "Read yesterday's deploy diff for checkout",
          agentType: "Explore",
          live: true,
          steps: [
            { text: "git diff 7b21d0c^..a1c9e2f -- src/checkout", done: true },
            { text: "Read src/checkout/discounts.ts", done: true },
            { text: "Search: applyDiscounts(", done: false },
          ],
        })
        .working()
        .done();
      const w = alone(world({ chats: { lead } }));
      return setSession(w, "lead", { status: "working" });
    },
  },
  {
    id: "background-wait",
    group: "Activity",
    title: "Turn over, 2 commands still running",
    note: "The turn ended with two commands still running. The tray above the composer is one folded row, Background · 2 running; unfold it to stop or open each. The tab shows a dashed ring and the count; the sidebar says nothing.",
    build: () => {
      const lead = chat()
        .user("Checkout got slow after yesterday's deploy. Find out why.", min(60))
        .background(devTask(), profileTask(), analyzeTask())
        .mark({
          kind: "subagent",
          title: "Read yesterday's deploy diff for checkout",
          agentType: "Explore",
          live: false,
          steps: [
            { text: "git diff 7b21d0c^..a1c9e2f -- src/checkout", done: true },
            { text: "Read src/checkout/discounts.ts", done: true },
            { text: "Search: applyDiscounts(", done: true },
          ],
          summary: "applyDiscounts runs once per line item and refetches tax rates each time.",
        })
        .say("`applyDiscounts` now runs once per line item and refetches tax rates every time: 40 items means 40 requests. The profiler is still running; I'll confirm with its numbers when it finishes.", min(66), 340_000)
        .done();
      const w = alone(world({ chats: { lead } }));
      return setSession(w, "lead", { status: "idle" });
    },
  },
  {
    id: "background-output",
    group: "Activity",
    title: "Inspecting a background command",
    note: "Inspect opens the command's output over the transcript, like the thread: its tail, live, with Stop at hand.",
    build: () => {
      const w = STATES.find((state) => state.id === "background-wait")!.build();
      const task = w.chats.lead!.tasks[1]!.id;
      return { ...w, trayOpen: true, view: { kind: "output", task } };
    },
  },
  {
    id: "background-expanded",
    group: "Activity",
    title: "The background tray, unfolded",
    note: "Folded it is one row, Background · 2 running. Unfolded: each command with its state; click a row for its output, Stop to end it.",
    build: () => ({ ...STATES.find((state) => state.id === "background-wait")!.build(), trayOpen: true }),
  },
  {
    id: "queued",
    group: "Composer",
    title: "Messages queued while a turn runs",
    note: "Sent while Lead works: the bubbles stack dimmed under the working line, with one Queued label for the group.",
    build: () => {
      const lead = reviewBoth(delegate(chat(), false), true).queue("Also check the billing tests cover refunds.", "And ask Auth refactor to keep the old cookie name.").done();
      const w = world({ chats: { lead, auth: authChat("first"), billing: billingChat() } });
      setSession(w, "auth", { status: "idle", childState: "reported" });
      setSession(w, "billing", { status: "idle", childState: "reported" });
      return setSession(w, "lead", { status: "working" });
    },
  },
  {
    id: "queued-taken",
    group: "Composer",
    title: "The queued messages are picked up",
    note: "The turn that takes them starts: the Queued label is gone, they read as your messages.",
    build: () => {
      const lead = reviewBoth(delegate(chat(), false), false)
        .user("Also check the billing tests cover refunds.", min(41))
        .user("And ask Auth refactor to keep the old cookie name.", min(41))
        .tool("Search", { kind: "search", query: "refund", matches: 0 })
        .working()
        .done();
      const w = world({ chats: { lead, auth: authChat("follow"), billing: billingChat() } });
      setSession(w, "billing", { status: "idle", childState: "reported" });
      return setSession(w, "lead", { status: "working" });
    },
  },
  {
    id: "handoff",
    group: "Handoff",
    title: "A handoff finished, unread",
    note: "owner: user — top-level in the sidebar like any session of yours, no report to Lead. Finished and unread: the blue dot. Open it to read.",
    build: () => {
      const lead = delegate(chat(), false)
        .user("Hand the Payments v2 plan to a new session on its own branch; I'll drive that one.", min(49))
        .point(LEAD, PAYMENTS, "handoff", "sent", HANDOFF, min(50))
        .say(`Opened **${PAYMENTS}** on \`feat/payments-v2\`. It's yours now; it won't report back to me.`, min(50), 15_000)
        .done();
      const w = world({ chats: { lead, payments: paymentsChat(), auth: authChat("first"), billing: billingChat() }, tabs: ["lead", "payments", "term"] });
      return addSession(w, payments("done", true));
    },
  },
  {
    id: "rejected",
    group: "Errors",
    title: "Messages Crew refuses",
    note: "To itself, to another bot's child, to a terminal: the call fails with the reason, and no checkpoint is drawn.",
    build: () => {
      const lead = chat()
        .user("Remind yourself in an hour, tell Docs pass to hurry, and ping my terminal.", min(70))
        .mark({ kind: "refused", to: `${LEAD} (itself)`, text: "Check back in an hour.", reason: "You can't message yourself. To come back later, save a routine with schedule once." })
        .mark({ kind: "refused", to: "Docs pass", text: "Please hurry.", reason: "Docs pass is Reviewer's session. Write to Reviewer instead." })
        .mark({ kind: "refused", to: "claude (terminal)", text: "Done.", reason: "A terminal has no turns to deliver to." })
        .tool("Crew", { kind: "mcp", server: "crew", tool: "save_routine", input: '{"name": "Check back", "schedule": {"kind": "once", "at": "15:30"}}', output: "Saved. Runs once at 15:30." })
        .say("I can't write to myself, so I saved a one-off routine for 15:30. Docs pass belongs to Reviewer, and your terminal can't receive messages; tell me if you want me to ask Reviewer.", min(71), 30_000)
        .done();
      return alone(world({ chats: { lead } }));
    },
  },
  {
    id: "done-collapsed",
    group: "Strip",
    title: "Reported sessions fold into “3 done”",
    note: "After Lead's next turn ends without writing to them, reported children fold into one chip. Click it to unfold.",
    build: () => {
      const lead = reviewBoth(delegate(chat(), false), false)
        .received(AUTH, LEAD, "report", "new", "**Done**\n- `src/middleware/session.ts` uses `signSession`; `legacySign` and `legacyVerify` are gone.\n- `sid` is still read, with `TODO(remove-after: 2026-11-01)`.\n\n**Checked**\n```\n$ npm test -- auth\nTests:       44 passed, 44 total\n$ npm run typecheck\n✓ no errors\n```", min(55))
        .point(LEAD, "Fix flaky e2e", "start", "sent", "Find why `checkout.e2e.ts` fails one run in five and fix it.", min(56))
        .say("Auth refactor is done. Started **Fix flaky e2e** for the checkout test.", min(56), 30_000)
        .done();
      const w = world({ chats: { lead, auth: authChat("follow"), billing: billingChat() } });
      setSession(w, "auth", { status: "idle", childState: "reported" });
      setSession(w, "billing", { status: "idle", childState: "reported" });
      addSession(w, session("lint", "child", "Lint sweep", "codex", "gpt-5", "idle", { parentId: "lead", parentName: LEAD, owner: "me", childState: "reported" }));
      return addSession(w, session("e2e", "child", "Fix flaky e2e", "claude", "claude-sonnet-5", "working", { parentId: "lead", parentName: LEAD, owner: "me", childState: "working" }));
    },
  },
  {
    id: "child-failed",
    group: "Strip",
    title: "A child reports a failure",
    note: "Billing tests ended with a failing test and a question. The strip shows it failed; the checkpoint carries the report.",
    build: () => {
      const lead = delegate(chat(), false)
        .received(BILLING, LEAD, "report", "new", FAILED_REPORT, min(36), true)
        .say("**Billing tests** found a real rounding bug in downgrades. That's a product call: round half up, or half to even?", min(37), 25_000)
        .done();
      const w = world({ chats: { lead, auth: authChat("first"), billing: billingChat(true) } });
      return setSession(w, "billing", { status: "error", childState: "failed" });
    },
  },
];

// ——— Store ———————————————————————————————————————————————————————————————————

type Snapshot = { index: number; world: World; theme: "system" | "light" | "dark" };

/** `?state=<id>` opens a state directly, and the address follows the switcher, so a state can be linked. */
const linked = Math.max(0, STATES.findIndex((state) => state.id === new URLSearchParams(location.search).get("state")));
let snapshot: Snapshot = { index: linked, world: STATES[linked]!.build(), theme: "system" };
const listeners = new Set<() => void>();

function set(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useProto(): Snapshot {
  return useSyncExternalStore(subscribe, () => snapshot);
}

function update(change: (world: World) => World) {
  set({ ...snapshot, world: change(snapshot.world) });
}

export const proto = {
  go(index: number) {
    const at = (index + STATES.length) % STATES.length;
    history.replaceState(null, "", `?state=${STATES[at]!.id}`);
    set({ ...snapshot, index: at, world: STATES[at]!.build() });
  },
  step(delta: number) {
    proto.go(snapshot.index + delta);
  },
  theme(theme: Snapshot["theme"]) {
    document.documentElement.style.colorScheme = theme === "system" ? "" : theme;
    set({ ...snapshot, theme });
  },
  open(id: string) {
    update((w) => ({
      ...w,
      active: id,
      tabs: w.tabs.includes(id) ? w.tabs : [...w.tabs.slice(0, 1), id, ...w.tabs.slice(1)],
      // Opening a finished session is reading it.
      sessions: w.sessions.map((s) => (s.id === id && s.unread ? { ...s, unread: false, status: "idle" } : s)),
      view: null,
    }));
  },
  close(id: string) {
    update((w) => {
      const tabs = w.tabs.filter((tab) => tab !== id);
      return { ...w, tabs, active: w.active === id ? (tabs[0] ?? "lead") : w.active };
    });
  },
  /** Opens a pair's thread, at a message or at its newest; opening it is reading it. */
  thread(pair: string, focus: string | null = null) {
    update((w) => {
      const current = w.chats[w.active];
      const chats = current && !current.read.includes(pair) ? { ...w.chats, [w.active]: { ...current, read: [...current.read, pair] } } : w.chats;
      return { ...w, chats, menu: false, view: { kind: "thread", pair, focus } };
    });
  },
  menu(open: boolean) {
    update((w) => ({ ...w, menu: open }));
  },
  tray(open: boolean) {
    update((w) => ({ ...w, trayOpen: open }));
  },
  output(task: string) {
    update((w) => ({ ...w, view: { kind: "output", task } }));
  },
  closeView() {
    update((w) => ({ ...w, view: null }));
  },
  stopTask(task: string) {
    update((w) => {
      const id = w.active;
      const current = w.chats[id];
      if (!current) return w;
      const tasks = current.tasks.map((t) =>
        t.id === task && t.state === "running" ? { ...t, state: "stopped" as const, output: `${t.output}\n^C\nStopped from Crew.` } : t,
      );
      return { ...w, chats: { ...w.chats, [id]: { ...current, tasks } } };
    });
  },
  toggleDone() {
    update((w) => ({ ...w, doneOpen: !w.doneOpen }));
  },
  send(text: string) {
    update((w) => {
      const id = w.active;
      const current = w.chats[id] ?? { blocks: [], working: false, queued: [], marks: {}, tasks: [], read: [] };
      // A turn running: the message waits its turn, as the CLI holds it.
      const next: Chat = current.working
        ? { ...current, queued: [...current.queued, { id: nid("q"), text, at: Date.now() }] }
        : { ...current, working: true, blocks: [...current.blocks, { id: nid("u"), role: "user", text, at: Date.now() }] };
      return { ...w, chats: { ...w.chats, [id]: next } };
    });
  },
  /** The CLI takes what was queued: they become the next turn's messages. */
  takeQueued() {
    update((w) => {
      const id = w.active;
      const current = w.chats[id];
      if (!current || current.queued.length === 0) return w;
      const taken: Block[] = current.queued.map((q) => ({ id: nid("u"), role: "user", text: q.text, at: Date.now() }));
      return { ...w, chats: { ...w.chats, [id]: { ...current, queued: [], working: true, blocks: [...current.blocks, ...taken] } } };
    });
  },
  stop() {
    update((w) => {
      const current = w.chats[w.active];
      if (!current) return w;
      return { ...w, chats: { ...w.chats, [w.active]: { ...current, working: false, queued: [] } } };
    });
  },
};
