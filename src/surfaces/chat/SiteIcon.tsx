import { GlobeIcon } from "lucide-react";
import { useState } from "react";

/** Offline, or a site with no favicon: one neutral globe rather than a catalogue of brand marks. */
const GLOBE = <GlobeIcon className="crew-site-icon" aria-hidden />;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}


/**
 * The site's real favicon, fetched through Google's resolver (allowed in the
 * CSP's img-src). When there is none the resolver answers with its own 16px
 * globe rather than a 404, so the size is what tells a hit from a miss; either
 * way the globe takes over.
 */
export function SiteIcon({ url }: { url: string }) {
  const host = hostOf(url);
  const [failed, setFailed] = useState(false);
  if (!host || failed) return GLOBE;
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`}
      className="crew-site-icon"
      alt=""
      loading="lazy"
      onError={() => setFailed(true)}
      onLoad={(event) => {
        if (event.currentTarget.naturalWidth <= 16) setFailed(true);
      }}
    />
  );
}
