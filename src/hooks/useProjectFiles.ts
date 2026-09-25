import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { ProjectFile } from "../lib/types";
import { useFilePrefs } from "./useFilePrefs";

const NONE: ProjectFile[] = [];

/** Loaded once per workspace and matched in memory — see ARCHITECTURE.md. */
export function useProjectFiles(cwd: string | null) {
  const { prefs } = useFilePrefs();
  const [loaded, setLoaded] = useState<{ cwd: string; files: ProjectFile[] } | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let cancelled = false;
    api
      .listProjectFiles(cwd, prefs.include)
      .then((files) => !cancelled && setLoaded({ cwd, files }))
      .catch(() => !cancelled && setLoaded({ cwd, files: NONE }));
    return () => {
      cancelled = true;
    };
  }, [cwd, prefs.include]);

  return loaded && loaded.cwd === cwd ? loaded.files : NONE;
}
