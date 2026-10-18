# Browser tools from remote machines

Decided 2026-10-15. Agents on a remote `crewd` (a bot, a session, `crew tabs`
in a remote terminal) drive the tabs of their workspace, which live in Crew's
browser on the Mac.

## What was there

- Main registers as the browser host with this Mac's `crewd` only. A remote
  `crewd` has no host, so every browser tool answers "Open Crew".
- A strip is saved in this Mac's daemon (`state_set` is local), remote
  workspaces' too. A remote `crewd` knows none of its workspaces' tabs, and
  two Macs on one remote each have their own.
- The relay holds one host; the newest registration replaces it.
- The window keeps one lease list, so whichever daemon spoke last wins.
  `browser_lease_release` and `browser_tab_closed` always go to this Mac.

## Design

- **Every Mac is a host at once.** Main links to its own daemon and to each
  machine in the address book. The relay keeps every registered host. A tab is
  driven on the host that reported it. `open_tab` goes to the host that was
  focused last (or registered last).
- **A host reports its pages.** To a remote, main sends `browser_host_pages`
  with the tabs of that remote's workspaces (from this Mac's strips, and
  that remote's `workspace_list`), on register and when a strip changes. This
  Mac's `crewd` says a strip changed with `browser-pages-changed`, and lists
  them with `browser_pages_list`. A remote holds the pages in memory, by host.
  Its own store has no strips.
- **Scope.** `crewd` already scopes every tool to the caller's workspace.
  Main checks it again for a remote: a call is only run on a tab it reported
  to that remote, or an `open_tab` into one of that remote's workspaces.
- **Liveness.** Main acks each `browser-call` when it arrives. A host that
  declared acks and does not ack within 8 s fails the call ("did not answer:
  asleep or offline"), instead of waiting the whole budget on a Mac that went
  to sleep without closing its socket. Main closes its remote links on
  suspend and dials again on resume. A dropped remote link retries with
  backoff up to 15 s.
- **Messages.** On a remote: no Mac connected says no Mac with Crew open is
  connected to this machine. A tab whose Mac went away says so, and points to
  list_tabs. With more than one Mac, `list_tabs` names the Mac of each tab.
- **Payloads.** A screenshot from a remote link goes as JPEG when that is
  smaller.
- **Window.** Leases are kept per daemon and merged. Release and close carry
  the tab's workspace, so they reach the daemon that holds the lease.
- **Deadlines.** Each call carries its budget (`timeoutMs`), and main counts it
  from when the call arrives: a remote's clock is not the Mac's.

## Status

| Part | State |
| --- | --- |
| Relay with many hosts, pages, focus, acks (`crew-core`) | done |
| `crewd`: register hello, pages, focus, ack, `browser_pages_list`, `browser-pages-changed` | done |
| Main: a link per machine, gate, leases of every daemon, suspend, JPEG | done |
| Window: leases per daemon, release and close by workspace | done |
| e2e: one Mac, two Macs, a Mac asleep, a machine restarting, Crew closing | done |

Measured on the e2e link (60 ms each way): a snapshot takes about 125 ms, one
round trip and the work.

Left as it was: a workspace made outside the window (the CLI, a remote's RPC)
gets no tab from `open_tab` until the window lists it.

