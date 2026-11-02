# Calls run on the vault: tokens never leave it

Decided 2026-11-02. Changes phase 3 of `2026-10-23-integrations.md`: machines
stop leasing access tokens from the vault and send it their tool calls instead.
Built 2026-11-02; see "Status" at the end.

## Why

Today a machine that is not the vault asks `vault_lease`, gets the account's
access token, keeps it in memory and calls the service itself
(`flow.rs:499-502`, `vault.rs:376`). The refresh token stays on the vault, but
a live credential sits on every machine that uses the account:

- It leaves the vault at all, which is what the user doesn't want.
- A revoked machine keeps a working token until it expires.
- A tool switched off in Crew only binds Crew: a machine that holds the token
  can call that tool directly.

`2026-10-28-google-and-figma.md:102` already says "the token never leaves the
vault's machine". The code doesn't do that yet.

## The rule

**No connection between machines carries an access or refresh token.** The
only exception is the sealed move (see "Moving the vault").
Every call that needs a token runs on the vault's `crewd`. A member holds its
copy of the config and a machine token, and no credential of any service.

## What crosses between machines

| What | Before | After |
| --- | --- | --- |
| Access token | vault → member, in every lease | never |
| Refresh token | sealed, in a vault move | sealed, in a vault move |
| Machine token (`machine-…`) | member → vault | the same; it can run tools, and it is no service's credential |
| Config copy | vault → member | the same |
| Tool arguments and answers | member ↔ service, over HTTPS | member ↔ vault over `ws://` inside Tailscale (WireGuard), then vault ↔ service over HTTPS |

The vault still sends the token to the service over HTTPS. That can't be
avoided, and it is the only place the token goes.

## Design

### Peer calls

| Method | Answer | Replaces |
| --- | --- | --- |
| `vault_call {accountId, tool, arguments}` | the MCP result | `vault_lease` |
| `vault_tools_refresh {accountId}` | nothing; a change arrives as `vault-config` | a member listing tools itself |
| `vault_config` | unchanged | |

`vault_lease`, `Connectors::lease`, `Connectors::leased`, `Lease`, `Held`,
`LeaseError` and the `leases` map are deleted in the same commit that adds
`vault_call`, so no build has both.

### On a member

- `Connectors::call` forwards when there is a link, before any local work. The
  vault runs its own `call`, so the tool switch and Google's scope check are
  enforced there, against the vault's config and not a copy that may be stale.
- The `Leaser` trait becomes `VaultLink`, with `call`, `refresh_tools`,
  `vault_name` and `offline_since`.
- `tools_for_shim` answers from the copy at once and asks for a refresh in the
  background. Today a copy's `tools_at` is always null, because `lease::import`
  doesn't write it, so a member lists over the network on every `tools/list`
  (`flow.rs:681`). That also goes against the main plan's "a spawn does not
  wait on the network".
- `list_tools` on a member forwards too. A member must never reach
  `vault_token`: its vault is empty, so `expired` would mark the account
  signed out.
- `mark` runs only on the vault. A member's account states come from the copy.
- Which accounts a session may call stays resolved on the member, from the
  session's token (`crewd/src/lib.rs:470-497`).

### Google

`gws` runs only on the vault, downloaded there on first use, as `gws.rs` and
the Google plan already say. Every Google tool passes content, not paths
(`upload_file` takes text; `--upload` and `--output` stay in the call's own
folder), so moving the run to the vault changes nothing for the model. This
also settles the Google plan's open question about `upload_file`.

### The connection has to carry real calls

The peer socket was built for short lease requests. These have to change
before calls can run on it:

1. **One slow call blocks the machine.** `serve_peer` awaits each request
   inline (`vault.rs:351`), so a five-minute call would hold up every other
   call and `vault-config`. Each request gets its own task, with one writer
   task owning the sink.
2. **Timeouts.** `Link::request` gives up after 15 s (`vault.rs:49`), while a
   remote call may take 300 s (`remote.rs:44`), `gws` 120 s (`gws.rs:39`), and
   the shim waits 320 s (`mcp.rs:29`). `vault_call` waits 315 s, so the answer
   or its error reaches the shim first. `vault_config` keeps 15 s.
3. **Size.** A remote answer may be 32 MiB (`remote.rs:47`). The repo sets no
   `WebSocketConfig`, and tungstenite 0.30's default frame limit (16 MiB) would
   close the link and lose every call in flight. Arguments and
   answers over 8 MiB get a tool error instead, checked on the side that sends.
4. **A call lost halfway is never retried.** It may have sent the email. A
   request that was never sent answers "the vault on devbox is offline since
   14:02". One that was sent and lost its connection answers "the connection to
   the vault on devbox dropped during this call; it may have run". The vault
   lets a call finish when its member goes away.
5. **Revoking takes effect at once.** A peer's token is checked only when it
   connects (`vault.rs:314`, `lib.rs:995`), so a revoked machine's open socket
   keeps working. Each request looks the machine up again; a gone machine's
   connection is closed. This is what makes the new model's revocation real.
6. **A failed move stopped the vault for good.** `peer_call` refused while
   `handoffs` wasn't empty, and an expired handoff was removed only when another
   was opened. That contradicted "a move that fails leaves the old vault as it
   was", and would have blocked every call. The gate in 7 replaces the check,
   and an expired handoff can't be taken.
