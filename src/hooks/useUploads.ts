import { useCallback, useState } from "react";

/** A file on its way to another machine, shown as a chip until it has a path there. */
export type Upload = { id: number; name: string; size: number; sent: number; error?: string };

export type UploadJob = {
  name: string;
  size: number;
  run: (onProgress: (sent: number) => void) => Promise<string>;
};

let next = 1;

/** Runs the jobs side by side and hands each finished path to `onDone`; a failed one stays, with why, until dismissed. */
export function useUploads(onDone: (paths: string[]) => void) {
  const [uploads, setUploads] = useState<Upload[]>([]);

  const start = useCallback(
    (jobs: UploadJob[]) => {
      for (const job of jobs) {
        const id = next++;
        const patch = (change: Partial<Upload>) =>
          setUploads((prev) => prev.map((upload) => (upload.id === id ? { ...upload, ...change } : upload)));
        setUploads((prev) => [...prev, { id, name: job.name, size: job.size, sent: 0 }]);
        job
          .run((sent) => patch({ sent }))
          .then((path) => {
            setUploads((prev) => prev.filter((upload) => upload.id !== id));
            onDone([path]);
          })
          .catch((error: unknown) => patch({ error: error instanceof Error ? error.message : String(error) }));
      }
    },
    [onDone],
  );

  const dismiss = useCallback((id: number) => setUploads((prev) => prev.filter((upload) => upload.id !== id)), []);
  const busy = uploads.some((upload) => upload.error === undefined);

  return { uploads, start, dismiss, busy };
}
