# Harness plan — messages, mailbox, opencode, tool gateway

Living plan for the long build started 2026-09-17. Update the status table at the
bottom on every commit; this file is the memory across sessions.

## Goal

Crew is a control surface over the CLIs you already run, not a chat companion.
The agents reach you and each other through tools; the UI shows exactly which
tools ran and which commands they issued, with the quality bar of
`ai-sdk` Elements and the token language of Cursor we already have.

Five things to ship:

1. **Messages as rows** — transcripts leave `sessions.blocks_json`, land in a
   `messages` table with FTS5. Tail, search, date filter, sort, dedupe.
2. **Mailbox** — `message_agent`: agents write to each other and to you without
   a conversation. Async delivery, never a blocking RPC.
3. **opencode** — fourth provider. `opencode run --format json` is the cleanest
   protocol of the four (see `notes/opencode-protocol.jsonl`).
4. **Tool gateway** — `find_tool` / `describe_tool` / `call_tool` over an
   FTS-indexed catalog, so a hundred tools cost four entries in `tools/list`.
5. **Tool & command transparency in the UI** — the run shows what it did.

Out of scope, decided: VM control locks, handoffs, isolation, worktrees.

## Constraints

- The daemon is the single writer. No CRDT, no epoch/sequence gateway — the WS
  is ordered and there is one process. Dedupe is a client nonce, nothing more.
- No new dependencies unless a phase says so. Kumo → Base UI → local tweak.
- Every behavior gets a test. Rust in `crates/*/tests` or `#[cfg(test)]`,
  TS in `src/lib/*.test.ts` (vitest, `lib/` only — no React tests).
- Performance is a review criterion, not a later pass: if a phase changes
  something an earlier phase optimized, re-check the earlier phase.

## Workstream A — messages table (foundation)

Migration v10. Blocks stay the in-memory/rendering shape; rows are the store.

```sql
CREATE TABLE messages (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,          -- position in the transcript, 1-based
  id         TEXT NOT NULL,             -- block id, stable across edits
  role       TEXT NOT NULL,
  text       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  from_agent TEXT, to_agent TEXT,
  nonce      TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',-- tool/approval/question/usage/files
  PRIMARY KEY (session_id, seq)
);
CREATE UNIQUE INDEX messages_id_idx    ON messages (session_id, id);
CREATE UNIQUE INDEX messages_nonce_idx ON messages (session_id, nonce) WHERE nonce IS NOT NULL;
CREATE INDEX messages_at_idx           ON messages (at DESC);
CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
```

Write path: `TranscriptHub::flush` already owns the debounce and the dirty flag.
Reconcile rows there — blocks are append-mostly and ids are stable, so an upsert
keyed by `(session_id, id)` covers streaming growth and tool status changes
without rewriting the whole transcript.

RPCs: `transcript_tail {session_id, limit, before_seq}`,
`transcript_since {session_id, seq}`, `messages_search {query, session_ids?,
from?, to?, limit, cursor?}`.

`blocks_json` stays dual-written until the UI reads tail; then it is dropped in
its own migration.

## Workstream B — mailbox

`message_agent {agent_id | name, text}` in `crates/crew-core/src/tools.rs`.

- Appends to the target's transcript as `role=user, from_agent=<caller>`.
- Idle target → start a turn. Busy target → queue, deliver when the turn ends.
- Returns `{delivered: true}` immediately. A reply is another message back.
- The sender's own transcript records the outgoing message so the UI can show
  both sides.

## Workstream C — opencode provider

`opencode run --format json --auto -m <provider>/<model> [--session <id>]`.
Events: `step_start`, `text`, `tool`, `step_finish` with `tokens`/`cost`.
`sessionID` on every line is the resume token → `provider_session_id`.
Free models need no credentials, which makes it the one provider we can test
end to end in CI.

## Workstream D — tool gateway

Catalog in SQLite + FTS. `tools/list` returns the four stable entries plus the
always-on ones (`message_agent`, `search_messages`). Cursor reaches the bridge
through `crew call` with no MCP at all, so dynamic `tools/list_changed` is not
an option — the gateway is the portable answer.

## Workstream E — UI

Tool and command transparency. Design owned here, not delegated.

## Workstream F — QA

Agents test the app against each other: opencode connection, agent-to-agent
messages, edge cases, coverage.

## Tooling for this build

```bash
# grok worker (non-fast), from the repo root
cursor-agent -p "<prompt>" --model grok-4.6 --output-format text --trust -f

# opencode probe, no credentials needed
opencode run --format json --auto -m opencode/ling-3.0-flash-fin-free "<prompt>"

npm run check     # lint + tsc + vitest + react-doctor
cargo test        # rust
```

## Status

| # | Phase | State |
| --- | --- | --- |
| E0 | `ToolDetail` on the block and both tool events | done `92f77ae` |
| E0b | Claude, Codex and Cursor fill it | done `08f3ecc` |
| E1 | tool rows fold to a command and open to its output | done `08f3ecc` |
| A1 | migration v10 + `messages` + FTS5 + backfill | done `801b6b8` |
| A2 | fingerprinted dual-write from `TranscriptHub::flush` | done `801b6b8` |
| A3 | `transcript_tail` / `transcript_since` / nonce dedupe | done `801b6b8` |
| A4 | `messages_search` with bm25, dates, sessions, sort | done `801b6b8` |
| B1 | mailbox + `message_agent` + delivery callback | done `3e5319d` |
| B2 | incoming agent messages render on the left, named | done `3e5319d` |
| B3 | `from_agent` on `TurnStart`; drain the box when a turn ends | **blocked on C: both live in `turns.rs`** |
| A5 | the chat loads from `transcript_tail` instead of the whole blob | pending |
| B3 | `from_agent` on a turn; the box drains when a turn ends | done `10265f4` |
| B4 | agents are disposable; a self-message is the loop | done `10265f4` |
| C1 | opencode protocol capture + adapter | done `ea3d732` |
| C2 | opencode in the registry, with the Crew tools | done `f11a656` |
| D1 | tool catalog + `find_tool` / `call_tool` + `search_messages` | done `e9be096` |
| E2 | a message reads as a message in the sender's transcript | done `f11a656` |
| E3 | a folded phase says it failed; rows wear what they did | done `2de6918` |
| F1 | agent-to-agent QA against real CLIs (`scripts/drive.mjs`) | done `f11a656` |
| F2 | the working-directory bug that fix found | done `92ac4dc` |
| A5 | the chat loads from `transcript_tail` instead of the whole blob | **next** |

### Why A5 is still open

`transcript_get` answers from the hub's memory, so opening a chat is already
fast; what the tail saves is the wire payload and the renderer's list. The real
ceiling is that the *daemon* holds every block of every live session in memory,
and moving the client to a tail does not move that. Doing it properly means
pagination in `lib/transcript.ts` plus a "load earlier" affordance, and it
touches the streaming path — worth doing awake, with the app open.

## Known issues

- `pty::tests::concurrent_spawns_on_one_id_leave_a_single_child` fails on this
  machine and failed before any of this work started. Unrelated; still unfixed.
- Search indexes block text, which for a tool row is its title. Command output
  is stored but not indexed, on purpose: the index stays small and a query
  answers in under a millisecond.
