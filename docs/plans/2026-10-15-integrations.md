# Integrations

Superseded by `2026-10-23-integrations.md` on 2026-10-23, before any of it
was built. Kept for the record.

Decided 2026-10-15. Crew gets one catalog of integrations, like the
connectors of Claude and ChatGPT: browse, "Connect", sign in on the service's
own page, and every provider and session can use it. Crew never sees a
password; each machine that uses a connector holds its own OAuth grant. Update the
status table at the bottom as each phase lands.

Two kinds at first:

- **Connectors**: remote MCP servers (Atlassian, Notion, Sentry, Linear,
  Figma…), signed in with OAuth. This plan.
- **Password managers**: Bitwarden, 1Password, for the browser.
  `2026-10-15-password-providers.md`; its entry point moves to this catalog.

Local MCP packages (npm, PyPI, OCI over stdio), skills and processes can be
later kinds.

## What is there

- Each CLI gets Crew's own MCP server, `crewd --mcp`, a stdio shim to the
  daemon's bridge, with `CREW_SOCKET` and a per-session `CREW_TOKEN`
  (`mcp.rs`, `turns.rs` `TurnHost::mcp`). It is injected per spawn, never
  into the person's own configs: claude `--mcp-config` (`alwaysLoad`),
  codex `config.mcp_servers`, cursor ACP `mcpServers`, opencode a config file
  through `OPENCODE_CONFIG`.
- `Toolbox` can register a `ToolFamily` at runtime (`tools.rs`), but the shim
  does not send `listChanged`, and the gateway tools (`call_tool`,
  `find_tool`) were removed on purpose.
- `McpHost` (`mcp_status.rs`) keeps each session's servers as its CLI reports
  them: connected, failed, waiting for a login (claude, codex, opencode;
  cursor reports nothing). `src/surfaces/chat/Mcp.tsx` shows them.
- Secrets today: remote tokens, through `safeStorage` (`remote-tokens.ts`).
  `crew-core` already links `security-framework` (`cookie_import.rs`).
- Settings has Providers (installed or not) and no integrations page.
- Crew's browser reaches a remote machine's `localhost` through
  `remote-proxy.ts`.
- A remote session's CLI runs on the remote machine; its shim talks to that
  machine's `crewd`.

## Outside facts (checked 2026-10-15)

- MCP authorization (2025-11-25): OAuth 2.1 with PKCE `S256`, Protected
  Resource Metadata (RFC 9728) for discovery, `resource` (RFC 8707) on every
  request. Client registration in order: pre-registered, Client ID Metadata
  Document (CIMD: the `client_id` is an HTTPS URL to a JSON document),
  Dynamic Client Registration as a fallback. Redirects are `localhost` or
  HTTPS. Public clients get rotating refresh tokens.
- The official registry (`registry.modelcontextprotocol.io/v0/servers`,
  `?search=`) lists servers with `remotes` (`streamable-http`, `sse`) and
  `packages`. Names are reverse DNS (`com.atlassian/atlassian-mcp-server`).
  Anyone can publish; quality varies.
- Not every server lets any client in. Figma admits clients by the
  `client_name` they register with and returns 403 to the rest; Claude Code
  and Codex are on its list, Crew is not.
- Context: Claude Code defers MCP tools behind its tool search once they pass
  ~10% of the window (names only until used); Codex defers schemas too and
  takes `enabled_tools` / `disabled_tools` per server. Third-party sources;
  the spike measures.

## The rules

1. **The service authenticates the person.** Sign-in happens on the
   service's own page. Crew sees a code and a token, never a password.
2. **The machine that uses a connector holds its grant.** Each machine
   (this Mac, each remote) signs in on its own and keeps its own refresh
   token: in the keychain on a Mac (one item per build, `channel.ts` names
   it), in a 0600 file in the data dir on Linux, as the provider CLIs keep
   theirs. A machine never depends on another being awake, and each grant is
   revoked on its own.
3. **Nothing in the person's own CLI configs.** Integrations are injected
   per spawn, like `crew` is; removing one leaves no trace.
4. **Each connector is its own MCP server to the CLI,** not tools inside
   `crew`: its tools keep their names (`mcp__atlassian__…`), the CLI defers
   them like any server's, and `McpHost` reports each one's state for free.
5. **A session's autonomy decides,** as for any tool: Crew adds no bypass.

## Design

**Catalog.** The official MCP Registry and nothing curated: browse and
search `/v0/servers`, latest versions only, publisher from the reverse-DNS
name. Only `remotes` entries can connect in this plan. The list is cached
for a day so the page opens without the network.

