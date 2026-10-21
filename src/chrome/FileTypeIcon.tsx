import { memo, useInsertionEffect } from "react";
import { fileIconId, folderIconId } from "../lib/fileIcons";
import { mountFileIconSprite } from "./fileIconSprite";

export const FileTypeIcon = memo(function FileTypeIcon({
  name,
  className = "size-3.5",
  dir = false,
}: {
  name: string;
  className?: string;
  /** Draw `name` as a folder. */
  dir?: boolean;
  /** An expanded folder. Symbols draws folders the same open or closed, so it changes nothing yet. */
  open?: boolean;
}) {
  useInsertionEffect(mountFileIconSprite, []);
  return (
    <svg className={`${className} shrink-0`} aria-hidden>
      <use href={`#${dir ? folderIconId(name) : fileIconId(name)}`} />
    </svg>
  );
});
