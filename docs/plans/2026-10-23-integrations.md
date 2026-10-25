# Integrations — every provider's MCP servers and Crew's own, with a credential vault

Decided 2026-10-23. Replaces `2026-10-15-integrations.md`, none of which was
built. One page shows every MCP server a session can get, from wherever it
comes: the ones each provider CLI already has, and connectors installed from
Crew. Crew's connectors are signed in once, can hold several accounts, and are
turned on per workspace, bot or session. Their credentials live on one machine
the user picks. Update the status table at the bottom as each phase lands.

## Why

- Each CLI keeps its own servers and signs in to each on its own: Notion
  connected in Claude is not in Codex, and a remote machine signs in again.
- The user wants to sign in once, keep several accounts of one service (Work,
  Personal), and turn a connector on for some consumers and not others.
- A mobile app is next. The phone runs no sessions, and remote machines keep
  working with the Mac off, so no credential can depend on the window, and
  the phone holds none.

## What changed from 2026-10-15

- **Provider servers are kept.** Crew shows them, signs in to them, and turns
  them off for its own sessions. It does not replace or hide them.
- **One vault, not a grant per machine.** Rule 2 of the old plan had each
  machine sign in on its own. Now one machine, which the user picks, holds
  Crew's grants, and every other machine leases access tokens from it. A
  rotating refresh token can have one holder only: a copy that refreshes
  invalidates the others, and reuse detection can revoke the whole grant
  (RFC 9700 §4.14.2).
- **Accounts and bindings** are new. The old plan had one connection per
  connector and a per-workspace switch.
- **The sign-in redirect is intercepted, not routed.** The old plan sent the
  redirect through `remote-proxy.ts` to the machine's loopback. Now Crew's
  browser catches the redirect and hands the URL to the daemon that waits for
  it. This works the same way from a phone.
- **Native mode is gone as a fallback.** A server that refuses Crew's client
  (Figma) stays a provider server, signed in through its CLI.

## What is there

- Crew's own server is injected per spawn and never written to the person's
  configs: claude `--mcp-config` (`providers/claude.rs`), codex
  `config.mcp_servers` on `thread/start`, cursor ACP `mcpServers`
  (`providers/cursor.rs:99`), opencode a config file through `OPENCODE_CONFIG`.
  Claude's title and menu runs already pass `--strict-mcp-config`
  (`titles.rs:78`).
- `McpHost` (`mcp_status.rs`) keeps each live session's servers in memory,
  with these states: Connected, Pending, Failed, NeedsAuth, Disabled, Unknown
  (`crew-protocol/src/mcp.rs`). The RPCs are `mcp_list`, `mcp_login` and
  `mcp_reconnect` (`turns/mcp.rs`). The chip in `src/surfaces/chat/Mcp.tsx`
  offers Sign in and Reconnect, and nothing else. Cursor and Grok report
  nothing.
- No `crewd` connects to another. A remote's `crewd serve` listens on its
  Tailscale address (port 17877; +2 for local builds, +4 for dev) over plain
  `ws://`, behind one full-access token at `<data>/token` (`machine.rs`,
  `lib.rs:878`). The Mac's `crewd` listens on loopback and the UNIX socket
  only.
- The address book (`remotes`) and the preferences (`app_state`) live in the
  Mac's `crewd` (`src/lib/client/route.ts`, `LOCAL_METHODS`).
- Secrets: remote tokens go through Electron `safeStorage`
  (`remote-tokens.ts`). `crew-core` reads keychain items
  (`cookie_import.rs`, `security-framework`) but writes none. On Linux there
  are only 0600 files.
- Settings pages are registered in `src/lib/settings.ts`,
  `src/surfaces/settings/pages.ts` and `SettingsView.tsx`. Providers shows
  one chosen machine (`useProvidersEnv`, `settings/route.ts`), and
  Integrations follows that pattern.
- Every browser page shares `persist:crew-browser`, so a service the user
  signed in to once answers later consents in one click. Incognito pages
  share one in-memory session.

## Provider facts (checked 2026-10-23)

