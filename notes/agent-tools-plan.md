# Agent tools — agents that manage agents and routines

Agents are provider CLIs that Rust spawns; the only Crew-specific thing they
receive is the persona prompt. Nothing in the process can reach the store or
the scheduler. This adds a narrow, provider-agnostic way in.

## Shape

```
claude / codex ──MCP stdio──▶ crew --mcp ──unix socket──▶ Tauri (bridge.rs)
cursor-agent  ──Bash───────▶ crew call  ──unix socket──▶      │ emit "agent-tool"
                                                              ▼
                                                    webview: lib/agentTools.ts
                                                    (api.ts, scheduler, transcript)
                                                              │ invoke bridge_reply
                                                              ▼
                                                    socket ◀── Tauri
```

Rust relays and knows nothing about tools. TypeScript already owns `nextRun`,
`wakePrompt`, validation, session creation and the scheduler refresh, so the
handlers live next to that code.

## Identity and safety

- `CREW_SOCKET`, `CREW_TOKEN`, `CREW_SESSION_ID` ride on the agent's environment
  at spawn; MCP servers inherit it. The token is minted per app launch.
- Socket file is 0600 in the app data dir; stale files are removed at boot.
- Under `ask` autonomy the tool call goes through the provider's permission
  prompt, so the existing ApprovalCard covers it. Under `full` the target
  session gets a system block so the change leaves a trace.
- `routines.created_by` (migration v9) lets the wake prompt say who set the
  order up when it was another agent.

## Tools (v1)

| tool | args |
| --- | --- |
| `list_agents` | — |
| `create_agent` | `name`, `description`, `provider?`, `model?`, `autonomy?` |
| `list_routines` | `agent_id?` (default: self) |
| `upsert_routine` | `routine_id?`, `agent_id?`, `name`, `prompt`, `schedule`, `enabled?` |
| `delete_routine` | `routine_id` |

Not yet: `message_agent`. Creating an agent leaves it idle on purpose for now.

## Providers

- Claude: `--mcp-config` inline JSON, appended last (the flag is variadic).
- Codex: `-c mcp_servers.crew.command=… -c mcp_servers.crew.args=["--mcp"]`.
- Cursor: no per-invocation MCP flag; the persona prompt names `crew call`.
