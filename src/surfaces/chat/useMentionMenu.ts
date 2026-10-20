// The `@` menu of a message being typed, for the session's composer and for the
// start screen's alike: the files the project index holds plus the folder being
// typed into, read from disk once.
import { useEffect, useMemo, useState } from "react";
import { listFolder } from "../../lib/api";
import { folderChoices, foldersOf, mentionAt, mentionFolder, mergeChoices, searchFiles, type MentionChoice } from "../../lib/mentions";
import type { FolderEntry } from "../../lib/protocol";
import type { ProjectFile } from "../../lib/types";

export function useMentionMenu(
  draft: string,
  cursor: number,
  projectFiles: ProjectFile[],
  resolvePath: (path: string) => string | null,
) {
  const mention = mentionAt(draft, cursor);
  const root = useMemo(() => resolvePath("./")?.replace(/\/+$/, "") ?? "", [resolvePath]);
  const indexed = useMemo<MentionChoice[]>(() => [...projectFiles, ...foldersOf(projectFiles, root)], [projectFiles, root]);
  // The folder being typed into is read from disk, once per folder: the index leaves out large folders git ignores.
  const typedFolder = mention ? mentionFolder(mention.query) : null;
  const listing = useFolderListing(typedFolder?.folder ?? null, resolvePath);
  const results = useMemo(() => {
    if (!mention || !typedFolder) return [];
    const listed = listing ? folderChoices(listing, typedFolder.folder, typedFolder.rest) : [];
    return mergeChoices(listed, searchFiles(mention.query, indexed));
  }, [mention?.query, indexed, listing]); // eslint-disable-line react-hooks/exhaustive-deps
  return { mention, indexed, results };
}

/** What `folder` (relative to the session's) holds, read when it is first typed; null until it is read. */
function useFolderListing(folder: string | null, resolvePath: (path: string) => string | null): FolderEntry[] | null {
  const [listing, setListing] = useState<{ folder: string; entries: FolderEntry[] } | null>(null);
  useEffect(() => {
    if (folder === null) return;
    const path = resolvePath(folder || "./")?.replace(/\/+$/, "");
    if (!path) return;
    let live = true;
    listFolder(path).then(
      (entries) => live && setListing({ folder, entries }),
      () => live && setListing({ folder, entries: [] }),
    );
    return () => {
      live = false;
    };
  }, [folder, resolvePath]);
  return listing && listing.folder === folder ? listing.entries : null;
}