| Provider | List | Sign in | Off for one spawn | Toggle at runtime |
| --- | --- | --- | --- | --- |
| claude 2.1.306 | `claude mcp list` (text); `mcp_status` in a live process | control `mcp_authenticate {serverName, redirectUri}`, then `mcp_oauth_callback_url {serverName, callbackUrl}`; `mcp_clear_auth`; `claude mcp login` | `--strict-mcp-config` and pass again the servers that are kept | control `mcp_toggle {serverName, enabled}`; `mcp_set_servers` |
| codex 0.163.0 | `codex mcp list --json`; `mcpServerStatus/list` | `mcpServer/oauth/login`, then `mcpServer/oauthLogin/completed` | `mcp_servers.<name>.enabled = false` override on `thread/start` | `config/mcpServer/reload` (reloads every server) |
| opencode 2.1.2 | `GET /api/mcp` on the shared server | `opencode mcp auth`; an OAuth URL from the server | `mcp.<name>.enabled = false` in the run's config | `POST /api/experimental/mcp/{name}/connect` |
| cursor-agent 2026.10.19 | `cursor-agent mcp list`, `list-tools` | `cursor-agent mcp login <id>` | none known | none; `mcp disable` writes its approved list |
| grok 1.0.67 | `grok mcp list --json` | none in the CLI | none known | none; `mcp disable` writes its config |

Claude's binary also reads `ENABLE_CLAUDEAI_MCP_SERVERS`, which presumably
controls the claude.ai connectors. Everything in this table that Crew does not
call today is checked by the spike.

## The rules

1. **The service authenticates the person.** Sign-in happens on the
   service's page. Crew sees a code and a token, never a password.
2. **One vault holds Crew's grants.** The user picks the machine: this Mac
   by default, or any remote. Only the vault refreshes. Every other machine
   leases access tokens from it. A provider server's credential stays in its
   CLI's store on each machine: Crew drives that sign-in but never copies the
   credential.
3. **Nothing goes in the person's CLI configs** unless the user picks an
   action that says it does: turning a Cursor or Grok server off, which has
   no per-spawn way. Crew's connectors, and the servers it turns off, are
   handled per spawn.
4. **Each account is its own MCP server to the CLI.** Its tools keep their
   names (`mcp__notion__…`), the CLI defers them like any server's, and
   `McpHost` reports each one's state.
5. **The CLI never sees a token.** The shim forwards calls to its machine's
   `crewd`, which holds the leased access token in memory.
6. **A session's autonomy decides,** as for any tool. Crew adds no bypass.
7. **The phone holds no credential.** Nothing here may need a window to be
   open.

## Design

### The model

- **Provider server.** One server in one provider's config on one machine:
  name, transport, URL or command, its scope (user, project, plugin,
  claude.ai), and its state. The CLI owns it.
- **Connector.** A remote MCP server installed from Crew: from the official
  registry (`registry.modelcontextprotocol.io/v0/servers`, cached for a day)
  or from a URL.
- **Account.** One sign-in to a connector, with a stable id and a label
  ("Work"). A connector can have several. The label is filled in from the
  authorization server's `id_token` or userinfo (`email`, `name`) when it
  gives one, and typed otherwise.
- **Grant.** An account's refresh token, kept in the vault.
- **Binding.** An account turned on, or off, for a scope: everywhere, a
  workspace, a bot, or a session. The most specific binding wins. A bot
  follows its workspace unless it has its own binding.
- **Off in Crew.** A provider server left out of Crew's spawns on one
  machine, for one provider.

What concerns the person (connectors, accounts, bindings, tool switches)
lives in the vault's `crewd`, and every machine keeps a copy on disk. What
concerns one machine (its provider servers and what is off in Crew) lives in
that machine's `crewd`. Editing a connector needs the vault online. Spawning
does not: a machine spawns from its copy.

### The vault

- `integrations:vault` names the machine: `local` or a remote id. The
  default is `local`.
- **Storage.** On macOS, a keychain item per build, named by `channel.ts`
  and written by `crewd` through `security-framework` (new: today
  `crew-core` only reads). On Linux, `<data>/vault.json`, mode 0600. It is
  not encrypted at rest, because the key would sit on the same disk, and the
  warning says so.
- **Only the vault speaks OAuth.** It handles discovery (a 401's
  `WWW-Authenticate`, then protected-resource metadata, then
  authorization-server metadata), client registration (CIMD when the server
  takes it, DCR otherwise, one registration per server, reused), PKCE `S256`,
  `resource` on every request, rotating refresh tokens, and step-up on 403
  `insufficient_scope`.
- **Lease.** A machine asks `vault_lease {account}` and gets back
  `{access_token, expires_at, scopes}`. It keeps the token in memory, asks
  again at 80% of its life, and asks once more after a 401 from the service.
  The vault refreshes when its own access token is near expiry, and leases
  that ask at the same time share one refresh.