7. **A move can race a refresh.** Nothing stops the old vault's calls while the
   grants are sealed (`flow.rs:358`). A refresh after sealing spends the rotated
   token, and the new vault's refresh can then trigger reuse detection and
   revoke the grant. With all calls on the vault this gets more likely, so
   `Connectors` gets a gate, set by `vault_handoff`: new calls answer "the vault
   is moving; try again", the move waits up to 30 s for calls in flight and is
   refused if they don't finish, and the gate opens when the handoff expires or
   a move lands here. This covers the vault's own sessions too, not only peers.
8. **The rate limit counts calls now.** `LEASES_PER_MINUTE` (120,
   `vault.rs:47`) would throttle normal use. It becomes 600 calls a minute and
   32 in flight per machine, answered with a line the model can read. It is
   there for runaway loops. The vault's own sessions don't pass through it.

### Logs

The vault logs machine, account, tool name and outcome, never arguments or
answers. `last_lease` becomes `last_call`.

## What it costs

- **No margin while the vault is away.** A member's connectors stop at once,
  instead of after up to one token's life. With this Mac as the vault, remotes
  lose Crew's connectors the moment it sleeps. The default stays `local`, but
  the vault sheet must say this plainly and suggest an always-on remote for
  anyone who wants connectors with the Mac off.
- **Latency and load.** One more tailnet hop per call, and the vault carries
  every remote call and `gws` process.
- **A stolen machine token still runs tools,** on any account, until it is
  revoked. That holds until the existing todo "a lease limited to the accounts
  for that machine's workspaces" is done. The gains: it can't get a token out,
  tool switches bind it, and revoking stops it at once.

## Moving the vault

The sealed move stays. It is the one case where grants still cross between
machines. It happens only when the user asks, it is sealed end to end to a key
made for that move, on top of Tailscale, the old vault deletes its copy, and the
new vault refreshes every grant at once. On a service that doesn't rotate
refresh tokens, nothing retires the travelled copy, but only the new vault holds
it. Removing the move ("start empty" only) would leave the rule without an
exception, at the cost of one sign-in per account on every move. That can still
be chosen later: `seal.rs`, the handoff RPCs and their tests would go away.

## Order of work

Each step is its own commit, with tests passing. The workspaces change went in first.

1. **Connection fixes** (1, 5, 6, 7 above). No change in what crosses.
2. **Calls on the vault.** `vault_call`, `vault_tools_refresh`, `VaultLink`,
   timeouts, the size cap, a lost call's line and the new rate limit; lease
   code deleted.
3. **Page.** `vault-dialog.tsx:30` and `:36` ("lease from it", "Leases from")
   and the sheet's cost line; the comments in `vault.ts` and `store.ts`.
4. **Names.** `lease.rs` → `machines.rs`, `lease-` tokens → `machine-`,
   `last_lease` → `last_call` (a new migration; regenerate `protocol.ts`). A
   token is looked up by its hash whatever its prefix, so a `lease-` token
   already on a machine keeps working.
5. **Docs and trial.** Rewrite the main plan: "What changed" (one vault), rules
   2 and 5, "Lease connections", "Lease", "Vault offline", "Reaching the vault",
   the page's cost line, "What this leaves for mobile", "Risks accepted",
   Security phase 3, phase 3, "Later" and the status table. Then try it between
   this Mac and falcon-heavy over Tailscale, with Notion and Gmail.

## Tests

In the two-daemon test (`crewd/src/lib.rs:3071`) and `flow.rs`, replacing
`a_machine_that_is_not_the_vault_calls_with_leases_…`:

- A session on B calls a connector and a Google app. The service and the fake
  `gws` are reached only from A, and `gws` never runs on B.
- `vault_lease` answers "not for this connection". No frame sent to a peer,
  across a whole run, contains the grant's access or refresh token (a move's
  sealed bundle is checked by the existing seal test).
- A tool switched off on A is refused for B, even with B's copy still stale.
- A slow call doesn't delay a second call or `vault-config`.
- A revoked machine's open connection stops working on its next request.
- The vault offline: the "offline since" line, nothing retried.
- The link cut mid-call: the "may have run" line, and the fake server saw one
  call.
- An expired handoff doesn't block calls, and a move waits for a call in flight.
- An answer over the cap is a tool error, and the link stays up.
- The vault's log for a call holds neither its arguments nor its answer.

## Status

Built, and the tests above pass, with these limits:

- That the vault's log holds no arguments is checked in the trial below, not in a unit test: the
  log goes to stderr.
- **Tried 2026-11-02** with real processes over Tailscale: a vault on this Mac
  through its tailnet listener, a member on falcon-heavy in a folder of its own
  beside its real `crewd`, the connector's real stdio shim, and the fake service
  on this Mac's loopback, which falcon-heavy can't reach. Calls, switches, the
  vault dying mid-call, coming back, revoking and the sealed move all behaved as
  above, and neither token was on falcon-heavy's disk or logs. Its process
  memory couldn't be scanned (`ptrace_scope` is 1).
- **Not tried yet:** a real service (Notion, Gmail), which needs a sign-in in
  the app, and the page itself with several machines.
- One stdio shim answers its lines in order, as it did before this change, so
  a slow call holds up later calls to the same server in one session. Other
  sessions and servers aren't affected.
