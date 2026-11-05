// Adding a connector: the directory as a page (the MCP Registry, searchable,
// with what you have marked), and over it in dialogs a server's summary
// before you install it, and a custom connector for a remote server the
// directory doesn't list, by its URL.
import {
  ArrowLeftIcon,
  BadgeCheckIcon,
  CheckIcon,
  GlobeIcon,
  PlusIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useState } from 'react';
import { openLink } from '../../../lib/external';
import { Button, EmptyState, Field, IconButton, PAGE_TITLE, SearchField, TextInput, Tooltip } from '../../../chrome/kit';
import type { RegistryServer } from '../../../lib/protocol';
import { SettingsPage } from '../ui';
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from './dialog';
import { hostOf, openConnector, ui, useEscape, useUi } from './lib';
import { brandOfServer } from './brand';
import { ServiceMark } from './mark';
import { useRegistry } from './registry';
import { refusalDocsOf, refusalOf, useIntegrations } from './store';
import { BuiltinRows } from './builtin';

// Going back from a summary finds the search as it was left.
let lastQuery = '';

/** A search's results come this many at a time, up to what the daemon answers at most. */
const PAGE = 60;
const MAX = 600;

/* ── The directory ──────────────────────────────────────────────────── */

/** The directory as its own page (the strip above says Connectors › Browse): a search, and the registry in two columns. */
export function DirectoryPage() {
  const s = useIntegrations();
  const { sheet } = useUi();
  const [query, setQueryState] = useState(lastQuery);
  const [limit, setLimit] = useState(PAGE);
  const setQuery = (next: string) => {
    lastQuery = next;
    setQueryState(next);
    setLimit(PAGE);
  };
  const { servers, loading, loadingMore, more, error } = useRegistry(query, limit);
  const q = query.trim();
  const installed = (server: RegistryServer) => s.connectors.find((c) => c.registryName === server.name);
  // Suggestions leave out what you have; a search finds it too, marked.
  const list = q ? servers : servers.filter((x) => !installed(x));
  const pick = (server: RegistryServer) => {
    const connector = installed(server);
    if (connector) openConnector(connector.id);
    else ui.open({ kind: 'summary', server, back: true });
  };
  const home = () => ui.go('home');
  useEscape(sheet ? noop : home);
  return (
    <SettingsPage title="Browse connectors" hideHeader>
      <header className="flex items-center gap-2 px-1">
        <IconButton icon={ArrowLeftIcon} label="Back to Connectors" className="-ml-1.5 size-8" onClick={home} />
        <h1 className={`min-w-0 flex-1 truncate ${PAGE_TITLE}`}>Browse connectors</h1>
        <Button icon={PlusIcon} onClick={() => ui.open({ kind: 'custom' })}>
          Custom
        </Button>
      </header>
      <div className="flex flex-col gap-3">
        <SearchField autoFocus value={query} label="Search" onChange={setQuery} />
        <BuiltinRows query={query} />
        <p className="mt-2 -mb-2.5 px-1 text-[13px] text-text-muted">
          {error
            ? 'Couldn’t reach the MCP Registry.'
            : q
              ? loading
                ? 'Searching…'
                : `${list.length} ${list.length === 1 ? 'result' : 'results'}`
              : 'Popular'}
        </p>
        <div className="grid grid-cols-1 gap-x-6 px-1 @[620px]:grid-cols-2">
          {loading && list.length === 0
            ? Array.from({ length: 8 }, (_, i) => <RowSkeleton key={i} />)
            : list.map((server) => (
                <DirectoryRow
                  key={server.name}
                  server={server}
                  installed={!!installed(server)}
                  onPick={() => pick(server)}
                />
              ))}
        </div>
        {q && !loading && more && limit < MAX && (
          <Button className="self-center" loading={loadingMore} onClick={() => setLimit((n) => n + PAGE)}>
            Load more
          </Button>
        )}
        {!loading && q && list.length === 0 && (
          <EmptyState
            title={`No results for “${q}”`}
            action={
              <Button size="sm" onClick={() => ui.open({ kind: 'custom' })}>
                Add a custom connector
              </Button>
            }
          />
        )}
      </div>
    </SettingsPage>
  );
}

const noop = () => {};

/** Install signs in at once, in the vault; the summary is for reading first. */
const install = (server: RegistryServer) => ui.open({ kind: 'connect', source: { kind: 'registry', server } });

/** A vendor's own server installs from its row; anyone else's, or one Crew can't sign in to, shows its summary first. */
const installFromRow = (server: RegistryServer) =>
  server.firstParty && !refusalOf(server.name) ? install(server) : ui.open({ kind: 'summary', server, back: true });

/** The name, with a check when the server is on its publisher's own domain. */
function ServerName({ server, name, check = true }: { server: RegistryServer; name: string; check?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span className="truncate">{name}</span>
      {check && server.firstParty && (
        <Tooltip content={`Verified publisher · served from ${server.publisher}`} render={<span className="shrink-0" />}>
          <BadgeCheckIcon aria-label="Verified publisher" className="size-3.5 text-info" />
        </Tooltip>
      )}
    </span>
  );
}

