import { preloadable } from "../../lib/preloadable";

/**
 * Each editor is a chunk of its own, off the startup path: diffs and its
 * highlighter are ~600 kB, CodeMirror ~330 kB. They load once the window is
 * idle, or as ⌘P opens.
 */
export const CodeEditor = preloadable(() => import("./CodeEditor").then((m) => m.CodeEditor));
export const MarkdownEditor = preloadable(() => import("./MarkdownEditor").then((m) => m.MarkdownEditor));
