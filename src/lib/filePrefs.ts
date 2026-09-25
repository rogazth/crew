export type FilePrefs = {
  /** Workspace folders the file search indexes even when git ignores them or they start with a dot. */
  include: string[];
};

export const DEFAULT_FILE_PREFS: FilePrefs = { include: [] };

/** Commas or newlines separate folders; slashes at the ends and repeats are dropped. */
export function parseFolders(text: string): string[] {
  const folders = text
    .split(/[,\n]/)
    .map((folder) => folder.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return [...new Set(folders)];
}

export function parseFilePrefs(raw: string | null): FilePrefs {
  if (!raw) return DEFAULT_FILE_PREFS;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_FILE_PREFS;
    const { include } = parsed as Partial<Record<keyof FilePrefs, unknown>>;
    if (!Array.isArray(include)) return DEFAULT_FILE_PREFS;
    return { include: parseFolders(include.filter((folder) => typeof folder === "string").join(",")) };
  } catch {
    return DEFAULT_FILE_PREFS;
  }
}
