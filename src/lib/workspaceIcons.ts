// Each workspace's icon as the window draws it, asked of the daemon that holds the workspace
// (`crew_core::workspace_icon`), which looks in its repo and keeps the user's choice. The rail asks
// for what each shows; the settings page asks for what there is to pick from as well.
import * as api from "./api";
import type { IconUpload, WorkspaceIcon, WorkspaceIconSet } from "./protocol";

/** How long a workspace stays in front before it is worth asking again: ⌘1‥9 run past it untouched. */
export const SETTLE = 1_500;
/** What the file picker offers: the kinds the daemon keeps. */
export const UPLOAD_TYPES = "image/png,image/svg+xml,image/webp,image/jpeg,image/x-icon,image/vnd.microsoft.icon";
/** The largest image the daemon keeps. */
export const MAX_UPLOAD = 2 * 1024 * 1024;

const icons = new Map<string, WorkspaceIcon>();
const asking = new Map<string, Promise<WorkspaceIcon | null>>();
/** What went wrong with the last choice or upload, for the picker to say. */
const problems = new Map<string, string>();
let version = 0;
const listeners = new Set<() => void>();

function emit() {
  version++;
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes whenever any icon does: for useSyncExternalStore. */
export function snapshot(): number {
  return version;
}

export function iconOf(workspaceId: string): WorkspaceIcon | undefined {
  return icons.get(workspaceId);
}

/** What the workspace shows: an image's data URL, or null for its initials. */
export function imageOf(workspaceId: string): string | null {
  return icons.get(workspaceId)?.image ?? null;
}

/**
 * Asks the daemon again. `look`: it looks in the repo now; `choices`: with
 * what there is to pick from. The same question asked while one is out
 * waits on that one. A failure keeps what was shown.
 */
export function refresh(workspaceId: string, opts: { look?: boolean; choices?: boolean } = {}): Promise<WorkspaceIcon | null> {
  const key = `${workspaceId}:${opts.look ? 1 : 0}:${opts.choices ? 1 : 0}`;
  const pending = asking.get(key);
  if (pending) return pending;
  const ask = api
    .getWorkspaceIcon(workspaceId, opts)
    .then((icon) => {
      keep(workspaceId, icon, opts.choices ?? false);
      return icon;
    })
    .catch(() => null)
    .finally(() => asking.delete(key));
  asking.set(key, ask);
  return ask;
}

/** Keeps the user's choice through the daemon, and what it answers with. */
export async function choose(workspaceId: string, choice: Omit<WorkspaceIconSet, "id">): Promise<WorkspaceIcon> {
  const icon = await api.setWorkspaceIcon(workspaceId, choice);
  keep(workspaceId, icon, true);
  return icon;
}

export function problemOf(workspaceId: string): string | null {
  return problems.get(workspaceId) ?? null;
}

/** A choice made in the picker: what goes wrong is kept for it to say, and the next choice clears it. */
export async function pick(workspaceId: string, choice: Omit<WorkspaceIconSet, "id"> | (() => Promise<Omit<WorkspaceIconSet, "id">>)) {
  if (problems.delete(workspaceId)) emit();
  try {
    await choose(workspaceId, typeof choice === "function" ? await choice() : choice);
  } catch (failure) {
    problems.set(workspaceId, failure instanceof Error ? failure.message : String(failure));
    emit();
  }
}

/** A picked or dropped image, kept as the workspace's icon by the daemon that holds it. */
export function upload(workspaceId: string, file: File): Promise<void> {
  return pick(workspaceId, async () => ({ choice: "upload", upload: await readUpload(file) }));
}

/** An answer without the choices keeps those read before; the same answer again draws nothing. */
function keep(workspaceId: string, next: WorkspaceIcon, choices: boolean) {
  const before = icons.get(workspaceId);
  const merged = choices || !before ? next : { ...next, found: before.found, uploaded: before.uploaded };
  if (before && sameIcon(before, merged)) return;
  icons.set(workspaceId, merged);
  emit();
}

export function sameIcon(a: WorkspaceIcon, b: WorkspaceIcon): boolean {
  return (
    a.choice === b.choice &&
    a.path === b.path &&
    a.image === b.image &&
    a.uploaded === b.uploaded &&
    a.found.length === b.found.length &&
    a.found.every((file, i) => file.path === b.found[i]?.path && file.image === b.found[i]?.image)
  );
}

/** A file's image type: what the browser says, else what its name says (an .ico often comes untyped). */
export function mimeOf(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const byExt: Record<string, string> = {
    png: "image/png",
    svg: "image/svg+xml",
    webp: "image/webp",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    ico: "image/x-icon",
  };
  return byExt[ext] ?? "";
}

/** A data URL's base64 bytes, as an upload carries them; null when it is not base64. */
export function splitDataUrl(url: string, mime: string): IconUpload | null {
  const at = url.indexOf(";base64,");
  if (!url.startsWith("data:") || at < 0) return null;
  return { mime, data: url.slice(at + ";base64,".length) };
}

/** A picked or dropped file, read for the daemon; refused here when too big or not an image. */
export function readUpload(file: File): Promise<IconUpload> {
  const mime = mimeOf(file);
  if (!UPLOAD_TYPES.split(",").includes(mime)) return Promise.reject(new Error("Use a PNG, SVG, WebP, JPEG or ICO image"));
  if (file.size > MAX_UPLOAD) return Promise.reject(new Error("The image is over 2 MB"));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const upload = splitDataUrl(String(reader.result), mime);
      if (upload) resolve(upload);
      else reject(new Error("The image could not be read"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("The image could not be read"));
    reader.readAsDataURL(file);
  });
}

/** For tests: forgets every icon. */
export function resetWorkspaceIcons() {
  icons.clear();
  asking.clear();
  problems.clear();
  version = 0;
}
