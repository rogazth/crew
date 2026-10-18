import { DEFAULT_FILE_ICON, DEFAULT_FOLDER_ICON, FILE_EXTENSIONS, FILE_NAMES, FOLDER_NAMES, LANGUAGE_IDS } from "./fileIconManifest";

/**
 * Which sprite symbol (src/assets/file-icons/sprite.svg) draws a file or folder,
 * following the Symbols VS Code theme: an exact basename wins, then the longest
 * compound extension ("a.d.ts" tries "d.ts" before "ts"), then — for names like
 * CodeBlock's `code.<lang>` — a language id, then the generic icon. Case-insensitive.
 */

const LIMIT = 5000;
const files = new Map<string, string>();
const folders = new Map<string, string>();

const own = (map: Record<string, string>, key: string): string | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

function basename(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1).toLowerCase();
}

function remember(cache: Map<string, string>, key: string, id: string): string {
  if (cache.size >= LIMIT) cache.clear();
  cache.set(key, id);
  return id;
}

function resolveFile(name: string): string {
  const exact = own(FILE_NAMES, name);
  if (exact) return exact;
  for (let dot = name.indexOf("."); dot !== -1; dot = name.indexOf(".", dot + 1)) {
    const extension = name.slice(dot + 1);
    if (!extension) break;
    const id = own(FILE_EXTENSIONS, extension);
    if (id) return id;
  }
  const last = name.lastIndexOf(".");
  return (last !== -1 && own(LANGUAGE_IDS, name.slice(last + 1))) || DEFAULT_FILE_ICON;
}

export function fileIconId(name: string): string {
  const key = basename(name);
  return files.get(key) ?? remember(files, key, resolveFile(key));
}

export function folderIconId(name: string): string {
  const key = basename(name);
  return folders.get(key) ?? remember(folders, key, own(FOLDER_NAMES, key) ?? DEFAULT_FOLDER_ICON);
}
