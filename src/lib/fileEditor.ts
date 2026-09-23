/** The tab's leaf name, from the workspace-relative path. */
export function fileName(relative: string): string {
  return relative.split("/").pop() ?? relative;
}

/** Unsaved: the editor holds something other than what was last written. Nothing is dirty before the read lands. */
export function isDirty(loaded: string | null, saved: string, contents: string): boolean {
  return loaded !== null && contents !== saved;
}

/**
 * One item, so CodeView is really "a virtualized File". A stable cacheKey and
 * id are what let the editor persist per-file state across tab switches.
 */
export function editorItems(path: string, name: string, loaded: string | null) {
  return loaded === null
    ? []
    : [{ id: path, type: "file" as const, file: { name, contents: loaded, cacheKey: path }, edit: true }];
}
