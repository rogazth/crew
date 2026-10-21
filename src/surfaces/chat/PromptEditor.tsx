// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- the composer is on screen from the start
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- the composer is on screen from the start
import { Annotation, Compartment, EditorState, StateEffect, StateField, type Range } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- the composer is on screen from the start
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  keymap,
  placeholder as placeholderText,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { fileTypeIconElement } from "../../chrome/fileIconSprite";
import type { TextEdit } from "../../lib/composerFormat";
import { splitMentions } from "../../lib/mentions";
import type { CommandEntry } from "../../lib/protocol";
import { splitTokens } from "../../lib/slashCommands";

/** What the composer drives the field by: the text and caret are plain string offsets, as in a textarea. */
export type PromptHandle = {
  focus: () => void;
  /** The text and the selection, read now. */
  read: () => { value: string; from: number; to: number };
  /** Puts the caret at `at` and takes the focus. */
  select: (at: number) => void;
  /** One edit, undone as one by ⌘Z. */
  apply: (edit: TextEdit) => void;
};

type Props = {
  ref?: Ref<PromptHandle>;
  value: string;
  placeholder: string;
  label: string;
  /** Files the draft may name: an `@path` among them becomes a chip. */
  known: ReadonlySet<string>;
  /** Commands and skills: a `/name` among them becomes a chip. */
  entries: readonly CommandEntry[];
  onChange: (value: string, caret: number) => void;
  /** Where the caret is; -1 once the field has lost the focus. */
  onCaret: (caret: number) => void;
  /** Runs before the editor's own keys; preventing the event's default keeps them from running. */
  onKeyDown: (event: KeyboardEvent) => void;
  onPasteFiles: (files: File[]) => void;
  /** The centred field is two lines tall. It changes in the commit that reveals a tab. */
  roomy?: boolean;
};

/** A change the composer made to the draft, not the user typing: it is not reported back. */
const fromOutside = Annotation.define<boolean>();

type ChipSource = { known: ReadonlySet<string>; entries: readonly CommandEntry[] };
const setSource = StateEffect.define<ChipSource>();
const source = StateField.define<ChipSource>({
  create: () => ({ known: new Set(), entries: [] }),
  update: (value, tr) => tr.effects.reduce((next, effect) => (effect.is(setSource) ? effect.value : next), value),
});

// Lucide's glyphs, drawn inside a skill's or a command's square; a file or folder wears the explorer's icon.
const ICONS: Record<string, string> = {
  skill:
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  command: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
};