function DirectoryRow({
  server,
  installed,
  onPick,
}: {
  server: RegistryServer;
  installed: boolean;
  onPick: () => void;
}) {
  const brand = brandOfServer(server);
  // A server Crew can't sign in to stays in the list, dimmed and without the check.
  const refused = !!refusalOf(server.name);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), onPick())}
      className={`-mx-2 flex h-16 min-w-0 cursor-default items-center gap-3 rounded-xl px-2 outline-none focus-visible:ring-2 focus-visible:ring-focus/50 ${refused ? 'opacity-60' : ''}`}
    >
      <ServiceMark brand={brand} size={40} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">
          <ServerName server={server} name={brand.name} check={!refused} />
        </span>
        <span className="truncate text-[12px] text-text-muted">{server.description || server.publisher}</span>
      </span>
      {installed ? (
        <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-text-muted">
          <CheckIcon className="size-3.5" />
          Installed
        </span>
      ) : (
        <button
          type="button"
          onClick={(event) => (event.stopPropagation(), installFromRow(server))}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-7 shrink-0 items-center rounded-full bg-card px-3 text-[12.5px] font-medium outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          Install
        </button>

      )}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="flex h-16 items-center gap-3">
      <span className="size-10 shrink-0 animate-pulse rounded-[26%] bg-selected" />
      <span className="flex flex-1 flex-col gap-1.5">
        <span className="h-3 w-24 animate-pulse rounded bg-selected" />
        <span className="h-2.5 w-40 animate-pulse rounded bg-selected" />
      </span>
    </div>
  );
}

/* ── A server before you install it ─────────────────────────────────── */

/** What it is (the registry’s words), who makes it, and the one button. Over the directory it needs no Cancel: closing it is going back. */
export function SummaryDialog({ server, back = false }: { server: RegistryServer; back?: boolean | undefined }) {
  const brand = brandOfServer(server);
  // A server that refused Crew's sign-in earlier this run says why, and can't be installed again from here.
  const refused = refusalOf(server.name);
  const docs = refusalDocsOf(server.name);
  return (
    <Dialog label={brand.name}>
      <DialogHeader
        mark={<ServiceMark brand={brand} size={40} />}
        title={<ServerName server={server} name={brand.name} check={!refused} />}
        subtitle={server.description || `By ${server.publisher}`}
        wrap
      />
      {refused ? (
        <div className="mx-4 mb-4 flex gap-2.5 rounded-xl bg-card px-3 py-2.5 text-[12.5px]">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
          <p>
            <span className="block font-medium">Not supported.</span>
            {refused}
            {docs && (
              <>
                {' '}
                <button type="button" onClick={() => openLink(docs)} className="underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-focus/50">
                  Learn more
                </button>
              </>
            )}
          </p>
        </div>
      ) : (
        <Trust server={server} />
      )}
      <DialogGroup>
        <DialogRow title="Server" subtitle={hostOf(server.remoteUrl) || server.remoteUrl} />
        <DialogRow title="Registry" subtitle={server.name} />
      </DialogGroup>
      <DialogFooter>
        {(!back || refused) && (
          <Button variant="ghost" onClick={ui.close}>
            {refused ? 'Close' : 'Cancel'}
          </Button>
        )}
        {!refused && (
          <Button variant="primary" onClick={() => install(server)}>
            Install
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** Who answers for the server, before its sign-in hands it an account. */
function Trust({ server }: { server: RegistryServer }) {
  if (server.firstParty)
    return (
      <p className="px-5 pb-2 text-[12.5px] text-text-muted">
        Agents will act on your behalf in {server.title ?? server.publisher}.
      </p>
    );
  return (
    <div className="mx-4 mb-4 flex gap-2.5 rounded-xl bg-card px-3 py-2.5 text-[12.5px]">
      <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="text-text-muted">
        <span className="block font-medium text-text">Not from {server.publisher}’s own domain.</span>
        Not reviewed. Install only if you trust the author.
      </p>
    </div>
  );
}

/* ── A custom connector ─────────────────────────────────────────────── */

/** A name from what was typed: the host's main word. */
function guessName(target: string): string {
  const word =
    hostOf(target)
      .replace(/^(www|mcp|api)\./, '')
      .split('.')[0] ?? '';
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
}

/** A remote server by its URL; it signs in like any connector. */
export function CustomDialog() {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const target = url.trim();
  const ok = /^https:\/\/[^\s/]+\.[^\s]+/.test(target);
  const fallback = ok ? guessName(target) : '';
  const add = () =>
    ui.open({ kind: 'connect', source: { kind: 'url', url: target, name: name.trim() || fallback || null } });
  return (
    <Dialog label="Custom connector">
      <DialogHeader
        mark={
          <span className="grid size-10 shrink-0 place-items-center rounded-[26%] bg-card ring-1 ring-hairline">
            <GlobeIcon className="size-5 text-icon" />
          </span>
        }
        title="Custom connector"
      />
      <form
        className="flex flex-col gap-4 px-5 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (ok) add();
        }}
      >
        <Field label="Server URL">
          <TextInput
            autoFocus
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://mcp.example.com/mcp"
          />
        </Field>
        <Field label="Name">
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={fallback || 'Optional'}
          />
        </Field>
        <button type="submit" hidden />
      </form>
      <DialogFooter
        start={
          <Button variant="ghost" onClick={ui.close}>
            Cancel
          </Button>
        }
      >
        <Button variant="primary" disabled={!ok} onClick={add}>
          Install
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
