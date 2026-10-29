import { preloadable } from "../lib/preloadable";
import { CodeEditor, MarkdownEditor } from "./editor/load";

/** The terminal's addons and wiring; the window opens without them. */
export const terminalView = preloadable(() => import("./TerminalView").then((m) => m.TerminalView));

/** The file editors are the heaviest chunks in the app; the window opens without them. */
export const fileView = preloadable(() => import("./FileView").then((m) => m.FileView));

/** A file tab's view and both its editors, so the first file opened does not suspend. */
export const preloadFileTab = () => Promise.all([fileView.preload(), CodeEditor.preload(), MarkdownEditor.preload()]);
