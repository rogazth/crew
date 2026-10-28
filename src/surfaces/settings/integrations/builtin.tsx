// What a built-in connector says about itself: one that ships with Crew and
// calls a provider's API (or an open source tool), not a server the provider
// runs. Browse lists them above the registry, under "Built in", without the
// registry's check; the row opens a summary, Install signs in at once. Its
// summary and its page end on the same line with a Learn more; the dialog it
// opens is the same for every built-in connector, so it names none.
import { CheckIcon } from 'lucide-react';
import { Button, Tooltip } from '../../../chrome/kit';
import { openLink } from '../../../lib/external';
import type { BuiltinConnector } from '../../../lib/protocol';
import type { Brand } from './brand';
import { Dialog, DialogFooter, DialogGroup, DialogHeader, DialogRow } from './dialog';
import { openConnector, ui } from './lib';
import { ServiceMark } from './mark';
import { useIntegrations } from './store';

// Where the integrations' code is read: the same repository About links.
const REPO_URL = 'https://github.com/rogazth/crew';

/** Learn more, inline after a line of text. */
function BuiltInLink() {
  return (
    <button
      type="button"
      onClick={() => ui.open({ kind: 'built-in' })}
      className="underline underline-offset-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
    >
      Learn more
    </button>
  );
}

/** The last line of a built-in connector's summary and page, centered: not the provider's own, and Learn more. */
export function UnofficialNote({ vendor, className = 'px-1' }: { vendor: string; className?: string }) {
  return (
    <p className={`${className} text-center text-[12px] text-pretty text-text-muted`}>
      Unofficial, not affiliated with {vendor}. <BuiltInLink />
    </p>
  );
}

export const brandOfBuiltin = (builtin: BuiltinConnector): Brand => ({
  id: builtin.id,
  name: builtin.name,
  publisher: 'Built in',
  logo: builtin.iconUrl,
});

/** Whose service a built-in's family calls, for its unofficial line. */
export const vendorOf = (family: string) => (family === 'google' ? 'Google' : family);

const install = (builtin: BuiltinConnector) => ui.open({ kind: 'connect', source: { kind: 'builtin', builtin } });

/** Browse's "Built in" rows, above the registry's: those a search matches, marked when installed. */
export function BuiltinRows({ query }: { query: string }) {
  const s = useIntegrations();
  const q = query.trim().toLowerCase();
  const shown = s.builtins.filter((b) => !q || `${b.family} ${b.name} ${b.description}`.toLowerCase().includes(q));
  if (shown.length === 0) return null;
  return (
    <>
      <p className="mt-2 -mb-2.5 px-1 text-[13px] text-text-muted">Built in</p>
      <div className="grid grid-cols-1 gap-x-6 px-1 @[620px]:grid-cols-2">
        {shown.map((builtin) => (
          <BuiltinRow key={builtin.id} builtin={builtin} installed={s.connectors.find((c) => c.builtin === builtin.id)?.id} />
        ))}
      </div>
    </>
  );
}

function BuiltinRow({ builtin, installed }: { builtin: BuiltinConnector; installed: string | undefined }) {
  const pick = () => (installed ? openConnector(installed) : ui.open({ kind: 'builtin-summary', builtin }));
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={pick}
      onKeyDown={(event) => (event.key === 'Enter' || event.key === ' ') && (event.preventDefault(), pick())}
      className={`-mx-2 flex h-16 min-w-0 cursor-default items-center gap-3 rounded-xl px-2 outline-none focus-visible:ring-2 focus-visible:ring-focus/50 ${builtin.unavailable ? 'opacity-60' : ''}`}
    >
      <ServiceMark brand={brandOfBuiltin(builtin)} size={40} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{builtin.name}</span>
        <span className="truncate text-[12px] text-text-muted">{builtin.description}</span>
      </span>
      {installed ? (
        <span className="flex shrink-0 items-center gap-1 text-[12.5px] text-text-muted">
          <CheckIcon className="size-3.5" />
          Installed
        </span>
      ) : builtin.unavailable ? (
        <Tooltip content={builtin.unavailable} render={<span className="shrink-0 text-[12.5px] text-text-muted" />}>
          Not set up
        </Tooltip>
      ) : (
        <button
          type="button"
          onClick={(event) => (event.stopPropagation(), install(builtin))}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex h-7 shrink-0 items-center rounded-full bg-card px-3 text-[12.5px] font-medium outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50"
        >
          Install
        </button>
      )}
    </div>
  );
}

/** What the row opens: a summary like a registry server's, with "Built in" as its publisher. */
export function BuiltinSummaryDialog({ builtin }: { builtin: BuiltinConnector }) {
  return (
    <Dialog label={builtin.name}>
      <DialogHeader mark={<ServiceMark brand={brandOfBuiltin(builtin)} size={40} />} title={builtin.name} subtitle={builtin.description} wrap />
      <p className="px-5 pb-2 text-[12.5px] text-text-muted">Agents will act on your behalf in {builtin.name}.</p>
      <DialogGroup>
        <DialogRow title="Publisher" subtitle="Built in" />
        <DialogRow title="Server" subtitle={builtin.server} />
        {builtin.unavailable && <DialogRow title="Not set up" subtitle={builtin.unavailable} />}
      </DialogGroup>
      <UnofficialNote vendor={vendorOf(builtin.family)} className="px-5 pb-4" />
      <DialogFooter>
        <Button variant="primary" disabled={!!builtin.unavailable} onClick={() => install(builtin)}>
          Install
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** What a built-in connector is, and where to read how it's made. */
export function BuiltInDialog() {
  return (
    <Dialog label="Built-in connectors">
      <DialogHeader mark={null} title="Built-in connectors" />
      <div className="flex flex-col gap-3 px-5 pb-5 text-[13px] text-pretty text-text-muted">
        <p>Crew builds some connectors in, for services that have no MCP server of their own.</p>
        <p>
          They call the APIs each provider publishes, or run open source tools, straight from your machine. Nothing
          passes through our servers, and your sign-in stays in your vault.
        </p>
        <p>
          Curious how they’re built? Crew is open source, so every one of them is in{' '}
          <button
            type="button"
            onClick={(e) => openLink(REPO_URL, e)}
            className="underline underline-offset-2 outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus/50"
          >
            its repository
          </button>
          .
        </p>
      </div>
      <DialogFooter>
        <Button variant="primary" onClick={ui.close}>
          Done
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
