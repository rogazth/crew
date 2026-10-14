import { FolderIcon } from "lucide-react";
import { FileTypeIcon } from "./FileTypeIcon";

/**
 * A file named in text: its icon and its name, the full path on hover. One look
 * for a path in an agent's reply and an `@mention` in a sent message. With
 * `full` the directory shows before the name; when space runs out the
 * directory truncates first, so the name stays readable and the line never breaks.
 * A path ending in `/` is a folder's.
 */
export function FileRef({ path, full, onOpen }: { path: string; full?: boolean; onOpen: (path: string) => void }) {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  const name = path.slice(cut + 1).replace(/\/+$/, "") || path;
  const dir = full && cut >= 0 ? path.slice(0, cut + 1) : "";
  return (
    <button type="button" onClick={() => onOpen(path)} title={path} className="crew-file-ref">
      {path.endsWith("/") ? <FolderIcon className="size-3 shrink-0 text-icon" aria-hidden /> : <FileTypeIcon name={name} className="size-3" />}
      <span className="crew-file-ref-path">
        {dir && <span className="crew-file-ref-dir">{dir}</span>}
        <span className="crew-file-ref-name">{name}</span>
      </span>
    </button>
  );
}
