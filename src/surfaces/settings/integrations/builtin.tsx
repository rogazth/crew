// What a built-in connector says about itself: one that ships with Crew and
// calls a provider's API (or an open source tool), not a server the provider
// runs. Its summary and its page end on the same line with a Learn more; the dialog it opens is
// the same for every built-in connector, so it names none.
import { Button } from '../../../chrome/kit';
import { openLink } from '../../../lib/external';
import { Dialog, DialogFooter, DialogHeader } from './dialog';
import { ui } from './lib';

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
