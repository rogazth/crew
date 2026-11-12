import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { firstFile, firstKnown } from "../../lib/fileProbe";
import { useChatActions } from "./context";

/** The folders the message being drawn names: where a bare file name is looked for after the session's folder. */
export const MessageDirs = createContext<readonly string[]>([]);

/**
 * The files the chat's own calls read or edited, as they named them. A reply
 * that says `ARCHITECTURE.md` means the one it just read in `docs/`, not one
 * at the root that is not there.
 */
export const ChatFiles = createContext<readonly string[]>([]);

type Watcher = (visible: boolean) => void;
const watchers = new WeakMap<Element, Watcher>();
let observer: IntersectionObserver | null = null;

/** One observer for every file in every chat: a long transcript names thousands. */
function observe(el: Element, watcher: Watcher): () => void {
  if (typeof IntersectionObserver === "undefined") {
    queueMicrotask(() => watcher(true));
    return () => undefined;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) watchers.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: "400px 0px" },
  );
  watchers.set(el, watcher);
  observer.observe(el);
  return () => {
    watchers.delete(el);
    observer?.unobserve(el);
  };
}

/**
 * Where on disk the file a reply names is, once it is known to be there:
 * the path as given, then the session's folder, then the folders the message
 * names. Nothing is asked until the name scrolls near the screen, and each
 * path is asked once however often it appears. `undefined` while unknown,
 * `null` when it is nowhere.
 */
export function useFileOnDisk(path: string) {
  const { resolvePath } = useChatActions();
  const dirs = useContext(MessageDirs);
  const touched = useContext(ChatFiles);
  const candidates = useMemo(() => {
    const own = resolvePath(path);
    const list = own ? [own] : [];
    if (path && !path.startsWith("/") && !path.startsWith("~/")) {
      const relative = path.replace(/^\.\//, "");
      for (const dir of dirs) {
        const base = resolvePath(dir);
        if (base) list.push(`${base}/${relative}`);
      }
      for (const file of touched) {
        if (file.endsWith(`/${relative}`)) {
          const full = resolvePath(file);
          if (full) list.push(full);
        }
      }
    }
    return [...new Set(list)];
  }, [path, dirs, touched, resolvePath]);
  const key = candidates.join("\n");
  const [found, setFound] = useState<{ key: string; file: string | null } | null>(null);
  const ref = useRef<HTMLElement>(null);
  const known = found?.key === key ? found.file : firstKnown(candidates);

  useEffect(() => {
    const el = ref.current;
    if (!el || known !== undefined || candidates.length === 0) return;
    let live = true;
    let asked = false;
    const stop = observe(el, (visible) => {
      if (!visible || asked) return;
      asked = true;
      stop();
      void firstFile(candidates).then((file) => {
        if (live) setFound({ key, file });
      });
    });
    return () => {
      live = false;
      stop();
    };
    // `key` stands for `candidates`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, known]);

  return { ref, file: candidates.length === 0 ? null : known };
}
