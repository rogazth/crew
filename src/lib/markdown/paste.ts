// react-doctor-disable-next-line react-doctor/prefer-dynamic-import -- only reached through the lazy MarkdownEditor
import { EditorView } from "@codemirror/view";
import * as api from "../api";
import { dirname, noteHost } from "./wikilinks";

/**
 * A pasted or dropped image lands in `attachments/` next to the note and is
 * linked with plain markdown, so the note still renders on GitHub.
 */

const FOLDER = "attachments";

function images(list: DataTransfer | null): File[] {
  return [...(list?.files ?? [])].filter((file) => file.type.startsWith("image/"));
}

function stamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** A dropped file keeps its name; a clipboard image, which has none worth keeping, gets a dated one. */
function baseName(file: File, pasted: boolean): string {
  const extension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace("svg+xml", "svg") ?? "png";
  if (pasted || !file.name) return `pasted-image-${stamp(new Date())}.${extension}`;
  return file.name.replace(/[^\w.\- ]+/g, "-").replace(/\s+/g, "-");
}

async function freePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 0; n < 100; n++) {
    const path = `${dir}/${n ? `${stem}-${n}` : stem}${extension}`;
    if (!(await api.pathExists(path))) return path;
  }
  throw new Error(`No free name for ${name}`);
}

async function insertImages(view: EditorView, files: File[], at: number, pasted: boolean) {
  const note = view.state.facet(noteHost).path;
  const dir = `${dirname(note)}/${FOLDER}`;
  const links: string[] = [];
  for (const file of files) {
    try {
      const path = await freePath(dir, baseName(file, pasted));
      await api.createFile(path, file);
      links.push(`![](${FOLDER}/${encodeURI(path.slice(dir.length + 1))})`);
    } catch (error) {
      console.error("Could not save the image", error);
    }
  }
  if (!links.length) return;
  const pos = Math.min(at, view.state.doc.length);
  const insert = links.join("\n");
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + insert.length },
    scrollIntoView: true,
    userEvent: pasted ? "input.paste" : "input.drop",
  });
}

export const imageDrops = EditorView.domEventHandlers({
  paste(event, view) {
    const files = images(event.clipboardData);
    if (!files.length) return false;
    event.preventDefault();
    const { from, to } = view.state.selection.main;
    if (from !== to) view.dispatch({ changes: { from, to } });
    void insertImages(view, files, from, true);
    return true;
  },
  drop(event, view) {
    const files = images(event.dataTransfer);
    if (!files.length) return false;
    event.preventDefault();
    const at = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    void insertImages(view, files, at, false);
    return true;
  },
});
