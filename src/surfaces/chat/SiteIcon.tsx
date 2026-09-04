import {
  AppleLogoIcon,
  DiscordLogoIcon,
  FigmaLogoIcon,
  GithubLogoIcon,
  GitlabLogoIcon,
  GlobeSimpleIcon,
  GoogleLogoIcon,
  LinkedinLogoIcon,
  MediumLogoIcon,
  NotionLogoIcon,
  RedditLogoIcon,
  SlackLogoIcon,
  StackOverflowLogoIcon,
  XLogoIcon,
  YoutubeLogoIcon,
} from "@phosphor-icons/react";
import { useState, type ReactElement } from "react";

/** A brand mark reads as itself only filled; bold leaves it an outline. */
const mark = { weight: "fill", className: "crew-site-icon", "aria-hidden": true } as const;

const SITES: Record<string, ReactElement> = {
  "github.com": <GithubLogoIcon {...mark} />,
  "github.io": <GithubLogoIcon {...mark} />,
  "gitlab.com": <GitlabLogoIcon {...mark} />,
  "x.com": <XLogoIcon {...mark} />,
  "twitter.com": <XLogoIcon {...mark} />,
  "youtube.com": <YoutubeLogoIcon {...mark} />,
  "youtu.be": <YoutubeLogoIcon {...mark} />,
  "linkedin.com": <LinkedinLogoIcon {...mark} />,
  "reddit.com": <RedditLogoIcon {...mark} />,
  "stackoverflow.com": <StackOverflowLogoIcon {...mark} />,
  "stackexchange.com": <StackOverflowLogoIcon {...mark} />,
  "figma.com": <FigmaLogoIcon {...mark} />,
  "discord.com": <DiscordLogoIcon {...mark} />,
  "discord.gg": <DiscordLogoIcon {...mark} />,
  "slack.com": <SlackLogoIcon {...mark} />,
  "notion.so": <NotionLogoIcon {...mark} />,
  "notion.com": <NotionLogoIcon {...mark} />,
  "google.com": <GoogleLogoIcon {...mark} />,
  "apple.com": <AppleLogoIcon {...mark} />,
  "medium.com": <MediumLogoIcon {...mark} />,
};

const GLOBE = <GlobeSimpleIcon className="crew-site-icon" aria-hidden />;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function glyphFor(host: string): ReactElement {
  for (const [domain, glyph] of Object.entries(SITES)) {
    if (host === domain || host.endsWith(`.${domain}`)) return glyph;
  }
  return GLOBE;
}

/**
 * The site's real favicon, fetched through Google's resolver (allowed in the
 * CSP's img-src). When there is none the resolver answers with its own 16px
 * globe rather than a 404, so the size is what tells a hit from a miss; either
 * way a local glyph takes over.
 */
export function SiteIcon({ url }: { url: string }) {
  const host = hostOf(url);
  const [failed, setFailed] = useState(false);
  if (!host || failed) return glyphFor(host);
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
