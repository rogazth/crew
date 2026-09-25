import { useCallback, useEffect, useRef, useState } from "react";
import { useCommand } from "./useCommand";
import * as api from "../lib/api";
import { isDirty, reconcile, resolve, type Disk, type Step, type TextFile } from "../lib/textFile";

/** Unsaved edits of a file whose tab went away, with the base they were made on. */
const keptEdits = new Map<string, TextFile>();

const IDLE: Promise<void> = Promise.resolve();

/** The file's text, or null once it is gone; any other failure to read is thrown. */
async function readDisk(path: string): Promise<Disk> {
  try {
    return await api.readTextFile(path);
  } catch (e) {
    if (await api.pathExists(path).catch(() => true)) throw e;
    return null;
  }
}

/**
 * A text file open for editing: what the editor starts from, what disk had when
 * it was last loaded or saved, and what the editor holds now. The disk is read
 * again on a save and whenever the window comes back (`lib/textFile` decides
 * what that finds). Unsaved edits outlive the tab and meet the disk again when
 * it comes back. Owns `save-file` while mounted.
 */
export function useTextFile(path: string) {
  /** The text an editor starts from; `revision` counts the times the disk replaced it. */
  const [loaded, setLoaded] = useState<{ text: string; revision: number } | null>(null);
  const [file, setFile] = useState<TextFile>({ base: null, mine: "", conflict: false });
  const [error, setError] = useState<string | null>(null);
  // The file as of the last keystroke, for checks that finish after a read.
  const current = useRef<TextFile | null>(null);
  const queue = useRef(IDLE);

  const commit = useCallback((next: TextFile) => {
    current.current = next;
    setFile(next);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const previous = keptEdits.get(path);
    void (previous ? readDisk(path) : api.readTextFile(path))
      .then((disk) => {
        if (cancelled) return;
        keptEdits.delete(path);
        // Kept edits meet the disk as it is now; a file that is gone has nothing else to show.
        const next = previous ? reconcile(previous, disk, false).file : { base: disk, mine: disk ?? "", conflict: false };
        commit(next);
        setLoaded({ text: next.mine, revision: 0 });
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
      const last = current.current;
      current.current = null;
      if (last && isDirty(last)) keptEdits.set(path, last);
    };
  }, [path, commit]);

  /** Runs one read of the disk at a time, in order, so a save never races a check. */
  const enqueue = useCallback(
    (task: () => Promise<void>, onError: (e: unknown) => void) => {
      queue.current = queue.current.then(() => (current.current ? task().catch(onError) : undefined));
    },
    [],
  );

  const apply = useCallback(
    async (step: Step) => {
      if (step.write) {
        await api.writeTextFile(path, step.file.mine);
        // Typing may have gone on during the write: only the base is what was written.
        const now = current.current;
        if (now) commit({ ...now, base: step.file.base, conflict: false });
        return;
      }
      commit(step.file);
      if (step.reload) setLoaded((prev) => ({ text: step.file.mine, revision: (prev?.revision ?? 0) + 1 }));
    },
    [commit, path],
  );

  /** Reads the disk and settles against it, once the read is in and against the latest edit. */
  const check = useCallback(
    (save: boolean) =>
      enqueue(
        async () => {
          const disk = await readDisk(path);
          const now = current.current;
          if (now) await apply(reconcile(now, disk, save));
        },
        // A save that fails says so; a check on focus that fails tries again on the next one.
        save ? (e) => setError(String(e)) : () => {},
      ),
    [apply, enqueue, path],
  );

  const choose = useCallback(
    (choice: "reload" | "overwrite") =>
      enqueue(
        async () => {
          const disk = await readDisk(path);
          const now = current.current;
          if (now) await apply(resolve(now, disk, choice));
        },
        (e) => setError(String(e)),
      ),
    [apply, enqueue, path],
  );

  useEffect(() => {
    if (!loaded) return;
    const onFocus = () => check(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loaded, check]);

  const setContents = useCallback(
    (mine: string) => {
      if (current.current && current.current.mine !== mine) commit({ ...current.current, mine });
    },
    [commit],
  );

  useCommand("save-file", () => check(true));

  return {
    loaded: loaded?.text ?? null,
    revision: loaded?.revision ?? 0,
    dirty: loaded !== null && isDirty(file),
    conflict: file.conflict,
    error,
    setContents,
    reload: () => choose("reload"),
    overwrite: () => choose("overwrite"),
  };
}
