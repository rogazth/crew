import { useState } from "react";
import { Button } from "../chrome/kit";
import { filesHost } from "../lib/host";

/** A file that is not text and has no preview: Finder, or the app macOS picks, can open it. */
export function NoPreview({ path, relative }: { path: string; relative: string }) {
  const host = filesHost();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center">
      <p className="font-medium text-text">{relative.split("/").pop()} isn't a text file.</p>
      <p className="max-w-sm text-text-muted">Crew can't show it here.</p>
      {host && (
        <div className="flex gap-2">
          <Button
            onClick={() => void host.openExternal(path).then((message) => setError(message || null))}
          >
            Open in Default App
          </Button>
          <Button onClick={() => void host.reveal(path)}>Show in Finder</Button>
        </div>
      )}
      {error && <p className="max-w-sm text-red-600">{error}</p>}
    </div>
  );
}
