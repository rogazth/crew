# Five minutes of Crew

What to show, in the order that makes the point. Every step here was run
headless first — the commands under each one are the same behaviour without
the window, so nothing in this file is a claim the repo cannot back.

Before anything: `cargo build -p crewd && npm run app`.

## 1. The roster is the product (30s)

Open the app. The sidebar is a list of agents, not a list of chats: each one
names a provider and a model — Claude, Codex, Cursor, opencode. `Ctrl+N` makes
another. The point to say out loud: **these are the CLIs you already pay for,
with one surface over them.**

## 2. Chat with one, and watch it work (90s)

Ask the Claude agent for something real:

> Write a file called greet.js with a greet(name) function, run it, and tell me
> what it printed.

What to point at while it runs:

- Each tool is one line — the file it wrote, the command it ran, the exit code.
- A line opens to its output; the phase above folds back to one row when it is
  done, and says **failed** in red if it was.
- Nothing is summarised away. The reply is the model's own words; Crew does not
  tell it how to talk.

```bash
PROVIDER=claude MODEL=claude-haiku-4-5-20251001 SCENARIO=code node scripts/drive.mjs
```

## 3. The agents talk to each other (60s)

With two agents in the roster, ask one:

> Tell Reviewer the branch is green.

The row in the sender's chat reads `the branch is green · to Reviewer`. Open
Reviewer: the same text arrived as a turn with **from Coder** on it, and
Reviewer answered without anyone typing at it. That is the thesis — you write
once, the agents carry it between them.

```bash
node scripts/drive.mjs                 # opencode, no credentials needed
SCENARIO=loop node scripts/drive.mjs   # an agent hands itself the second half
```

## 4. Search across everything (30s)

`Ctrl+Shift+F`. Type a word. Results are every message from every agent, with
the hit marked, a date filter, a per-agent filter, and best-match or newest.
Click one: it opens that agent's chat at that line and lights it up.

## 5. A standing order (60s)

`Ctrl+Shift+R` → a routine: an agent, a schedule, and what to do each time.
Press **Run now** to show it firing; the run history fills in underneath.

Say the part that matters: **the daemon fires these, not the window.** Close
the app and the 09:00 check still happens.

```bash
SCENARIO=routine node scripts/drive.mjs   # fires with no client connected at all
```

## 6. The tools, if anyone asks (30s)

Five tools are on every turn: `list_agents`, `message_agent`, `search_messages`,
`find_tool`, `call_tool`. The rest of the catalogue is found with `find_tool`,
which answers with a schema ready to call. A hundred tools cost two entries in
the prompt instead of a hundred.

## If something goes wrong on stage

- An agent sits at "working" with nothing on screen: its CLI is cold-starting.
  The first output has a 120s budget; after that the turn is marked failed
  rather than left hanging.
- A provider is not logged in: the turn ends with the CLI's own error on the
  row, in red. Switch the agent to opencode, whose free models need no account.
- The whole app looks stuck: `crewd` keeps running without the window. Reopen
  it and the transcript is where it was.
