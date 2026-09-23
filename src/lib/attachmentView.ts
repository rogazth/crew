import { isImage } from "./attachments";
import type { AttachedFile } from "./blocks";

/** Images become thumbnails that open the viewer; everything else is a chip. */
export function splitAttachments(files: AttachedFile[]): { images: AttachedFile[]; others: AttachedFile[] } {
  return { images: files.filter(isImage), others: files.filter((file) => !isImage(file)) };
}

/** The viewer's index after a step, wrapping at both ends. */
export function wrapIndex(index: number, delta: number, count: number): number {
  return (index + delta + count) % count;
}

/** The arrow keys walk the viewer; anything else is not its key. */
export function lightboxStep(key: string): -1 | 1 | 0 {
  if (key === "ArrowLeft") return -1;
  if (key === "ArrowRight") return 1;
  return 0;
}
