import { useEffect, useRef, useState } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdownKeymap, pasteURLAsLink } from "@codemirror/lang-markdown";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- this module is itself the lazy chunk
import { Compartment, EditorState, Prec, type StateEffect } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- this module is itself the lazy chunk
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { FindBar } from "../../chrome/FindBar";
import { useCommand } from "../../hooks/useCommand";
import * as api from "../../lib/api";
import { blockPreview, refreshPreview } from "../../lib/markdown/blocks";
import { findHighlighting, findPosition, setFindQuery, stepFind } from "../../lib/markdown/find";
import { formatKeymap, wrapOnType } from "../../lib/markdown/format";
import { linkClicks } from "../../lib/markdown/links";
import { onSchemeChange } from "../../lib/markdown/mermaid";
import { findHeading, outlineOf, type OutlineItem } from "../../lib/markdown/outline";
import { imageDrops } from "../../lib/markdown/paste";
import { markdownPreview } from "../../lib/markdown/preview";
import { markTags, obsidianMarkdown } from "../../lib/markdown/syntax";
import { makeWikiLinkCompletions, noteHost, type NoteHost } from "../../lib/markdown/wikilinks";
import type { ProjectFile } from "../../lib/types";
import { onDiscard } from "../../lib/unsavedEdits";
import { Outline } from "./Outline";

type Props = {
  path: string;
  /** The text to start from: the disk's, or edits kept from before the tab went away. */
  loaded: string;
  onChange: (contents: string) => void;
  files: ProjectFile[];
  /** Opens a file tab for an absolute path. */
  onOpenPath: (path: string) => void;
  outline: boolean;
};

const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";
const MUTED = "var(--text-color-kumo-subtle)";

const HIGHLIGHT = HighlightStyle.define([
  { tag: tags.heading1, fontSize: "1.6em", fontWeight: "600", letterSpacing: "-0.02em" },
  { tag: tags.heading2, fontSize: "1.35em", fontWeight: "600", letterSpacing: "-0.015em" },
  { tag: tags.heading3, fontSize: "1.15em", fontWeight: "600" },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: "600" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through", color: MUTED },
  { tag: [tags.link, tags.url, markTags.wikilink], color: "var(--color-link)" },
  { tag: tags.monospace, fontFamily: MONO, fontSize: "0.9em" },
  { tag: tags.quote, color: MUTED },
  // The syntax itself, when the caret brings it back: present, not loud.
  { tag: [tags.processingInstruction, tags.labelName, tags.contentSeparator], color: "var(--color-placeholder)" },
  { tag: [tags.comment, tags.meta], color: MUTED },
]);

const CARD = "var(--color-card)";
const CALLOUT_TINT = "color-mix(in srgb, var(--callout) 9%, transparent)";

