import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ProjectFile } from "../lib/types";

/** Loaded once per workspace and matched in memory — see ARCHITECTURE.md. */
export function useProjectFiles(cwd: string | null) {
  const [files, setFiles] = useState<ProjectFile[]>([]);

  useEffect(() => {
    if (!cwd) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    api
      .listProjectFiles(cwd)
      .then((list) => !cancelled && setFiles(list))
      .catch(() => !cancelled && setFiles([]));
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return files;
}
