# Google's apps as connectors, and Figma

Drafted 2026-10-28, on `prototype/integrations-ui`. Two services the registry
can't give Crew today: Figma refuses Crew's sign-in, and Google has no MCP
server for Gmail or Drive. The page's look is in a throwaway prototype
(`src/surfaces/settings/integrations/prototype-google.tsx`, dev builds only). Builds on
`2026-10-23-integrations.md` (vault, accounts, bindings, leases).

## Why

- Figma's server (`mcp.figma.com`) takes registrations only from clients it
  approved, by `client_name`: `"Crew"` gets `Forbidden`, `"Claude Code"` gets a
  client (checked 2026-10-28, registration only).
- Google's MCP servers in the registry are Cloud's (`*.googleapis.com/mcp`);
  `gmail.` and `drive.googleapis.com/mcp` answer 404. What's there for Gmail is
  third-party proxies that read the mail, or local packages Crew doesn't run.
- `gws` (googleworkspace/cli) covers Gmail, Drive, Calendar, Docs, Sheets and
  more from the shell, but each machine signs in on its own: no distribution.
  It takes a ready access token in `GOOGLE_WORKSPACE_CLI_TOKEN`, which is
  what makes a lease fit.
- Google does have official MCP servers per product
  (`gmailmcp.googleapis.com/mcp/v1`, `drivemcp.`, `calendarmcp.`, `docsmcp.`,
  `sheetsmcp.`), but in Developer Preview, behind an application, without
  DCR, and with fewer tools (Gmail there can't send).

## Figma

- `oauth::register` sends `client_name: "Claude Code"` when the issuer is
  `api.figma.com`; everything else stays `"Crew"`. One table of overrides by
  issuer, so a second case is a line.
- Drop `com.figma.mcp/mcp` from `KNOWN_REFUSALS` (`store.ts`).
- Its page says it in About: "Signs in as · Claude Code".
- Risks: it breaks without warning if Figma checks more than the name; it is
  against Figma's terms once Crew ships to others. Before distributing, ask
  Figma to approve Crew as a client and remove the override.
- Not tried yet: the browser consent and a tool call with the token. Try both
  before building the rest.

## Google: the OAuth client

**Crew's own client, not one per user.** A per-user client means a Google
Cloud project, a consent screen and a client per person: few finish it, and
it doesn't make anyone safer, since the data path is the same. What earns
trust is that the data never reaches Crew:

- Client type "Desktop app", PKCE, loopback redirect, as `gws auth login`
  does. Its secret isn't secret (Google says so for installed apps); the
  tokens are what matter, and they stay in the vault.
- Crew has no server. The refresh token is in the vault (the keychain on
  macOS); a session gets an access token for an hour; mail and files go
  from `gws` to Google. Say this in the connect sheet and on the page.
- A privacy policy page stating the same, and Google's Limited Use
  disclosure. Both are needed for verification anyway.

Google's side:

- Gmail read (`gmail.readonly`, `gmail.modify`) and full Drive are
  *restricted* scopes. Until the app is verified it shows "Google hasn't
  verified this app" and is capped at 100 users. Verification for restricted
  scopes asks for a yearly security assessment; budget it before 100 users.
- Publish the consent screen to production even unverified: in "Testing",
  refresh tokens die after 7 days.
- Ask per service, incrementally (`include_granted_scopes=true`):
  `gmail.send` and Calendar are only *sensitive*, `drive.file` is neither.
  Someone who wants Calendar alone never sees the restricted warning.
- Workspace domains can block unverified apps; their admin allows Crew's
  client ID. Say it when Google answers `admin_policy_enforced`.

**Bring your own client** stays as an advanced option on the page (client ID
and secret, kept in the vault): for a domain that only allows internal apps,
and for whoever wants it. Not the default.

## Google: the design

- **One connector per app: Gmail, Drive, Calendar, Docs, Sheets** (picked
  2026-10-28). Each installs on its own from Browse, with its own tile, page,
  bindings and tools; someone who wants Gmail alone never grants Drive.
  The page never says `gws`.
- **Shown apart, and unofficial, but like any other.** Browse lists them
  above the registry under "Built in", without the registry's check, and
  they behave as the registry's rows do: the row opens a summary, Install
  signs in at once (Google's own picker asks which account), and the page is
  a connector's, with "Built in" as its publisher and the API as its server.
  The summary and the page both end with a small centered "Unofficial, not
  affiliated with Google. Learn more". Learn more opens one dialog for every built-in
  connector (`builtin.tsx`, naming none): Crew builds them in for services
  without an MCP server, they call the APIs providers publish or run open
  source tools from the person's machine, nothing passes through our
  servers, the sign-in stays in the keychain, and each one's code is in
  Crew's repository, linked in the text. Three short paragraphs, no bullets. Never "Made by". The real cover is still the license's
  "as is" and Crew having no servers; the words only make that plain.
- **One Google sign-in under them.** The vault keeps one grant per Google
  account; each app is a set of scopes on it. Installing a second app offers
  the account already signed in ("Continue as …") and asks Google for that
  app's scopes alone (`include_granted_scopes=true`); "Use another account"
  starts a fresh grant. Removing an app gives back its scopes; removing the
  last one revokes the grant (`oauth2.googleapis.com/revoke`).
- **crewd is the MCP server.** Each app's tools are served by `crewd` through
  the connector shim that exists (`crewd --mcp-connector`), so every CLI and
  every machine gets them as any connector's: per-tool switches, read-only
  and destructive hints, token cost, bindings. A remote session forwards its
  `tools/call` like a connector's today; the token never leaves the vault's
  machine, and nothing is installed anywhere else.
- **gws does the calls.** A tool is a short entry: name, the `gws` command
  it runs (`gws gmail +send`, `gws drive files list`…), hints. Its
  `inputSchema` is built from `gws schema <service.resource.method>`, so
  schemas aren't written by hand; helpers (`+send`, `+reply`, `--upload`)
  spare MIME and multipart. `crewd` runs it with the lease in
  `GOOGLE_WORKSPACE_CLI_TOKEN`.
- **gws pinned, not auto-updated.** It's 0.x and "not an officially
  supported Google product", and it holds the tokens: `crewd` downloads one
  version, checked by checksum, into its data folder on the vault's machine,
  and a Crew release bumps it once the tools' tests pass.
- **Swappable per tool.** A tool that breaks moves to the REST call; once in
  the preview, an app's tools move to Google's own server. The UI doesn't
  change.
- **Tools to start** (prompt injection is Google's own warning: anything
  that sends or deletes can be turned off):
  - Gmail: `search_threads`, `read_thread`, `list_labels`, `create_draft`,
    `send_message`, `modify_labels`, `trash_thread`.
  - Drive: `search_files`, `read_file`, `list_folder`, `upload_file`,
    `create_folder`, `share_file`, `trash_file`.
  - Calendar: `list_events`, `find_free_time`, `create_event`,
    `update_event`, `delete_event`.
  - Docs: `read_document`, `create_document`, `edit_document`.
  - Sheets: `read_range`, `list_sheets`, `create_spreadsheet`,
    `write_range`, `clear_range`.
- **Several accounts per app**, as connectors: Accounts lists them with "Add
  another account", pills pick the one Where and Tools show, and each has
  its own bindings and tools off. Adding one opens Google's sign-in, whose
  picker shows the accounts already signed in. A session gets one account per app:
  with two bound, the most specific binding wins. Removing an account from
  an app gives back that app's scopes; the others stay signed in.

## Open questions

- Should the CLI's own `gws auth` login, when a machine has one, be imported
  or ignored?
- Does `upload_file` read from the session's folder on a remote machine? The
  call runs on the vault's machine, so the file has to travel with it.

## Phases

1. Figma: the override, consent and a tool call tried for real.
2. Google's client: Cloud project, consent screen in production, privacy
   page.
3. `crew-core`: a Google grant shared by apps with their scopes, `crewd` as
   the apps' MCP server, the tools over a pinned `gws`.
4. The pages, one per app; remove the prototype.
5. Verification with Google, before 100 users.

## Status

| Part | State |
| --- | --- |
| Prototype: an app per connector, Figma installable in the mock | done |
| Figma `client_name` override | built (`oauth::client_name`); consent and a tool call to try |
| Google OAuth client and consent screen | todo |
| Google apps served by `crewd` over `gws` | todo |
| Verification | todo |