const THEME = EditorView.theme({
  "&": { height: "100%", fontSize: "14px", color: "var(--color-text)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "inherit", lineHeight: "1.65" },
  // Obsidian's readable line length; the tail room lets the last line scroll to mid-pane.
  ".cm-content": { maxWidth: "720px", margin: "0 auto", padding: "32px 24px 40vh", caretColor: "var(--color-text)" },
  ".cm-line": { padding: "0" },
  ".cm-cursor": { borderLeftColor: "var(--color-text)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
    background: "color-mix(in srgb, var(--color-link) 22%, transparent)",
  },
  ".cm-md-heading": { paddingTop: "0.5em" },
  ".cm-md-quote": {
    borderLeft: "2px solid color-mix(in srgb, var(--text-color-kumo-default) 20%, transparent)",
    paddingLeft: "12px",
  },
  ".cm-md-inline-code": { padding: "1px 4px", borderRadius: "4px", background: CARD },
  ".cm-md-highlight": {
    background: "light-dark(oklch(92% 0.1 95), oklch(45% 0.09 95 / 0.55))",
    borderRadius: "2px",
  },
  ".cm-md-block": { fontFamily: MONO, fontSize: "12.5px", background: CARD, padding: "0 12px" },
  ".cm-md-block-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "4px" },
  ".cm-md-block-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "4px" },
  ".cm-md-token": { color: "light-dark(var(--shiki-light), var(--shiki-dark))" },
  ".cm-md-code-lang": {
    float: "right",
    fontSize: "11px",
    color: "var(--color-placeholder)",
    fontFamily: "inherit",
  },
  ".cm-md-frontmatter": { fontFamily: MONO, fontSize: "12.5px", color: MUTED },
  ".cm-md-table": { fontFamily: MONO, fontSize: "12.5px" },
  ".cm-md-bullet": { color: MUTED },
  ".cm-md-task": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "14px",
    height: "14px",
    marginRight: "2px",
    verticalAlign: "-2px",
    border: `1.5px solid ${MUTED}`,
    borderRadius: "50%",
    fontSize: "9px",
    lineHeight: "1",
    cursor: "pointer",
  },
  ".cm-md-task[data-checked]": { background: MUTED, color: "var(--color-canvas)" },
  ".cm-md-done": { color: MUTED, textDecoration: "line-through" },
  ".cm-md-rule": {
    display: "inline-block",
    width: "100%",
    verticalAlign: "middle",
    borderTop: "1px solid var(--color-border)",
  },
  ".cm-md-link, .cm-md-wikilink": { cursor: "pointer" },
  ".cm-md-wikilink": { color: "var(--color-link)" },
  ".cm-md-wikilink-missing": { opacity: "0.6", textDecoration: "underline dotted" },
  ".cm-md-image": { display: "block", maxWidth: "100%", maxHeight: "480px", borderRadius: "6px", margin: "4px 0" },
  ".cm-md-image[data-broken]": {
    display: "inline-block",
    width: "auto",
    minWidth: "120px",
    height: "28px",
    background: CARD,
  },

  // Tables
  ".cm-md-table-wrap": { overflowX: "auto", margin: "4px 0", cursor: "text" },
  ".cm-md-table-wrap table": { borderCollapse: "collapse", fontSize: "13.5px", lineHeight: "1.5" },
  ".cm-md-table-wrap th, .cm-md-table-wrap td": {
    border: "1px solid var(--color-border)",
    padding: "5px 10px",
    verticalAlign: "top",
    textAlign: "left",
  },
  ".cm-md-table-wrap th": { fontWeight: "600", background: CARD },
  ".cm-md-table-wrap code, .cm-md-props code": {
    fontFamily: MONO,
    fontSize: "0.9em",
    padding: "1px 4px",
    borderRadius: "4px",
    background: CARD,
  },
  ".cm-md-table-wrap mark, .cm-md-props mark": {
    background: "light-dark(oklch(92% 0.1 95), oklch(45% 0.09 95 / 0.55))",
    color: "inherit",
  },

  // Mermaid
  ".cm-md-mermaid": {
    display: "flex",
    justifyContent: "center",
    padding: "12px",
    margin: "4px 0",
    borderRadius: "8px",
    background: CARD,
    cursor: "text",
    overflowX: "auto",
  },
  ".cm-md-mermaid svg": { maxWidth: "100%", height: "auto" },
  ".cm-md-mermaid[data-loading]": { minHeight: "120px" },
  ".cm-md-mermaid[data-error]": { color: "var(--color-danger, #d33)", fontFamily: MONO, fontSize: "12px", justifyContent: "flex-start" },

  // Callouts
  ".cm-md-callout": {
    background: CALLOUT_TINT,
    borderLeft: "2px solid var(--callout)",
    padding: "0 12px",
  },
  // Past the quote style, which would mute the title like the body.
  ".cm-md-callout-title > span": { color: "var(--callout)" },
  ".cm-md-callout-title": {
    color: "var(--callout)",
    fontWeight: "600",
    paddingTop: "6px",
    borderTopRightRadius: "6px",
  },
  ".cm-md-callout-last": { paddingBottom: "6px", borderBottomRightRadius: "6px" },
  ".cm-md-callout-head": { display: "inline-flex", alignItems: "center", gap: "6px", marginRight: "6px", verticalAlign: "-2px" },
  ".cm-md-callout-icon": { width: "16px", height: "16px", flexShrink: "0" },
  ".cm-md-callout-head .cm-md-fold": { order: "3" },
  ".cm-md-fold": {
    width: "12px",
    height: "12px",
    cursor: "pointer",
    color: MUTED,
    transition: "transform 120ms ease-out",
  },
  "[aria-expanded=true] > .cm-md-fold, .cm-md-fold[aria-expanded=true]": { transform: "rotate(90deg)" },

  // Properties
  ".cm-md-props": {
    margin: "0 0 12px",
    paddingBottom: "8px",
    borderBottom: "1px solid var(--color-border)",
    fontSize: "13px",
  },
  ".cm-md-props-head": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "2px 0 6px",
    color: MUTED,
    fontWeight: "600",
    cursor: "pointer",
  },
  ".cm-md-props-count": { fontWeight: "400", color: "var(--color-placeholder)" },
  ".cm-md-prop": { display: "flex", gap: "12px", padding: "3px 0", cursor: "text" },
  ".cm-md-prop-key": { width: "120px", flexShrink: "0", color: MUTED },
  ".cm-md-prop-value": { display: "flex", flexWrap: "wrap", gap: "4px", minWidth: "0" },
  ".cm-md-prop-value[data-empty]": { color: "var(--color-placeholder)" },
  ".cm-md-chip": { padding: "0 8px", borderRadius: "999px", background: CARD },

  // Find
  ".cm-md-find": { background: "light-dark(oklch(91% 0.1 95), oklch(50% 0.1 95 / 0.5))", borderRadius: "2px" },
  ".cm-md-find-current": { background: "light-dark(oklch(82% 0.15 70), oklch(62% 0.15 65 / 0.7))" },

  // Link completion
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "none",
    borderRadius: "8px",
    background: "var(--color-kumo-control, var(--color-canvas))",
    boxShadow: "0 8px 24px rgb(0 0 0 / 0.16), 0 0 0 1px var(--color-border)",
    overflow: "hidden",
  },
  // Same selectors as the base theme, which would otherwise win on specificity.
  ".cm-tooltip.cm-tooltip-autocomplete > ul": { fontFamily: "inherit", fontSize: "13px", maxHeight: "260px", padding: "4px" },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": { padding: "3px 8px", borderRadius: "5px", lineHeight: "1.5" },
  "&.cm-editor .cm-tooltip.cm-tooltip-autocomplete ul li[aria-selected]": {
    background: "var(--color-hover)",
    color: "var(--color-text)",
  },
  ".cm-completionDetail": { marginLeft: "8px", fontStyle: "normal", color: "var(--color-placeholder)" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
});

