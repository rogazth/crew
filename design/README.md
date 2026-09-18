# Crew — design system exploration

Three complete prototypes of the Crew renderer, each one a different design system.
No Electron, no imports from `src/`. Mockups with real behaviour — and, when you want
it, real data: the shared layer speaks the actual daemon protocol.

```bash
./design/install.sh                        # six separate npm projects

cd design/proto-ink     && npm run dev     # http://localhost:5181
cd design/proto-console && npm run dev     # http://localhost:5182
cd design/proto-canvas  && npm run dev     # http://localhost:5183
```

All three can run at once — they hold fixed ports on purpose. Each prototype pins its
own dependencies, so one cannot quietly change another.

Two switches, the same in all three, and they compose with the hash route:

```
?stress=heavy         400 sessions, 5000-block transcripts, 20k files, a 50k-line terminal
?source=live          a real crewd — run `cargo build -p crewd` once first
#/session/s-harness   every surface is addressable; the full list is in BRIEF.md
```

Screenshots are not committed — 32 MB that regenerate in a minute with
`node design/tools/shoot.mjs --all && node design/tools/contact-sheet.mjs`, which writes
`design/shots.html`.

## Start here

| | |
| --- | --- |
| `EVALUATION.md` | The rubric, and the order to click through the three. |
| `FINDINGS.md` | **What running the real daemon revealed.** Three bugs, measured. |
| `PROPOSAL.md` | What to change in the app, ordered by effect over cost. |
| `INVENTORY.md` | What the current renderer does — the functional contract. |
| `BRIEF.md` | The engineering contract every prototype follows. |
| `proto-*/DIRECTION.md` | What that prototype believes. |
| `proto-*/TOKENS.md` | The part that would actually get ported. |

## The three directions

| | Thesis | Elevation | Type | Transcript |
| --- | --- | --- | --- | --- |
| **Ink** | One ink, three surfaces, four elevations. Nothing opts out. | Four levels, strictly | System sans 13/18 | Bubble for you, bare column + rail for the agent |
| **Console** | The settings page reads like a terminal — make the whole app read like one. | None. Rules and tone only | Mono is a semantic role | A two-column aligned log |
| **Canvas** | Give the relief to *everything*, from one scale. Agents are people, so they have faces. | Five levels, press states | Sans 14/21, roomier | Bubbles both sides, widgets as cards |

They answer the same brief and cover the same features. They disagree about how a tool
should look, not about what it does.

## `design/shared` — the fake daemon, and the real one

Prototypes import everything from `@crew/fixtures` (a Vite alias to `shared/src`).
`npm test` there runs 157 tests over the parts worth porting back into the app.

**Data.** 3 workspaces, 13 sessions, 75 project files, 6 routines, terminal buffers,
file bodies and patches, and transcripts covering every case the brief asks for: long
(`s-harness`), short (`s-renderer`), empty (`s-triage`), a folding stress case
(`s-daemon`), a failed run (`s-scribe`), agent-to-agent traffic (`s-relay`), and
**two captured from a real daemon run** (`s-lead`, `s-reviewer`).

**Logic.** `groupRows` / `buildActivity` / `phaseLabel` / `activityDigest` — the
transcript's grouping semantics, including agent-message threads. `toolLine` — with the
`{` bug fixed, and with Crew's own tools decoded. `searchMessages`, `fuzzyMatch`, the
command table and chord matcher, `schedule`/cron, `identityFor` for avatar seeds.

**The agent network** (`agents.ts`) — the model the UI has never had:
`letters()` pairs the sender's outbound call with the receiver's inbound turn so a
message is counted once; `mailbox()` is what is still queued for a busy agent;
`conversationBetween()` is the two-sided thread; `graph()` is who writes to whom;
`lineage()` is the creation tree, four levels deep in the fixtures.

**Two runtimes, one interface.** `DataSource` in `source.ts` is implemented by
`fixtureSource()` and by `liveSource()`, which speaks the real `crewd` protocol over a
WebSocket. A component written against the interface needs no rewrite to go live.

**Stress** (`data/stress.ts`) — deterministic generators: 400 sessions, 5000-block
transcripts, 20k files, a 500-row table, 50k terminal lines.

## Running against a real daemon

```bash
node design/tools/daemon-probe.mjs      # every method the UI calls — 15/15 answer
node design/tools/agent-probe.mjs --raw # a real turn where an agent creates an agent
cd design/live-check && npm run dev     # DataSource check in a browser, both sources
```

`design/tools/vite-crewd.ts` is the dev-server plugin: it starts `crewd`, reads the
`{url, token}` it prints, and serves it at `/__crew/daemon`. Add it to a prototype's
`vite.config.ts` and `liveSource()` connects.

## Tooling

The browser tools need a headless Chromium, which Playwright keeps outside the repo.
Once per machine: `cd design/tools && npx playwright install chromium`.

```bash
node design/tools/smoke.mjs --all        # tsc + build + walk every route for errors
node design/tools/shoot.mjs --all        # screenshots, 16 routes × 2 themes
node design/tools/contact-sheet.mjs      # shots.html — the three, side by side
node design/tools/stress.mjs --all       # long tasks, frame times, heap, DOM size
cd design/shared && npm test             # 157 tests on the shared layer
```

## Layout

```
design/
  shared/           fixtures, logic, the live client — read-only for prototypes
  proto-ink/ proto-console/ proto-canvas/
  live-check/       a harness, not a prototype: DataSource against a real daemon
  tools/            probes, smoke, screenshots, stress, the crewd Vite plugin
```
