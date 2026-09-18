import { useEffect, useState } from "react";
import type { SearchHit, SearchInput } from "@crew/fixtures";
import { source } from "./source";

/** The source answers asynchronously even when it answers instantly. */
export function useSearchHits(input: SearchInput | null): {
  hits: SearchHit[];
  loading: boolean;
} {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const key = input ? JSON.stringify(input) : "";

  useEffect(() => {
    if (!key) {
      setHits([]);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    source
      .search(JSON.parse(key) as SearchInput)
      .then((found) => live && setHits(found))
      .catch(() => live && setHits([]))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [key]);

  return { hits, loading };
}
