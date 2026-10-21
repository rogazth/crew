# Bot memory — a trail that keeps the conversation, one way to look back, notes

Decided 2026-10-18, after reading the transcripts of bots in daily use. Update
the status table at the bottom as each phase lands.

A bot is a persistent identity and every turn is a fresh provider CLI, so
what Crew hands it at the top of the turn is all it remembers. That memory had
three parts that each failed on long, tool-heavy conversations, and bots fell
back on the one thing that always survived: their description.

## What was wrong (2026-10-18 transcripts)

- One bot rewrote its full 3.5 KB description 11 times in 13 user turns,
  mixing identity, permissions it was given, prices, ids and status. The
  description is the persona, read by the user in the bot sheet; it became a
  notebook.
- **The trail.** `working_set.rs` rendered the last `TAIL_BLOCKS = 60`
  blocks, and every tool call is a block. A turn with 30-60 tool calls (a
  browser session) pushed the user's own earlier messages out of the trail
  after one turn. Assistant replies were clipped to `MESSAGE_LIMIT = 400`
  chars; real replies average ~1,250.
- **Search.** `search_messages` answered ~12-token snippets with no
  position, so the model could not read around a hit; it indexes only
  `messages.text` (for a tool row that is its title, not its output).
- **The prompt** said "To keep something for later turns, rewrite your
  instructions with `update_description`".
- `read_session` already read any session as numbered lines with a `since`
  cursor, but copied every block of the transcript before trimming.
- Scope disagreed: `search_messages` kept a bot to its own conversation while
  `read_session` read any session in the workspace.

## Decisions

- No vectors or embeddings for now: FTS5 only. Every search is logged
  (query, hits, caller) so the need can be judged from real use.
- No pinning of the first user message: bots are used continuously, and what
  mattered on day one is rarely the first message of the transcript.
- Patterns from Hermes Agent (session search: search, a hit with a message id,
  scroll around it; a bounded `MEMORY.md` with add/patch/remove by unique
  substring, a hard character cap and a usage header) and Engram (search,
  timeline, get).

## Phases

**1. The trail** (`working_set.rs`).
- Counted by exchange, not block: a run of tool blocks between two messages
  is one line, `tools: browser_navigate x20, browser_evaluate x18, Bash x3`,
  that still says what failed or was denied. A short run (three or fewer)
  keeps its lines as before, and a message to another session or a delegation
  is never folded: it is part of the conversation.
- Still within a character budget, walking back from the newest block.
- The bot's latest reply is not clipped (up to a generous ceiling); older
  replies keep a clip, raised to fit a typical reply.
- Rendered under the transcript's lock from the blocks in memory, so the trail
  no longer depends on how many blocks a window copies.
- Test: sixty tool blocks between two user messages, and both are still there.

**2. One `read_session`.**
- `read_session {session?, query?, around?, since?, days?, roles?,
  include_tools?, max_bytes?}` replaces `search_messages` and the old
  `read_session`.
  - `session` omitted is the caller's own conversation; an id reads any
    session in the workspace, as before. A search follows the same scope.
  - Nothing else: the tail, as before.
  - `query`: FTS hits, each with `at` (the block number read_session lines
    use), when, role and a ~40-token snippet; a short message is returned
    whole. The top hit comes expanded, three blocks either side.
  - `around`: the blocks around that number, to scroll.
  - `since`: the forward cursor read, with the subagent report and `seen`
    semantics unchanged.
  - `days` without `query`: that period, oldest first.
  - `roles` defaults to user and assistant for a search; tool rows when asked
    for or with `include_tools`.
- Reads only the range it needs, sliced under the transcript's lock.
- `messages.pos` is the 1-based index of the block in the transcript, the same
  numbering read_session prints: a hit's `pos` is its `at`.
- `search_messages` goes (a bot turn is a fresh CLI; no alias). The window's
  search calls `messages::search` directly and is untouched; `crew messages
  search` becomes a verb of `read_session`, and for the user it still
  searches the whole workspace.
- The bot prompt's "Your memory": the trail is recent memory; older things
  are found with `read_session` `query`, then `around`. The description is no
  longer offered as memory.

**3. Notes.**
- A `bot_notes` table, one row per bot (migration 40; usage took 39), holding entries
  separated by `§`.
- `memory {action: show|add|patch|remove, old_text?, content?}`, for bots
  only. patch and remove match a unique substring (an ambiguous one is refused
  listing the matches); an exact duplicate is not added. Hard cap 4,000
  characters: a write over it fails and answers the current entries and usage,
  so the bot consolidates.
- Every bot turn carries `### Your notes [62% - 2,480/4,000]` and the
  entries.
- `update_description` is for identity and standing rules; its description
  and the prompt say so.
- CLI `crew bots notes [show|add|patch|remove]`, from the bot's own session.
- The bot sheet gets a notes panel the user can edit, apart from the
  description.
- Existing descriptions are not migrated.

## Status

| Phase | State |
|---|---|
| 1. The trail | done |
| 2. One `read_session` | done |
| 3. Notes | done; replaced by rules (`2026-10-21-bot-rules.md`) |
