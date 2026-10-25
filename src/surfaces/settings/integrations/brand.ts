// What a connector's mark and name are drawn from, whether it is installed
// or only in the registry.
import type { Connector, RegistryServer } from "../../../lib/protocol";

/** What a mark is drawn from, whether the connector is installed or only in the registry. */
export type Brand = { id: string; name: string; publisher: string; logo: string | null };

export const brandOf = (connector: Connector): Brand => ({
  id: connector.id,
  name: connector.name,
  publisher: connector.publisher,
  logo: connector.iconUrl,
});

/** A registry server's display name: its title without "MCP Server", else the word its name is about. */
export function serverName(server: RegistryServer): string {
  const title = server.title?.replace(/\s+(MCP\s*Server|MCP)$/i, "").trim();
  if (title) return title;
  const [namespace = "", slug = ""] = server.name.split("/");
  const word = namespace.startsWith("io.github.") ? slug.replace(/(^mcp-|-mcp(-server)?$)/g, "") : (namespace.split(".")[1] ?? slug);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export const brandOfServer = (server: RegistryServer): Brand => ({
  id: server.name,
  name: serverName(server),
  publisher: server.publisher,
  logo: server.iconUrl,
});
