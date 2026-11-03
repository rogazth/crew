// The browse list, from this Mac's copy of the official MCP Registry
// (crew-core/src/registry.rs): the featured vendors with no query, a
// full-text search with one. The daemon syncs it from startup, so it is there
// the first time the page opens.
import { useEffect, useState } from "react";
import { registrySearch } from "../../../lib/api";
import type { RegistryServer } from "../../../lib/protocol";

export type RegistryState = {
  servers: RegistryServer[];
  loading: boolean;
  /** The same query, asked for further down: the list shown stays until it lands. */
  loadingMore: boolean;
  /** A full answer: there may be more past it. */
  more: boolean;
  error: boolean;
};

/** The featured vendors with no query, the daemon's matches with one. */
export function useRegistry(query: string, limit = 60): RegistryState {
  const q = query.trim();
  // Loading is the result being for another query than the one asked.
  const [result, setResult] = useState<{ query: string | null; limit: number; servers: RegistryServer[]; error: boolean }>({
    query: null,
    limit: 0,
    servers: [],
    error: false,
  });
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => {
        registrySearch(q, limit)
          .then((servers) => live && setResult({ query: q, limit, servers, error: false }))
          .catch(() => live && setResult({ query: q, limit, servers: [], error: true }));
      },
      q && result.query !== q ? 150 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, limit]);
  return {
    servers: result.servers,
    loading: result.query !== q,
    loadingMore: result.query === q && result.limit !== limit,
    more: result.servers.length >= result.limit,
    error: result.query === q && result.error,
  };
}