/** Markdown's bracket pairs; quotes stay single, since prose is full of apostrophes. */
const BRACKETS = EditorState.languageData.of(() => [{ closeBrackets: { brackets: ["(", "[", "{"] } }]);

type Kept = { json: unknown; doc: string; scroll: StateEffect<unknown>; top: number; head: number };

/**
 * A tab switch unmounts the editor; this keeps each file's text, selection,
 * undo history and scroll for when it comes back — whole while it comes back to
 * the same text, and only its place in the note once the disk replaced that.
 */
const kept = new Map<string, Kept>();
// A close that discards a note's edits takes its undo history and place with them.
onDiscard((path) => kept.delete(path));

/** A heading to scroll to once a note opens, set by a link that named one. */
const pendingHeading = new Map<string, string>();

function scrollToHeading(view: EditorView, heading: string, select: boolean) {
  const found = findHeading(outlineOf(view.state), heading);
  if (!found) return;
  const at = select ? view.state.doc.lineAt(found.from).to : undefined;
  view.dispatch({
    selection: at === undefined ? undefined : { anchor: at },
    effects: EditorView.scrollIntoView(found.from, { y: "start", yMargin: 24 }),
  });
}

/** The line at the top of the pane. */
const topLine = (view: EditorView) =>
  view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop + 8);

/** The last heading at or above the top of the pane: the section being read. */
function activeHeading(view: EditorView, items: OutlineItem[]): number | null {
  const top = topLine(view);
  let active: number | null = null;
  for (const item of items) {
    if (item.from > top.to) break;
    active = item.from;
  }
  return active ?? items[0]?.from ?? null;
}