**Integrations page.** A new Settings section, "Integrations", for the
machine it is opened on (the window's current environment): a search over
the registry, and what this machine has connected. A detail pane: what it is, who publishes it, mode,
state, its tools once connected (with read only / destructive from the tool
annotations) each with an on/off switch, where it is on, Disconnect. A tool
switched off is left out of the shim's `tools/list`: it costs no context.

**Broker mode (default).** Crew is the OAuth client and the MCP client.
- *Connect.* The `crewd` of the machine being connected discovers (401
  `WWW-Authenticate` → resource metadata → authorization server metadata,
  both well-known forms), registers (CIMD if supported, else DCR), and
  listens for the code on its loopback (`127.0.0.1`, random port, one use,
  5 minute timeout). The window opens the authorization URL, with PKCE,
  `state` and `resource`, in a Crew browser tab routed to that machine
  (`remote-proxy.ts` already sends a remote workspace's `localhost` there),
  so the redirect lands on that machine's `crewd` and the code never passes
  through another. That `crewd` stores the refresh token, the access token
  in memory.
- *Use.* Each connected connector is one more server in the per-spawn config:
  `crewd --mcp-connector <id>`, with the session's `CREW_TOKEN`. The shim
  forwards `tools/list` and `tools/call` to `crewd`, which calls the remote
  server over streamable HTTP (SSE for servers that only have it) with the
  bearer token, refreshes on 401, and asks for a step-up on 403
  `insufficient_scope`. A connector that lost its sign-in answers with one
  line pointing at the Integrations page.
- *Caching.* `tools/list` is cached per connector and refreshed on connect,
  on the server's `listChanged`, and hourly, so a spawn does not wait on the
  network.

**Native mode (fallback).** For a server that refuses Crew (Figma), Crew
injects its URL as a plain HTTP server in each CLI's spawn config and the
CLI signs in with its own client. `McpHost` already sees "waiting for a
login"; the page says which CLIs are signed in and how to sign in with each
(`codex mcp login`, opencode's `mcp auth`, claude's `/mcp`). Chosen when a
broker registration is refused (403), and remembered for that server.

**Machines.** What is connected is per machine, in that machine's
`crewd` store, like its workspaces, and is connected one machine at a time:
Connect on the page of the environment it is for. A remote keeps working
with the Mac off: it holds its own grant. Native mode on a remote works the
same way: the CLI's sign-in URL opens in a tab routed to that machine, so
its loopback redirect lands there.

**Where it is on.** On everywhere by default; per workspace on or off;
bots follow their workspace.

**Password managers.** An entry kind in the same catalog: Connect installs
the CLI and runs the manager's unlock, as the password plan says.

## Phases

**0. Spike (1–2 days).** From a script with Crew's client metadata: sign in to
Atlassian, Notion, Sentry, Linear, Figma; record which take CIMD, DCR, or
refuse. Check how claude, codex, cursor and opencode take an injected HTTP
server and how each signs in to it headless. Measure each server's
`tools/list` in tokens, and what each CLI puts in context for it. Decides
the native mode's details.

**1. Catalog and page.** Registry browse and search, the Integrations
section with Connect stubbed.

**2. Broker.** OAuth client in `crewd` (discovery, CIMD/DCR, PKCE, resource,
refresh rotation, step-up), keychain store, `crewd --mcp-connector`,
injection into the four providers, tools cache. A fake OAuth + MCP server
for tests and e2e.

**3. Native mode.**

**4. Remote machines.** The page per environment, sign-in tabs routed to
the machine, the Linux token file.

**5. Password managers** as a kind (the password plan's phases).

**Later.** Local stdio packages with API keys in the keychain; importing the
servers a person already has in their CLIs.

## Open questions

- CIMD needs an HTTPS URL Crew controls for its client document (GitHub
  Pages on the repo, or a domain). Until then, DCR only.

## How it is built

Subagents build each part in its own worktree and do not commit. The
orchestrating session reviews each part against the rules above, runs the
checks, and makes every commit.

## Status

| Part | State |
| --- | --- |
| Spike: which servers take CIMD / DCR, CLIs with an injected HTTP server | todo |
| Registry browse and search, Integrations page | todo |
| Broker: OAuth client, keychain, `--mcp-connector`, injection, cache | todo |
| Native mode | todo |
| Remote machines: per-machine grants, routed sign-in | todo |
| Password managers as a kind | todo |
