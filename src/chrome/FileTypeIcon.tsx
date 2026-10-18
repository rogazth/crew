import { memo, useInsertionEffect } from "react";
import sprite from "../assets/file-icons/sprite.svg?raw";
import "../assets/file-icons/palette.css";
import { fileIconId, folderIconId } from "../lib/fileIcons";

/*
 * File and folder icons from the Symbols theme (MIT, src/assets/file-icons). Every
 * icon is a <symbol> in one hidden sprite, mounted into <body> once on the first
 * render, so a row costs one <use> — cheap enough for the virtualized explorer.
 * Colours come from the sprite's `--fi-*` variables, lifted in dark mode by
 * palette.css. Rebuild with `npm run file-icons`.
 */

const SPRITE_ID = "crew-file-icons";
let mounted = false;

function mountSprite() {
  if (mounted) return;
  mounted = true;
  const holder = document.createElement("div");
  holder.innerHTML = sprite;
  const svg = holder.firstElementChild;
  if (!svg) return;
  svg.id = SPRITE_ID;
  // A hot reload swaps the old sprite for the new one.
  const stale = document.getElementById(SPRITE_ID);
  if (stale) stale.replaceWith(svg);
  else document.body.prepend(svg);
}

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
  useInsertionEffect(mountSprite, []);
  return (
    <svg className={`${className} shrink-0`} aria-hidden>
      <use href={`#${dir ? folderIconId(name) : fileIconId(name)}`} />
    </svg>
  );
});
