import { useState } from "react";
import { Button } from "../chrome/kit";
import { isLocalPath } from "../lib/client/registry";
import { describeFileError } from "../lib/fileError";
import { filesHost } from "../lib/host";

/**
 * Stands in for a file Crew couldn't open as text: a folder, a binary, one that
 * is gone. Says which in words, and hands it to Finder or the app macOS picks
 * when that can help.
 */
export function FileNotice({ path, relative, error }: { path: string; relative: string; error: string }) {
  const host = filesHost();
  const [failure, setFailure] = useState<string | null>(null);
  const { icon: Glyph, title, detail, openable } = describeFileError(error, relative.split("/").pop() || relative);
  const local = host && isLocalPath(path);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-canvas px-6 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl border border-border bg-sidebar text-text-muted">
        <Glyph className="size-5" strokeWidth={1.75} />
      </span>
      <div className="flex max-w-sm flex-col items-center gap-1">
        <p className="font-medium text-balance text-text">{title}</p>
        <p className="text-pretty text-text-muted">{detail}</p>
        <p className="mt-1 max-w-full truncate font-mono text-[12px] text-placeholder" title={path}>
          {relative}
        </p>
      </div>
      {local && (
        <div className="flex gap-2">
          {openable && (
            <Button onClick={() => void host.openExternal(path).then((message) => setFailure(message || null))}>
              Open in Default App
            </Button>
          )}
          <Button onClick={() => void host.reveal(path)}>Show in Finder</Button>
        </div>
      )}
      {failure && <p className="max-w-sm text-red-600">{failure}</p>}
    </div>
  );
}
