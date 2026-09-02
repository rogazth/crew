# Crew

A personal team of agents you message. Each agent has a model, a set of MCP servers, and a place to work. You bring the subscriptions and the machine.

Built for one person first. Later, anyone can run the same setup on a VPS with their own keys and CLIs.

## Why

Coding harnesses (T3, Claude Code) give you one agent and a repo. R3 gives you a roster, DMs, and a computer — closed, tied to one stack.

Crew is the roster product, self-hosted: persistent agents that can talk to you and to each other, tools you actually use (two Gmail accounts, Jira, …), and a VM you provide. The chat is the interface. The transcript is not the brain.

## MVP

Ship only this:

1. **Roster** — named agents. Each one has a provider/model (e.g. coder → Grok, orchestrator → Opus).
2. **Chat** — you DM an agent; agents can message each other. One room is enough.
3. **MCP catalog** — you install an *instance* once (`gmail-work`, `gmail-personal`: same package, different auth). Agents get **grants** to instances, not their own copies. One Gmail MCP, three agents, one OAuth. The Plugins screen and the agent editor are two views of the same pivot (`agent_mcp_server`).
4. **One VM** — Docker or SSH that you already have. Shared machine, per-agent working directory.
5. **Daily Tracker shape** — a routine that wakes on a cron, starts a **new episode**, asks Jira (or whatever MCP), and messages you. It does not resume a week-long thread.

Out of the MVP: marketplace, Electron, VNC, vector search, compact-as-policy, multi-user SaaS, billing other people through your Pro/Max plan.

## How context works

Three stores, never one blob:

| Store | Role | In the model? |
| --- | --- | --- |
| **Transcript** | The chat you scroll. Append-only. Searchable. | No, except the current episode |
| **Working set** | This turn: persona, a small memory slice, last K messages, this turn’s tools | Yes, budgeted |
| **Memory** | Durable facts (“ignore Icebox”, “standup at 8”) | A capped slice, always |

Live systems (Jira, Gmail) are queried, not memorized. Compact is an emergency valve on a fat episode, not the architecture.

A **routine** always opens a fresh episode. The UI can still show one timeline per agent.

## Philosophy

Convention over configuration. One process, one repo, one way.

- Name things after the product (`Agent`, `Turn`, `Memory`), not after patterns (`AgentService`).
- Many small files is fine. A junk drawer named `services/` is not.
- Extract a layer when it hurts, not on day one.
- A new feature copies an existing one. If you have to invent a folder, the feature isn’t shaped yet.

This is a majestic monolith. Not Nest modules, not hexagonal ports, not Effect event-sourcing.

## Pattern

**Resource → Action → Event → Driver**

- **Resource** — a table and a model. The nouns.
- **Action** — one class, one verb, one `handle`. The thing that happens.
- **Event** — past tense, small payload. Side effects go here, not at the bottom of four actions.
- **Driver** — anything outside the process (Claude, an MCP transport, Docker). One interface per family. A new provider is a new file plus a row, never an `if` in `StartTurn`.

```text
request → Action → models
                 → Events → Listeners / Jobs
                 → Driver  (only if the world is involved)
```

Actions do not call other actions. HTTP and the websocket are thin: parse, call an action, return. Streaming a turn is `StartTurn` subscribed to deltas, not a second protocol.

### Recipe for a new feature

1. Schema / column
2. Model (or a method on an existing model)
3. Action named as a verb
4. HTTP route or internal tool that calls that action
5. Event only if someone else must react
6. Test the action

If it doesn’t fit, it isn’t a feature yet.

## Stack

TypeScript, Node 22, Hono, React + Vite, SQLite + FTS5, official MCP SDK. Provider adapters: API keys and/or unmodified vendor CLIs (the user authenticates with the vendor, not with us).

Claude in a *custom* loop uses API keys. Consumer OAuth is for Claude Code itself, not for this runtime.

## Layout

```text
crew/
  README.md
  apps/
    server/                 # the process: HTTP, WS, jobs
    web/                    # React client
  src/                      # domain lives with the server; web imports types only
    models/                 # Agent, Message, Memory, McpServer, Routine, Turn
    actions/
      agents/               # CreateAgent, UpdateAgent
      turns/                # StartTurn, CompleteTurn
      memories/             # RememberFact, SearchTranscript
      mcp/                  # InstallMcpServer, GrantMcpToAgent, RevokeMcpFromAgent
    events/                 # TurnCompleted, AgentMessaged
    listeners/              # ExtractMemories, DeliverToPeerAgent
    jobs/                   # RunRoutine
    drivers/
      providers/            # claude-api, claude-cli, grok-cli, …
      mcp/                  # stdio, http
      vm/                   # docker, ssh
    http/                   # thin routes, one file per resource
    db/                     # schema.ts is the source of truth
```

Tables match the models: `agents`, `messages`, `memories`, `mcp_servers`, `agent_mcp_server`, `routines`, `turns`. Snake case in SQL, camelCase in TS.

### Where the loop sits

`StartTurn` is the only “orchestrator”:

1. Load the agent and its working set (profile, capped memories, this episode’s last K messages).
2. Resolve tools from bound MCP servers plus `SendMessage` and `memory.search`.
3. Call the provider driver.
4. Persist deltas as messages.
5. Emit `TurnCompleted`.

Listeners extract memories, deliver DMs to peers, and cut the episode if the token budget is blown. `RunRoutine` does not continue a chat: it inserts a turn with `kind: routine` and calls `StartTurn`.

## Omakase (do not revisit)

- One resource = model + `actions/<resource>/` + `http/<resource>.ts`
- One verb = one Action
- Outside world = Driver
- Side effect = Event + listener or job
- Memory ≠ transcript
- Routines and fat threads start a new episode
- Working set has a hard token budget
- No repository layer (SQLite is the database)
- No God object (`orchestrator.ts` is `StartTurn` with a fancier name)

## Later, not now

Public self-host docs, a marketing site, a desktop wrapper, stricter VM isolation, embeddings on top of FTS. The MVP is two agents, one room, two MCP instances, one VM, and a morning digest that does not drown in last week’s chat.
