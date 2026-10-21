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

export function mountFileIconSprite() {
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

/** The same icon as `FileTypeIcon`, as a plain element for code outside React (an editor widget). */
export function fileTypeIconElement(name: string, dir = false): SVGSVGElement {
  mountFileIconSprite();
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", `#${dir ? folderIconId(name) : fileIconId(name)}`);
  svg.append(use);
  return svg;
}