/** An `@path`, a command or a skill as one thing: its icon (the explorer's, for a file), then its name. */
class ChipWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly kind: string,
  ) {
    super();
  }
  eq(other: ChipWidget) {
    return other.text === this.text && other.kind === this.kind;
  }
  toDOM() {
    const chip = document.createElement("span");
    chip.className = "cm-chip";
    chip.dataset.kind = this.kind;
    chip.title = this.text;
    const icon = document.createElement("span");
    icon.className = "cm-chip-icon";
    const path = this.text.slice(1);
    if (this.kind === "file" || this.kind === "folder") icon.append(fileTypeIconElement(path, this.kind === "folder"));
    else
      icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[this.kind] ?? ""}</svg>`;
    const label = document.createElement("span");
    label.className = "cm-chip-label";
    const name = path.replace(/\/$/, "");
    label.textContent = this.kind === "file" || this.kind === "folder" ? (name.split("/").pop() ?? name) : name;
    chip.append(icon, label);
    return chip;
  }
  ignoreEvent() {
    return false;
  }
}

/** Where every chip-worthy run of the text is, and what it is. */
function chipRuns(text: string, { known, entries }: ChipSource) {
  const runs: { from: number; to: number; text: string; kind: string }[] = [];
  let at = 0;
  for (const part of splitTokens(text, entries)) {
    if (part.kind === "token") {
      const entry = entries.find((one) => one.name === part.name);
      runs.push({ from: at, to: at + part.text.length, text: part.text, kind: entry?.kind === "command" ? "command" : "skill" });
    } else {
      let inner = at;
      for (const piece of splitMentions(part.text, known as Set<string>)) {
        if (piece.kind === "mention") {
          runs.push({ from: inner, to: inner + piece.text.length, text: piece.text, kind: piece.text.endsWith("/") ? "folder" : "file" });
        }
        inner += piece.text.length;
      }
    }
    at += part.text.length;
  }
  return runs;
}

/**
 * The chips. A run becomes one once the caret is off it (a picked file or command leaves the caret past
 * its space), so one still being typed stays text; from then on it is one atomic thing that the caret
 * steps over and one Backspace takes away. It goes back to text only if its run stops matching.
 */
const chips = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    const sourced = tr.effects.some((effect) => effect.is(setSource));
    if (!tr.docChanged && !tr.selection && !sourced) return value;
    const doc = tr.state.doc.toString();
    const head = tr.state.selection.main.head;
    const kept = new Map<number, Range<Decoration>>();
    const mapped = value.map(tr.changes);
    const runs = chipRuns(doc, tr.state.field(source));
    const byFrom = new Map(runs.map((run) => [run.from, run]));
    mapped.between(0, doc.length, (from, to, deco) => {
      const run = byFrom.get(from);
      if (run && run.to === to && (deco.spec.widget as ChipWidget).text === run.text) kept.set(from, deco.range(from, to));
    });
    for (const run of runs) {
      if (kept.has(run.from) || (head >= run.from && head <= run.to)) continue;
      kept.set(run.from, Decoration.replace({ widget: new ChipWidget(run.text, run.kind) }).range(run.from, run.to));
    }
    return Decoration.set([...kept.values()], true);
  },
  provide: (field) => [EditorView.decorations.from(field), EditorView.atomicRanges.of((view) => view.state.field(field))],
});

const ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])( +(?:\[[ xX]\] )?)/;
const CODE = /`[^`\n]+`/g;

/** A list marker drawn as a bullet or its number, in a column of its own that the item's lines hang from. */
class MarkerWidget extends WidgetType {
  constructor(
    readonly marker: string,
    readonly box: string,
  ) {
    super();
  }
  eq(other: MarkerWidget) {
    return other.marker === this.marker && other.box === this.box;
  }
  toDOM() {
    const mark = document.createElement("span");
    mark.className = "cm-li-mark";
    // A task shows its box alone, as a checklist does; a bullet its dot; a number itself.
    if (!this.box && /^[-*+]$/.test(this.marker)) mark.dataset.bullet = "";
    else if (!this.box) mark.textContent = this.marker;
    else {
      const box = document.createElement("span");
      box.className = "cm-li-box";
      if (/x/i.test(this.box)) box.dataset.done = "";
      mark.append(box);
    }
    return mark;
  }
}

function markdownDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const item = ITEM.exec(line.text);
      if (item) {
        const [whole, indent, marker, gap] = item as unknown as [string, string, string, string];
        const depth = indent.replace(/\t/g, "  ").length / 2;
        const box = /\[[ xX]\]/.exec(gap)?.[0] ?? "";
        ranges.push(
          Decoration.line({
            class: "cm-li",
            attributes: { style: `--li-depth: ${depth}; --li-mark: 1.5em` },
          }).range(line.from),
          Decoration.replace({ widget: new MarkerWidget(marker, box) }).range(line.from, line.from + whole.length),
        );
      }
      for (const match of line.text.matchAll(CODE)) {
        const start = line.from + match.index;
        ranges.push(
          Decoration.mark({ class: "cm-icode" }).range(start, start + match[0].length),
          Decoration.mark({ class: "cm-icode-tick" }).range(start, start + 1),
          Decoration.mark({ class: "cm-icode-tick" }).range(start + match[0].length - 1, start + match[0].length),
        );
      }
      pos = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

const markdown = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = markdownDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = markdownDecorations(update.view);
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    provide: (plugin) => EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
);

/**
 * The composer's field: a CodeMirror editor over the plain-markdown draft. Mentions, commands and skills
 * show as chips and list items as real list lines, while the text underneath stays exactly what is sent.
 */
