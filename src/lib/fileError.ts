import type { LucideIcon } from "lucide-react";
import { FileLockIcon, FileQuestionIcon, FileWarningIcon, FileXIcon, FolderIcon } from "lucide-react";

export type FileProblem = {
  icon: LucideIcon;
  title: string;
  detail: string;
  /** Whether another app might still open it: offer the default app. */
  openable: boolean;
};

/** A failed read of `name`, in words: the daemon reports it in Rust's. */
export function describeFileError(error: string, name: string): FileProblem {
  if (/valid UTF-8/i.test(error)) {
    return { icon: FileQuestionIcon, title: `${name} isn't a text file.`, detail: "Crew can't show it here.", openable: true };
  }
  if (/is a directory|os error 21/i.test(error)) {
    return { icon: FolderIcon, title: `${name} is a folder.`, detail: "Crew opens files here. Finder can show what's inside.", openable: false };
  }
  if (/no such file|os error 2\b/i.test(error)) {
    return { icon: FileXIcon, title: `${name} isn't there anymore.`, detail: "It may have been moved, renamed, or deleted.", openable: false };
  }
  if (/permission denied|operation not permitted|os error (?:1|13)\b/i.test(error)) {
    return { icon: FileLockIcon, title: `Crew can't read ${name}.`, detail: "You don't have permission to open it.", openable: false };
  }
  if (/too large/i.test(error)) {
    return { icon: FileWarningIcon, title: `${name} is too large to open here.`, detail: "Another app can open it.", openable: true };
  }
  return { icon: FileWarningIcon, title: `Crew couldn't open ${name}.`, detail: error, openable: true };
}
