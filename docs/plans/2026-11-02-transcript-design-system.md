# Transcript design system

How a chat shows what its agents do, and how the user reads and reaches them. It
came out of three prototypes run on a real Manager transcript (branch
`prototype/transcript-ds`, local only: its fixture holds private data).

## Rules

1. **A beat is not a preview.** Starting an agent, a message either way, a report
   and a question leave one centered line that says who did what to whom and when.
   Never the words: those are a click away. No cards or collapsibles for this.
2. **You on the right, everyone else on the left.** The user's bubble is the one
   that already exists; bots and sessions go by mark, name and time. This does not
   depend on whose chat it is.
3. **One thread per agent.** What was said and what was done are not two views:
   the messages are the thread's spine, and the work between two of them is one
   line, `Worked for 6m 14s`, that opens in place.
4. **Colour is for what wants you.** The app's three rising dots while it works,
   amber while it waits on an answer. A tool failing shows on that tool's row; a
   run reads as failed only when all of it failed.
5. **One prompt.** The same well everywhere, with the same chips. In a sub-agent's
   thread the chips show its model and do not open: it runs what it was started
   with.

## Components

| Component | Where | What it is |
| --- | --- | --- |
| `Beat` | `chat/Beat.tsx` | The centered line, with a mark by each name. It opens the agent's thread, else the pair's conversation, else a dialog with the words when nothing is left to open. |
| `Speech` | `chat/Orchestration.tsx` | Someone other than the user in a thread: left, mark, name, time, bubble. Tagged `Brief`, `Report` when it is one, and it says when a letter reached the agent long after it was sent. |
| `threadRows` | `lib/transcriptRows.ts` | The rows of an agent's thread: speech as the spine, the work folded between, open questions and approvals and the running work never folded. |
| `withLetters` | `lib/letters.ts` | Adds to an agent's transcript what it has no place for, and gives a report and a question their letter's id so a beat can open at them. |
| `SidePanel` | `chat/SidePanel.tsx` | The right panel: a second sheet hung from the main sheet's edge, one thing at a time. It does not dim either sheet by focus. The look comes from `prototype/right-panel`. |
| `AgentList` | `chat/AgentList.tsx` | Everyone the chat has worked with, with no limit and nothing to clear: find, group, order, filter. Crew's sub-agents, the sessions it started, the CLI's own sub-agents and conversations. |
| `AgentNotice` | `chat/ComposerParts.tsx` | On the prompt's top edge only while an agent waits on an answer, or failed and nobody looked. Opens it; the x waves it away until the next time. |
| `AgentsSegment` | `chat/ComposerParts.tsx` | In the line under the prompt: `View sub-agents`, or `3 sub-agents working`. Opens the list. |

## What moved

- The agents clip and its unfolding sheet are gone. A chat's agents are in the
  list; the status line's sheet keeps what they left running (shells, processes)
  and its `Clear finished`, which no longer touches agents.
- A question or an approval is answered in the agent's thread, not in the parent's
  chat. The beat says it waits, and the notice points at it.
- An agent and a conversation open in the right panel with the chat in view. A
  shell's output still takes the whole pane.

## Left for later

- Native sub-agents are as complete as the daemon's board for the chat keeps them:
  what the board has lost shows as a beat with a dialog, not in the list.
- Writing in, or adding someone to, a conversation between bots.
- A nested agent (an agent's own agent) opens over its parent in the panel, and is
  reached from that thread's own work sheet.
