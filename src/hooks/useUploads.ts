import { useCallback, useRef, useState } from "react";

/** A file on its way to another machine, shown as a chip until it has a path there. */
export type Upload = { id: number; name: string; size: number; sent: number; error?: string };

export type UploadJob = {
  name: string;
  size: number;
  run: (onProgress: (sent: number) => void, signal: AbortSignal) => Promise<string>;
};

let next = 1;

/**
 * Runs the jobs side by side and hands each finished path to `onDone`; a failed
 * one stays, with why, until dismissed. Dismissing one still running cancels it.
 */
export function useUploads(onDone: (paths: string[]) => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const running = useRef(new Map<number, AbortController>());

  const start = useCallback(
    (jobs: UploadJob[]) => {
      for (const job of jobs) {
        const id = next++;
        const patch = (change: Partial<Upload>) =>
          setUploads((prev) => prev.map((upload) => (upload.id === id ? { ...upload, ...change } : upload)));
        const controller = new AbortController();
        running.current.set(id, controller);
        setUploads((prev) => [...prev, { id, name: job.name, size: job.size, sent: 0 }]);
        job
          .run((sent) => patch({ sent }), controller.signal)
          .then((path) => {
            if (controller.signal.aborted) return;
            setUploads((prev) => prev.filter((upload) => upload.id !== id));
            onDone([path]);
          })
          .catch((error: unknown) => {
            if (controller.signal.aborted) return;
            patch({ error: error instanceof Error ? error.message : String(error) });
          })
          .finally(() => running.current.delete(id));
      }
    },
    [onDone],
  );

  const dismiss = useCallback((id: number) => {
    running.current.get(id)?.abort();
    setUploads((prev) => prev.filter((upload) => upload.id !== id));
  }, []);
  const busy = uploads.some((upload) => upload.error === undefined);

  return { uploads, start, dismiss, busy };
}
