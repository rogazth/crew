import { GlobeIcon } from "lucide-react";
import { useState } from "react";

/** Offline, or a site with no favicon, where a row keeps a slot for it: one neutral globe. */
const GLOBE = <GlobeIcon className="crew-site-icon" aria-hidden />;

/** What each host's favicon turned out to be, for the run: a link drawn again shows it at once. */
const found = new Map<string, boolean>();

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const iconUrl = (host: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

/**
 * The site's real favicon, fetched through Google's resolver (allowed in the
 * CSP's img-src). When there is none the resolver answers with its own 16px
 * globe rather than a 404, so the size is what tells a hit from a miss. The
 * image stays hidden until it proves a hit: a miss leaves nothing, or the
 * globe with `globe`, for a row that keeps a slot for the icon.
 */
export function SiteIcon({ url, globe = false }: { url: string; globe?: boolean }) {
  const host = hostOf(url);
  const [hit, setHit] = useState<boolean | undefined>(() => found.get(host));
  const miss = globe ? GLOBE : null;
  if (!host || hit === false) return miss;
  const settle = (ok: boolean) => {
    found.set(host, ok);
    setHit(ok);
  };
  return (
    <>
      {hit === undefined ? miss : null}
      <img
        src={iconUrl(host)}
        className="crew-site-icon"
        alt=""
        // Hidden while it loads, and a lazy image that is not drawn never loads.
        loading={hit ? "lazy" : "eager"}
        style={hit ? undefined : { display: "none" }}
        onError={() => settle(false)}
        onLoad={(event) => settle(event.currentTarget.naturalWidth > 16)}
      />
    </>
  );
}
