import type { ReactNode } from "react";
import { extensionOf } from "./attachments";
import { isHeadingOnly } from "./markdownRuns";

/** `src/lib/tabs.ts`, `README.md`, `./x.css`: a path with an extension and no spaces. */
const PATH_LIKE = /^(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[a-z0-9]{1,8}$/i;

/** What a `code` element holds, as the one string it spells. */
export function codeText(children: ReactNode): string {
  if (typeof children === "string") return children;
  return Array.isArray(children) ? children.join("") : String(children ?? "");
}

/** The fence's language from `language-ts`, if it named one. */
export function fenceLang(className: string | undefined): string | undefined {
  return /language-([\w+-]+)/.exec(className ?? "")?.[1];
}

/** Inline code that names a file becomes a chip that opens it. */
export function isFileLike(text: string): boolean {
  return PATH_LIKE.test(text) && extensionOf(text) !== "";
}

export type LinkTarget = {
  /** Where a click goes outside the app. */
  url: string | undefined;
  /** A footnote's ref or backref: an element id in this same message. */
  anchor: string | undefined;
  /** Set for http(s), the links that get a site icon. */
  web: string | undefined;
};

export function linkTarget(href: string | undefined): LinkTarget {
  const anchor = href?.startsWith("#") ? href.slice(1) : undefined;
  const url = href && anchor === undefined && !href.startsWith("streamdown:") ? href : undefined;
  const web = url && /^https?:\/\//i.test(url) ? url : undefined;
  return { url, anchor, web };
}

/** Wide runs take the column; a heading alone is a label; the rest is a prose bubble. */
export function runKind(kind: "prose" | "wide", text: string): "wide" | "label" | "prose" {
  if (kind === "wide") return "wide";
  return isHeadingOnly(text) ? "label" : "prose";
}
