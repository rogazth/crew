/** The host a link points at, without `www.`; empty when the URL does not parse. */
export function siteHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** The first of `domains` the host is, or is a subdomain of. */
export function siteDomain(host: string, domains: readonly string[]): string | null {
  return domains.find((domain) => host === domain || host.endsWith(`.${domain}`)) ?? null;
}

/** Google's favicon resolver, which the CSP's img-src allows. */
export function faviconUrl(host: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;
}

/** With no favicon the resolver answers its own 16px globe instead of a 404; the size gives it away. */
export function isPlaceholderFavicon(naturalWidth: number): boolean {
  return naturalWidth <= 16;
}
