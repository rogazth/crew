import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import * as api from "./api";
import { findPaths, homePath, resolvePath, type PathHit } from "./terminalPaths";

export { openExternal } from "./external";

const known = new Map<string, boolean>();

async function exists(path: string): Promise<boolean> {
  const cached = known.get(path);
  if (cached !== undefined) return cached;
  const found = await api.pathExists(path).catch(() => false);
  if (known.size > 500) known.clear();
  known.set(path, found);
  return found;
}

/**
 * Underlines the paths an agent prints and opens them inside Crew. Only the
 * hovered line is scanned, and only paths that resolve to a real file become
 * links, which is what keeps prose from lighting up.
 */
export function filePathProvider(
  term: Terminal,
  cwd: string,
  open: (path: string) => void,
): ILinkProvider {
  return {
    provideLinks(lineNumber, callback) {
      const line = term.buffer.active.getLine(lineNumber - 1)?.translateToString(true);
      const hits = line ? findPaths(line) : [];
      if (hits.length === 0) {
        callback(undefined);
        return;
      }
      void Promise.all(
        hits.map(async (hit) => {
          const path = resolvePath(hit.path, cwd, homePath());
          return (await exists(path)) ? toLink(hit, lineNumber, () => open(path)) : null;
        }),
      ).then((links) => {
        const found = links.filter((link): link is ILink => link !== null);
        callback(found.length > 0 ? found : undefined);
      });
    },
  };
}

function toLink(hit: PathHit, lineNumber: number, activate: () => void): ILink {
  return {
    text: hit.text,
    range: {
      start: { x: hit.start + 1, y: lineNumber },
      end: { x: hit.start + hit.text.length, y: lineNumber },
    },
    activate,
  };
}