- **Vault offline.** A machine keeps using the token it holds until it
  expires. After that, the account's server answers a tool call with one
  line ("Notion · Work: the vault on devbox is offline since 14:02"), and
  `McpHost` shows it Failed, with that reason.
- **Reaching the vault.** This is new: machines connect to the vault, and
  the vault never connects out.
  - *A remote vault* takes leases on its `crewd serve` socket, over
    Tailscale.
  - *This Mac as the vault* listens on its Tailscale address for leases
    only, on the build's port. It does this only while it is the vault, and
    it takes no other call there.
  - Each machine leases with a **scoped token**: lease and config read only,
    minted by the vault for that machine, and revocable on its own. This is
    new, because `crewd serve` has one full-access token today. The Mac's
    own `crewd` leases the same way as any machine.
- **Joining.** When the vault is chosen, or a machine is added, the window,
  which reaches both, asks the vault for a token for that machine and hands
  it over (`vault_join {address, token}`). The machine keeps it in the
  keychain on a Mac, or in a 0600 file on Linux. Removing the machine
  revokes the token.
- **Moving the vault.** The window mints a one-use handoff token on the old
  vault. The new vault pulls the grants with it, and the old vault deletes
  them and starts leasing from the new one. Then the window points every
  machine at the new vault. At no point do two machines hold a grant. If the
  old vault is offline, the move offers to start empty, and every account
  then asks for a sign-in.

### Signing in

Every sign-in opens in a Crew browser tab. The tab catches the navigation to
the redirect URI of a flow it started (`will-redirect` / `will-navigate`, and
before the loopback rewrite of a remote workspace's tab), cancels it, closes
itself, and sends the URL to the daemon that waits for it. A code is useless
without its PKCE verifier, which never leaves that daemon. Nothing has to
listen on the redirect URI.

- **A connector account.** The vault registers
  `http://127.0.0.1:<port>/callback` and starts the flow. The tab hands the
  URL over with `vault_callback {state, url}`.
- **Another account of the same connector** opens in an incognito page, so
  the account already signed in to Crew's browser does not answer for it.
- **A provider server** signs in on the machine whose CLI uses it:
  - Claude: `mcp_authenticate` with Crew's redirect, then the caught URL
    through `mcp_oauth_callback_url`. This runs in a short-lived process when
    no session has one.
  - Codex, opencode, Cursor and `claude mcp login` listen on that machine's
    own loopback. The caught URL goes to that machine's `crewd`
    (`native_callback {url}`), which requests it locally.
  - Each machine signs in on its own, since its CLI keeps the credential.
    Because the browser session is shared, that is usually one click.
- **From a phone, later:** the same flow. The webview's navigation delegate
  catches the URL and sends it to the same RPC.

### Use

- Each account bound to a session is one more server in that spawn's config:
  `crewd --mcp-connector <account>`, a stdio shim with the session's
  `CREW_TOKEN`. The shim forwards `tools/list` and `tools/call` to its
  machine's `crewd`, which calls the remote server over streamable HTTP (SSE
  when that is all the server has) with the leased token.
- **Server names.** A server is named after the connector (`notion`). When
  that name is taken (two bound accounts, or a provider server of the same
  name), it becomes `notion_work`. By default, a consumer gets one account
  per connector.
- **Tools.** `tools/list` is cached per account on each machine, and
  refreshed on connect, on `listChanged`, and hourly, so a spawn does not
  wait on the network. A tool switched off is left out of `tools/list` and
  costs no context.
- **Bindings** are resolved at spawn, from the machine's copy. A change
  reaches a live Claude process through `mcp_set_servers`. Every other
  provider gets it on its next spawn.
- **Off in Crew** is applied at spawn, as the provider-facts table says.
  Cursor and Grok have no per-spawn way, so their row offers the CLI's own
  `mcp disable`, labelled "also outside Crew".
- **Duplicates.** A provider server and a connector with the same host get
  one line: "Notion is also in Claude on this Mac", with "Turn Claude's off
  in Crew".

### The page

Settings › Integrations, in the Tools group.

- **Header:** the vault ("Credentials on devbox ●"), its state, the machines
  leasing from it, and Change. Choosing a vault opens one sheet that says
  what it costs: who can read the file, and that with this Mac as the vault
  the remotes lose Crew's connectors about an access token's life after the
  Mac sleeps or shuts down.
- **Crew:** each connector with its accounts (label, state, where it is
  on), Connect, Add account, and a registry search.