export function PromptEditor({ ref, value, placeholder, label, known, entries, onChange, onCaret, onKeyDown, onPasteFiles, roomy = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The height fit, shared with the commit below so a mode change snaps before paint.
  const fitBox = useRef<() => void>(() => {});
  const [prompt] = useState(() => new Compartment());
  // The editor is made once; it calls whatever the latest render handed in.
  const latest = useRef({ onChange, onCaret, onKeyDown, onPasteFiles });
  useLayoutEffect(() => {
    latest.current = { onChange, onCaret, onKeyDown, onPasteFiles };
  });

  useLayoutEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          EditorView.lineWrapping,
          source,
          chips,
          markdown,
          prompt.of([placeholderText(placeholder), EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" })]),
          EditorView.domEventHandlers({
            keydown: (event) => {
              latest.current.onKeyDown(event);
              return event.defaultPrevented;
            },
            paste: (event) => {
              const files = [...(event.clipboardData?.files ?? [])];
              if (files.length === 0) return false;
              event.preventDefault();
              latest.current.onPasteFiles(files);
              return true;
            },
          }),
          keymap.of([{ key: "Shift-Enter", run: insertNewline }, ...historyKeymap, ...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            const outside = update.transactions.some((tr) => tr.annotation(fromOutside));
            const caret = update.view.hasFocus ? update.state.selection.main.head : -1;
            if (update.docChanged && !outside) latest.current.onChange(update.state.doc.toString(), caret);
            else if (update.docChanged || update.selectionSet || update.focusChanged) latest.current.onCaret(caret);
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The editor lives as long as the composer; the props below reach it through effects.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    view.current?.dispatch({
      effects: prompt.reconfigure([
        placeholderText(placeholder),
        EditorView.contentAttributes.of({ "aria-label": label, spellcheck: "false" }),
      ]),
    });
  }, [prompt, placeholder, label]);

  useEffect(() => {
    view.current?.dispatch({ effects: setSource.of({ known, entries }) });
  }, [known, entries]);

  // A draft the composer set (a pick, a send, a starter) replaces only what differs, so the caret and undo keep their place.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current === value) return;
    let start = 0;
    while (start < current.length && start < value.length && current[start] === value[start]) start++;
    let end = 0;
    while (end < current.length - start && end < value.length - start && current[current.length - 1 - end] === value[value.length - 1 - end]) end++;
    editor.dispatch({
      changes: { from: start, to: current.length - end, insert: value.slice(start, value.length - end) },
      annotations: fromOutside.of(true),
    });
  }, [value]);

  // The box eases to the editor's height, so a new line slides in instead of jumping.
  // The first height snaps, and so does any later resize that is not a line the user
  // typed. Opening a tab measures the centred field (two lines) before the transcript
  // lands and the field drops to one; easing that catch-up shifted the composer.
  useLayoutEffect(() => {
    const editor = view.current;
    const outer = box.current;
    if (!editor || !outer) return;
    let primed = false;
    let seen = editor.state.doc.toString();
    const fit = () => {
      // A tab behind another is display:none, so it measures 0. Keeping the last real
      // height means revealing it does not open from nothing.
      const measured = editor.dom.offsetHeight;
      if (measured === 0) return;
      const next = `${measured}px`;
      const text = editor.state.doc.toString();
      const typed = primed && text !== seen;
      seen = text;
      if (outer.style.height === next) {
        primed = true;
        return;
      }
      if (!typed) {
        outer.style.setProperty("transition", "none");
        outer.style.height = next;
        // Commit the snap before the height transition is allowed back on.
        void outer.offsetHeight;
        outer.style.removeProperty("transition");
      } else {
        outer.style.height = next;
      }
      primed = true;
      outer.dataset.eased = "";
    };
    fitBox.current = fit;
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(editor.dom);
    return () => {
      observer.disconnect();
      delete outer.dataset.eased;
      fitBox.current = () => {};
    };
  }, []);

  // The centred field and the docked one trade places in the commit that reveals the
  // tab. Fitting here, before paint, is what keeps that frame from showing the stale height.
  useLayoutEffect(() => {
    fitBox.current();
  }, [roomy]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => view.current?.focus(),
      read: () => {
        const state = view.current?.state;
        if (!state) return { value, from: value.length, to: value.length };
        return { value: state.doc.toString(), from: state.selection.main.from, to: state.selection.main.to };
      },
      select: (at) => {
        const editor = view.current;
        if (!editor) return;
        editor.focus();
        editor.dispatch({ selection: { anchor: Math.min(at, editor.state.doc.length) }, scrollIntoView: true });
      },
      apply: (edit) => {
        const editor = view.current;
        if (!editor) return;
        editor.dispatch({
          changes: { from: edit.start, to: edit.end, insert: edit.insert },
          selection: { anchor: edit.selStart, head: edit.selEnd },
          scrollIntoView: true,
          userEvent: "input",
        });
      },
    }),
    [value],
  );

  return (
    <div ref={box} className="ds-prompt-box" {...(roomy ? { "data-roomy": "" } : {})}>
      <div ref={host} className="ds-prompt" />
    </div>
  );
}
