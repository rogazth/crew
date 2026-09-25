import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyField, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- this module is itself the lazy chunk
import { EditorState, Prec, type StateEffect } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- this module is itself the lazy chunk
import { EditorView, drawSelection, keymap } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { markdownPreview } from "../../lib/markdownPreview";

type Props = { path: string; loaded: string; saved: string; onChange: (contents: string) => void };

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
  { tag: [tags.link, tags.url], color: "var(--color-link)" },
  { tag: tags.monospace, fontFamily: MONO, fontSize: "0.9em" },
  { tag: tags.quote, color: MUTED },
  // The syntax itself, when the caret brings it back: present, not loud.
  { tag: [tags.processingInstruction, tags.labelName, tags.contentSeparator], color: "var(--color-placeholder)" },
  { tag: tags.comment, color: MUTED },
]);

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
  ".cm-md-inline-code": { padding: "1px 4px", borderRadius: "4px", background: "var(--color-card)" },
  ".cm-md-block": { fontFamily: MONO, fontSize: "12.5px", background: "var(--color-card)", padding: "0 12px" },
  ".cm-md-block-first": { borderTopLeftRadius: "8px", borderTopRightRadius: "8px", paddingTop: "4px" },
  ".cm-md-block-last": { borderBottomLeftRadius: "8px", borderBottomRightRadius: "8px", paddingBottom: "4px" },
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
  ".cm-md-link": { cursor: "pointer" },
});

type Kept = { json: unknown; base: string; scroll: StateEffect<unknown> };

/**
 * A tab switch unmounts the editor; this keeps each file's text, selection,
 * undo history and scroll for when it comes back — but only while disk still
 * holds what the kept state was based on.
 */
const kept = new Map<string, Kept>();

export function MarkdownEditor({ path, loaded, saved, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  const savedRef = useRef(saved);
  useEffect(() => {
    onChangeRef.current = onChange;
    savedRef.current = saved;
  });

  useEffect(() => {
    const extensions = [
      history(),
      drawSelection(),
      EditorView.lineWrapping,
      // The language and its list keys, not `markdown()`: that one bundles HTML,
      // CSS and JavaScript support for embedded tags and doubled the chunk.
      new LanguageSupport(markdownLanguage),
      Prec.high(keymap.of(markdownKeymap)),
      syntaxHighlighting(HIGHLIGHT),
      keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
      markdownPreview,
      THEME,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
      }),
    ];

    const previous = kept.get(path);
    kept.delete(path);
    const restore = previous?.base === loaded ? previous : undefined;
    const state = restore
      ? EditorState.fromJSON(restore.json, { extensions }, { history: historyField })
      : EditorState.create({ doc: loaded, extensions });
    const view = new EditorView({ state, parent: host.current! });
    if (restore) {
      view.dispatch({ effects: restore.scroll });
      onChangeRef.current(view.state.doc.toString());
    }

    return () => {
      kept.set(path, {
        json: view.state.toJSON({ history: historyField }),
        base: savedRef.current,
        scroll: view.scrollSnapshot(),
      });
      view.destroy();
    };
  }, [path, loaded]);

  return <div ref={host} className="h-full min-h-0" />;
}
