// PROTOTYPE — throwaway. The browse list, from crewd's copy of the official MCP
// Registry (crew-core/src/registry.rs): the featured vendors with no query,
// a full-text search with one. The daemon syncs it from startup, so it is
// there the first time the page opens. Under CREW_MOCK the mock transport
// reads the live registry through Vite's /mcp-registry proxy instead.
import { useEffect, useState } from "react";
import { registrySearch } from "../../../lib/api";
import type { RegistryServer } from "../../../lib/protocol";
import { SERVICES, type Service } from "./store.prototype";

export type RegistryState = { services: Service[]; loading: boolean; error: boolean };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function nameOf(server: RegistryServer): string {
  const title = server.title?.replace(/\s+(MCP\s*Server|MCP)$/i, "").trim();
  if (title) return title;
  const [namespace = "", slug = ""] = server.name.split("/");
  const word = namespace.startsWith("io.github.") ? slug.replace(/(^mcp-|-mcp(-server)?$)/g, "") : (namespace.split(".")[1] ?? slug);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A registry server as a catalog service: the prototype's fixture when it has one (its tools are known), else a new one. The description is always the registry's own. */
function toService(server: RegistryServer): Service {
  const known = SERVICES.find((x) => x.registry === server.name);
  if (known) {
    if (server.iconUrl) known.logo = server.iconUrl;
    known.blurb = server.description;
    return known;
  }
  const name = nameOf(server);
  const hue = [...server.name].reduce((n, ch) => n + ch.charCodeAt(0) * 13, 0) % 360;
  return {
    id: server.name,
    name,
    registry: server.name,
    publisher: server.publisher,
    host: hostOf(server.remoteUrl),
    logo: server.iconUrl ?? undefined,
    glyph: name.slice(0, 1).toUpperCase(),
    hue,
    category: "Productivity",
    blurb: server.description,
    transport: "remote",
    tools: [],
  };
}

/** The browse list: the featured vendors with no query, the daemon's matches with one. */
export function useRegistry(query: string): RegistryState {
  const q = query.trim();
  // Loading is the result being for another query than the one asked.
  const [result, setResult] = useState<{ query: string | null; services: Service[]; error: boolean }>({ query: null, services: [], error: false });
  useEffect(() => {
    let live = true;
    const timer = window.setTimeout(
      () => {
        registrySearch(q, 60)
          .then((servers) => live && setResult({ query: q, services: servers.map(toService), error: false }))
          .catch(() => live && setResult({ query: q, services: [], error: true }));
      },
      q ? 150 : 0,
    );
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [q]);
  return { services: result.services, loading: result.query !== q, error: result.query === q && result.error };
}
