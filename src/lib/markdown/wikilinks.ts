import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { Facet, type EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ProjectFile } from "../types";

/**
 * What the editor needs from the app: the note it holds, the workspace index
 * to resolve `[[links]]` against, and a way to open what they point at.
 */
export type NoteHost = {
  path: string;
  files: ProjectFile[];
  /** Opens an absolute path; `heading` scrolls a note to that heading once open. */
  open: (path: string, heading?: string) => void;
};

export const noteHost = Facet.define<NoteHost, NoteHost>({
  combine: (values) => values[0] ?? { path: "", files: [], open: () => undefined },
});

export type WikiTarget = { file: string; heading: string | null };

/** `Plan#Goals` → the file part and the heading; a `^block` id is dropped. */
export function splitTarget(target: string): WikiTarget {
  const hash = target.indexOf("#");
  const file = (hash < 0 ? target : target.slice(0, hash)).trim();
  const heading = hash < 0 ? null : target.slice(hash + 1).replace(/^\^.*$/, "").trim() || null;
  return { file, heading };
}

const MARKDOWN = /\.(?:md|markdown)$/i;

export function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

/** `relative` against the folder `from` is in, `.` and `..` folded away. */
export function resolvePath(from: string, relative: string): string {
  if (relative.startsWith("/")) return relative;
  const parts = dirname(from).split("/");
  for (const part of relative.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return parts.join("/");
}

/** Files by lowercased name, with and without `.md`: what Obsidian matches on. */
const byName = new WeakMap<ProjectFile[], Map<string, ProjectFile[]>>();

function nameIndex(files: ProjectFile[]): Map<string, ProjectFile[]> {
  let index = byName.get(files);
  if (!index) {
    index = new Map();
    for (const file of files) {
      const keys = [file.name.toLowerCase()];
      if (MARKDOWN.test(file.name)) keys.push(file.name.replace(MARKDOWN, "").toLowerCase());
      for (const key of keys) {
        const list = index.get(key);
        if (list) list.push(file);
        else index.set(key, [file]);
      }
    }
    byName.set(files, index);
  }
  return index;
}

/**
 * The file a link names. A path matches the end of a file's workspace path; a
 * bare name matches any file with it, preferring one next to the note, then
 * the shallowest — Obsidian's "shortest path" rule.
 */
export function resolveWikiLink(file: string, from: string, files: ProjectFile[]): ProjectFile | null {
  const wanted = file.replace(/^\.?\//, "").toLowerCase();
  if (!wanted) return null;
  const base = wanted.split("/").pop()!;
  const candidates = nameIndex(files).get(base) ?? [];
  const withPath = wanted.includes("/")
    ? candidates.filter((f) => {
        const relative = f.relative.toLowerCase();
        return [relative, relative.replace(MARKDOWN, "")].some((r) => r === wanted || r.endsWith(`/${wanted}`));
      })
    : candidates;
  if (withPath.length === 0) return null;
  const here = dirname(from);
  return [...withPath].sort((a, b) => {
    const near = Number(dirname(b.path) === here) - Number(dirname(a.path) === here);
    if (near) return near;
    const md = Number(MARKDOWN.test(b.name)) - Number(MARKDOWN.test(a.name));
    if (md) return md;
    return a.relative.split("/").length - b.relative.split("/").length || a.relative.localeCompare(b.relative);
  })[0]!;
}

/** Where a click on an unresolved link creates its note: next to the one it is in. */
export function newNotePath(file: string, from: string): string {
  const name = MARKDOWN.test(file) ? file : `${file}.md`;
  return resolvePath(from, name);
}

/** Opens a link's target, or creates the note first when nothing matches. */
export function followWikiLink(state: EditorState, target: string, create: (path: string) => Promise<void>) {
  const host = state.facet(noteHost);
  const { file, heading } = splitTarget(target);
  if (!file) {
    host.open(host.path, heading ?? undefined);
    return;
  }
  const found = resolveWikiLink(file, host.path, host.files);
  if (found) {
    host.open(found.path, heading ?? undefined);
    return;
  }
  const path = newNotePath(file, host.path);
  void create(path).then(() => host.open(path));
}

export type Heading = { level: number; text: string; from: number };

/**
 * Headings by their lines. Cheaper than a full parse for a note that is not
 * open, and fenced code is skipped so a `# comment` in a shell block is not one.
 */
export function headingsIn(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  let at = 0;
  for (const line of text.split("\n")) {
    const opener = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (opener && opener[1]!.startsWith(fence)) fence = null;
    } else if (opener) {
      fence = opener[1]!;
    } else {
      const m = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
      if (m && m[2]) out.push({ level: m[1]!.length, text: m[2], from: at });
    }
    at += line.length + 1;
  }
  return out;
}

/** The link text for a file: its bare name when that is unambiguous, else its path. */
function linkText(file: ProjectFile, files: ProjectFile[]): string {
  const bare = file.name.replace(MARKDOWN, "");
  const clashes = nameIndex(files).get(bare.toLowerCase())?.length ?? 0;
  const text = clashes > 1 ? file.relative : file.name;
  return MARKDOWN.test(text) ? text.replace(MARKDOWN, "") : text;
}

/** Inserts the text and closes the link, stepping over a `]]` already there. */
function closeLink(text: string) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const closed = view.state.sliceDoc(to, to + 2) === "]]";
    view.dispatch({
      changes: { from, to, insert: closed ? text : `${text}]]` },
      selection: { anchor: from + text.length + 2 },
      userEvent: "input.complete",
    });
  };
}

/**
 * `[[` completes notes and files from the workspace index; `[[note#` the
 * headings of that note, and `[[#` those of this one.
 */
export function makeWikiLinkCompletions(read: (path: string) => Promise<string>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const match = context.matchBefore(/\[\[[^[\]|\n]*$/);
    if (!match) return null;
    const host = context.state.facet(noteHost);
    const query = match.text.slice(2);
    const hash = query.indexOf("#");

    if (hash >= 0) {
      const file = query.slice(0, hash);
      const target = file ? resolveWikiLink(file, host.path, host.files) : null;
      if (file && !target) return null;
      let text: string;
      try {
        text = target ? await read(target.path) : context.state.doc.toString();
      } catch {
        return null;
      }
      return {
        from: match.from + 2 + hash + 1,
        options: headingsIn(text).map((h) => ({
          label: h.text,
          detail: "#".repeat(h.level),
          apply: closeLink(h.text),
        })),
        validFor: /^[^[\]|#\n]*$/,
      };
    }

    const options = host.files.flatMap((f): Completion[] => {
      if (f.path === host.path) return [];
      const md = MARKDOWN.test(f.name);
      const dir = dirname(f.relative);
      return [
        {
          label: md ? f.name.replace(MARKDOWN, "") : f.name,
          ...(dir ? { detail: dir } : {}),
          // Notes first: they are what a link usually names.
          boost: md ? 1 : 0,
          apply: closeLink(linkText(f, host.files)),
        },
      ];
    });
    return { from: match.from + 2, options, validFor: /^[^[\]|#\n]*$/ };
  };
}
