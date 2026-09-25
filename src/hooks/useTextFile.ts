import { useCallback, useEffect, useState } from "react";
import { useCommand } from "./useCommand";
import * as api from "../lib/api";

/**
 * A text file open for editing: what disk had when it loaded, what was last
 * saved, and what the editor holds now. Owns `save-file` while mounted.
 */
export function useTextFile(path: string) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [contents, setContents] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = loaded !== null && contents !== saved;

  useEffect(() => {
    let cancelled = false;
    api
      .readTextFile(path)
      .then((text) => {
        if (cancelled) return;
        setLoaded(text);
        setSaved(text);
        setContents(text);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await api.writeTextFile(path, contents);
      setSaved(contents);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [contents, dirty, path, saving]);

  useCommand("save-file", () => void save());

  return { loaded, saved, dirty, error, setContents };
}