- **Providers on <machine>:** a machine picker, as on Providers, then each
  provider's servers: state, scope, tool count, Sign in, and Off in Crew.
- **Detail pane:** tools with switches and their annotations (read only,
  destructive), bindings, the machines signed in for a provider server, and
  Disconnect or Remove.
- **In the chat**, the MCP chip gains an account label, a runtime switch
  (Claude's `mcp_toggle`), and the new sign-in flow. A vault that is offline
  or a grant that ran out shows there with a reconnect button, not only in
  Settings.

UX, for the prototype to settle:

- **First open.** "Found 9 servers in Claude, Codex and Cursor on this Mac;
  2 are the same service."
- **Sign-in.** The tab opens, closes itself on success, and the row goes
  from pending to connected in place.
- **Machines.** One dot per machine for a provider server, filling in as
  each one signs in.
- **Consumers.** The cost in context, shown when an account is turned on for
  a consumer.

### What this leaves for mobile

- The phone signs in through the same RPCs and holds nothing.
- With a remote as the vault, Crew's connectors keep working with the Mac
  off. With this Mac as the vault, they keep working for about one access
  token's life, which is the risk the user accepted.
- Out of scope here: moving the address book and preferences off the Mac,
  and push notifications.

### Risks accepted

- Whoever reads the vault reads every Crew account. On Linux, that is root
  and the user the vault runs as.
- Sessions run as the user's UID, so one can read its machine's lease token
  file, as it can read `daemon.json` today.
- Leases are bearer tokens in a `crewd`'s memory, and they never reach a CLI.

## Phases

**0. Spike (2–3 days).**
- *Claude:* what `mcp_authenticate` returns; whether a server passed again
  under `--strict-mcp-config` keeps its stored OAuth; whether `mcp_toggle`
  can act before the server connects; what `mcp_set_servers` and
  `ENABLE_CLAUDEAI_MCP_SERVERS` do; how to list claude.ai connectors without
  a session.
- *Codex:* the `enabled = false` override on `thread/start`;
  `mcpServer/oauth/login` on a remote with a replayed callback.
- *opencode:* `enabled = false` per run; its auth URL and callback.
- *Cursor and Grok:* any per-spawn disable; how each signs in.
- *Servers (Atlassian, Notion, Sentry, Linear, Figma):* CIMD, DCR or
  refused; access-token lifetimes, which set how long a vault outage is
  survived; whether each gives an `id_token` or userinfo.
- *Electron:* catching a loopback redirect that nothing serves.

**1. Provider servers.** A thrown-away prototype of the page first. Then: the
inventory per machine and provider, the page with its provider sections,
sign-in with caught redirects, Off in Crew for claude, codex and opencode,
the CLI's disable for cursor and grok, and the runtime switch in the chip.
This phase needs no vault.

**2. Vault on this Mac.** The OAuth client in `crewd`, keychain writes,
accounts and bindings, the registry catalog, Connect,
`crewd --mcp-connector`, tool switches, and the tools cache. A fake OAuth and
MCP server for tests and e2e.

**3. Remote vault and leases.** Scoped tokens on `crewd serve`, the lease
protocol, the Mac's lease listener, joining, moving the vault, the Linux
file, and the offline states.

**4. Duplicates and import.** "Move to Crew" makes a connector from a
provider server's URL, signs it in through the vault, and turns the provider
server off in Crew. It never deletes anything from the CLI's config.

**5. Password managers** as a kind (`2026-10-15-password-providers.md`).

**Later.** Local stdio packages with API keys in the vault. A key does not
rotate, so its lease is a copy.

## Open questions

- CIMD needs an HTTPS URL Crew controls for its client document (GitHub
  Pages on the repo, or a domain). Until then, Crew uses DCR only, and each
  vault registers its own client.
- Should Off in Crew be per workspace too, or per machine only, as here?
- Should a second account start on nowhere (as here) or ask where?

## How it is built

Subagents build each part in its own worktree and do not commit. The
orchestrating session reviews each part against the rules above, runs the
checks, and makes every commit.

## Status

| Part | State |
| --- | --- |
| Spike: provider controls, servers' registration, redirect catching | todo |
| Prototype of the page | todo |
| Provider servers: inventory, page, sign-in, Off in Crew, chip switch | todo |
| Vault on this Mac: OAuth client, keychain, accounts, bindings, connector shim | todo |
| Remote vault: scoped tokens, leases, join, move, Linux file | todo |
| Duplicates and import | todo |
| Password managers as a kind | todo |
