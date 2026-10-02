import { FolderOpenIcon, GlobeIcon } from "lucide-react";
import { fileView, rendersAsPage } from "../lib/browser/files";
import { isLocalPath } from "../lib/client/registry";
import { filesHost } from "../lib/host";
import { FileEditor } from "./FileEditor";
import { ImageView } from "./ImageView";
import type { ProjectFile } from "../lib/types";

type Props = {
  path: string;
  relative: string;
  files: ProjectFile[];
  onOpenPath: (path: string) => void;
  /** Renders the file in a page tab. */
  onOpenInBrowser: (file: { path: string; relative: string }) => void;
};

/**
 * A file tab: images open in the viewer, anything else in the editor. An HTML
 * or SVG file's editor has a button to render it in a page tab; a PDF or a
 * video never lands here, it opens in a page tab of its own.
 */
export function FileView({ onOpenInBrowser, ...props }: Props) {
  if (fileView(props.relative) === "image") {
    return <ImageView path={props.path} relative={props.relative} actions={<RevealButton path={props.path} />} />;
  }
  const render = rendersAsPage(props.relative) ? (
    <button
      type="button"
      title="Open in Browser"
      onClick={() => onOpenInBrowser({ path: props.path, relative: props.relative })}
      className="-mr-2 flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[12px] text-icon hover:bg-hover hover:text-text"
    >
      <GlobeIcon className="size-4" />
      Open in Browser
    </button>
  ) : null;
  return <FileEditor {...props} actions={render} />;
}

const HEADER_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-icon hover:bg-hover hover:text-text";

/** Reveals the file in Finder. */
function RevealButton({ path }: { path: string }) {
  const host = filesHost();
  if (!host || !isLocalPath(path)) return null;
  return (
    <button type="button" aria-label="Show in Finder" title="Show in Finder" onClick={() => void host.reveal(path)} className={HEADER_BUTTON}>
      <FolderOpenIcon className="size-4" />
    </button>
  );
}
