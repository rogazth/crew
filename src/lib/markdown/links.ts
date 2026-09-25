import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import * as api from "../api";
import { openLink } from "../external";
import { followWikiLink, noteHost, resolvePath } from "./wikilinks";

/** A new note for a link that named nothing; an existing file is never touched. */
async function createNote(path: string): Promise<void> {
  if (await api.pathExists(path)) return;
  await api.writeTextFile(path, "");
}

const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/** A link destination: a URL leaves the app, a relative path opens as a tab. */
export function followUrl(state: EditorState, url: string) {
  if (EXTERNAL.test(url)) {
    openLink(url);
    return;
  }
  const host = state.facet(noteHost);
  let decoded = url.replace(/^<|>$/g, "");
  try {
    decoded = decodeURI(decoded);
  } catch {
    // A stray `%` is a literal one.
  }
  const [path, heading] = decoded.split("#") as [string, string | undefined];
  if (!path) {
    host.open(host.path, heading);
    return;
  }
  host.open(resolvePath(host.path, path), heading);
}

/** Follows a rendered link or wikilink under `target`; false when there is none. */
export function followRendered(target: EventTarget | null, view: EditorView): boolean {
  const el = target instanceof Element ? target.closest<HTMLElement>("[data-url],[data-wikilink]") : null;
  if (!el) return false;
  if (el.dataset.wikilink !== undefined) followWikiLink(view.state, el.dataset.wikilink, createNote);
  else followUrl(view.state, el.dataset.url!);
  return true;
}

type Found = { url: string } | { wikilink: string };

/** What a ⌘-click in source opens: a link's destination, an autolink, a bare URL or a wikilink. */
function linkAt(state: EditorState, pos: number): Found | null {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === "URL") return { url: state.doc.sliceString(node.from, node.to) };
    if (node.name === "WikiLink" || node.name === "WikiEmbed") {
      const target = node.getChild("WikiLinkTarget");
      return target ? { wikilink: state.doc.sliceString(target.from, target.to) } : null;
    }
    if (node.name === "Link" || node.name === "Autolink" || node.name === "Image") {
      const url = node.getChild("URL");
      return url ? { url: state.doc.sliceString(url.from, url.to) } : null;
    }
  }
  return null;
}

/** A rendered link opens on click; in source, ⌘-click opens it. */
export const linkClicks = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0) return false;
    if (followRendered(event.target, view)) {
      event.preventDefault();
      return true;
    }
    if (!event.metaKey && !event.ctrlKey) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    const found = pos === null ? null : linkAt(view.state, pos);
    if (!found) return false;
    event.preventDefault();
    if ("url" in found) followUrl(view.state, found.url);
    else followWikiLink(view.state, found.wikilink, createNote);
    return true;
  },
});
