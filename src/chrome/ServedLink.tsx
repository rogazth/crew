import { ArrowUpRightIcon } from "lucide-react";
import { useBrowserPrefs } from "../hooks/useBrowserPrefs";
import { BROWSER_CLICK, openLink } from "../lib/external";
import { urlLabel } from "../lib/processes";

/** Where a run serves, as a link: what a dev server printed, one click from a browser. */
export function ServedLink({ url, className = "" }: { url: string; className?: string }) {
  const { prefs } = useBrowserPrefs();
  return (
    <a
      href={url}
      title={prefs.openLinksInCrew ? `Open ${url}\n${BROWSER_CLICK}-click to open in your browser` : `Open ${url} in your browser`}
      onClick={(event) => {
        event.preventDefault();
        openLink(url, event);
      }}
      className={`inline-flex min-w-0 shrink items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] text-link outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus/50 ${className}`}
    >
      <span className="truncate">{urlLabel(url)}</span>
      <ArrowUpRightIcon className="size-3 shrink-0" />
    </a>
  );
}
