/**
 * What an editor keeps of a file between its mounts: for the code editor, the
 * library's own session (document, undo history, selection, scroll). The text
 * is `useTextFile`'s to keep; a session is taken up again only while it still
 * holds the very text the file starts from, so it never shows anything else.
 */
export function editorSessions<T>(limit: number) {
  /** Least recently taken first, as a Map iterates. */
  const held = new Map<string, { editor: T; text: string }>();
  return {
    /** The session `key` left off at `text`, or a new one from `create` in its place. */
    take(key: string, text: string, create: () => T): T {
      const previous = held.get(key);
      held.delete(key);
      const session = previous?.text === text ? previous : { editor: create(), text };
      held.set(key, session);
      for (const oldest of held.keys()) {
        if (held.size <= limit) break;
        held.delete(oldest);
      }
      return session.editor;
    },
    /** `editor` holds `text` now; an editor the file no longer keeps is ignored. */
    edited(key: string, editor: T, text: string): void {
      const session = held.get(key);
      if (session?.editor === editor) session.text = text;
    },
    /** The file's edits were discarded: its next mount starts a new session. */
    drop(key: string): void {
      held.delete(key);
    },
  };
}
