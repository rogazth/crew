import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ProjectFile } from "../lib/types";

const NONE: ProjectFile[] = [];

/** Loaded once per workspace and matched in memory — see ARCHITECTURE.md. */
export function useProjectFiles(cwd: string | null) {
  const [loaded, setLoaded] = useState<{ cwd: string; files: ProjectFile[] } | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    api
      .listProjectFiles(cwd)
      .then((files) => !cancelled && setLoaded({ cwd, files }))
      .catch(() => !cancelled && setLoaded({ cwd, files: NONE }));
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  return loaded && loaded.cwd === cwd ? loaded.files : NONE;
}