export function MarkdownEditor({ path, loaded, onChange, files, onOpenPath, outline }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [hostCompartment] = useState(() => new Compartment());
  const onChangeRef = useRef(onChange);
  const hostValue = useRef<NoteHost>({ path, files, open: () => undefined });
  const [items, setItems] = useState<OutlineItem[]>([]);
  const itemsRef = useRef(items);
  const [active, setActive] = useState<number | null>(null);
  const [find, setFind] = useState<{ query: string; token: number } | null>(null);
  const [findResults, setFindResults] = useState({ index: 0, count: 0 });

  useEffect(() => {
    onChangeRef.current = onChange;
    itemsRef.current = items;
  });

  // What links resolve against and how they open; swapped in place when the index changes.
  useEffect(() => {
    hostValue.current = {
      path,
      files,
      open: (target, heading) => {
        const view = viewRef.current;
        if (target === path) {
          if (view && heading) scrollToHeading(view, heading, false);
          return;
        }
        if (heading) pendingHeading.set(target, heading);
        onOpenPath(target);
      },
    };
    viewRef.current?.dispatch({ effects: hostCompartment.reconfigure(noteHost.of(hostValue.current)) });
  }, [path, files, onOpenPath, hostCompartment]);

  useEffect(() => {
    let outlineTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshOutline = (view: EditorView) => {
      clearTimeout(outlineTimer);
      outlineTimer = setTimeout(() => setItems(outlineOf(view.state)), 150);
    };

    const extensions = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      // The language and its list keys, not `markdown()`: that one bundles HTML,
      // CSS and JavaScript support for embedded tags and doubled the chunk.
      new LanguageSupport(obsidianMarkdown),
      hostCompartment.of(noteHost.of(hostValue.current)),
      // Table keys first, so Tab and Enter in a table move between cells.
      Prec.high(keymap.of(formatKeymap)),
      Prec.high(keymap.of(markdownKeymap)),
      syntaxHighlighting(HIGHLIGHT),
      BRACKETS,
      closeBrackets(),
      wrapOnType,
      autocompletion({ override: [makeWikiLinkCompletions(api.readTextFile)], icons: false }),
      keymap.of([...closeBracketsKeymap, indentWithTab, ...defaultKeymap, ...historyKeymap]),
      markdownPreview,
      blockPreview,
      findHighlighting,
      linkClicks,
      pasteURLAsLink,
      imageDrops,
      THEME,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
          refreshOutline(update.view);
        }
      }),
    ];

    const previous = kept.get(path);
    kept.delete(path);
    const restore = previous?.doc === loaded ? previous : undefined;
    const state = restore
      ? EditorState.fromJSON(restore.json, { extensions }, { history: historyField })
      : EditorState.create({ doc: loaded, extensions });
    const view = new EditorView({ state, parent: host.current! });
    viewRef.current = view;
    // Restored or not, the text is `loaded`, which the file already holds as the editor's.
    if (restore) {
      view.dispatch({ effects: restore.scroll });
    } else if (previous) {
      // The disk's text replaced the one kept: the caret and the pane stay about where they were.
      const clamp = (at: number) => Math.min(at, view.state.doc.length);
      view.dispatch({
        selection: { anchor: clamp(previous.head) },
        effects: EditorView.scrollIntoView(clamp(previous.top), { y: "start" }),
      });
    }
    // Forgotten a frame later, not now: a remount in the same tick (StrictMode)
    // restores the scroll it had, which would bury the heading.
    const heading = pendingHeading.get(path);
    const consumed = heading ? requestAnimationFrame(() => pendingHeading.delete(path)) : 0;
    if (heading) scrollToHeading(view, heading, false);
    setItems(outlineOf(view.state));

    const offScheme = onSchemeChange(() => view.dispatch({ effects: refreshPreview.of(null) }));
    // Discarded as its tab closes: the unmount that follows keeps nothing.
    let discarded = false;
    const offDiscard = onDiscard((gone) => {
      if (gone === path) discarded = true;
    });

    // Read while the pane is on screen: by the time it unmounts, it has no layout to ask.
    let top = previous?.top ?? 0;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        top = topLine(view).from;
        setActive(activeHeading(view, itemsRef.current));
      });
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    // Opened, the section at the top is marked before any scroll; the outline
    // is read off the text, since the one in state lands a render later.
    frame = requestAnimationFrame(() => setActive(activeHeading(view, outlineOf(view.state))));

    return () => {
      clearTimeout(outlineTimer);
      cancelAnimationFrame(frame);
      cancelAnimationFrame(consumed);
      view.scrollDOM.removeEventListener("scroll", onScroll);
      offScheme();
      offDiscard();
      if (!discarded) {
        kept.set(path, {
          json: view.state.toJSON({ history: historyField }),
          doc: view.state.doc.toString(),
          scroll: view.scrollSnapshot(),
          top,
          head: view.state.selection.main.head,
        });
      }
      viewRef.current = null;
      view.destroy();
    };
  }, [path, loaded, hostCompartment]);

  useCommand("find", () => {
    const view = viewRef.current;
    const selected = view ? view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) : "";
    const query = selected && !selected.includes("\n") ? selected : (find?.query ?? "");
    setFind({ query, token: (find?.token ?? 0) + 1 });
    if (view) {
      view.dispatch({ effects: setFindQuery.of(query) });
      setFindResults(findPosition(view.state, query));
    }
  });

  function onFindQuery(query: string) {
    setFind((current) => ({ query, token: current?.token ?? 0 }));
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setFindQuery.of(query) });
    // Typing jumps to the first match from where the search started, as a browser does.
    const { from } = view.state.selection.main;
    view.dispatch({ selection: { anchor: from } });
    setFindResults(query ? stepFind(view, query, 1) : { index: 0, count: 0 });
  }

  function onFindStep(delta: number) {
    const view = viewRef.current;
    if (view && find?.query) setFindResults(stepFind(view, find.query, delta));
  }

  function onFindClose() {
    setFind(null);
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: setFindQuery.of("") });
    view.focus();
  }

  function onOutlineSelect(item: OutlineItem) {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      selection: { anchor: view.state.doc.lineAt(item.from).to },
      effects: EditorView.scrollIntoView(item.from, { y: "start", yMargin: 24 }),
    });
    view.focus();
    setActive(item.from);
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="relative min-w-0 flex-1">
        <div ref={host} className="h-full min-h-0" />
        {find && (
          <FindBar
            label="Find in note"
            query={find.query}
            results={findResults}
            focusToken={find.token}
            onQuery={onFindQuery}
            onStep={onFindStep}
            onClose={onFindClose}
          />
        )}
      </div>
      {outline && <Outline items={items} active={active} onSelect={onOutlineSelect} />}
    </div>
  );
}
