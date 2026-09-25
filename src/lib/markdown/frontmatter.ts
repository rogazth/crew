/**
 * Enough YAML to show a note's properties the way Obsidian does: top-level
 * keys with a scalar, a `[flow, list]` or a `- block` list. Anything deeper
 * shows as its raw text; the source is always one click away.
 */

export type Property = { key: string; value: string | string[]; from: number };

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function flowList(value: string): string[] | null {
  const v = value.trim();
  if (!v.startsWith("[") || !v.endsWith("]")) return null;
  const inner = v.slice(1, -1).trim();
  return inner ? inner.split(",").map(unquote).filter(Boolean) : [];
}

/** `source` is the whole block, fences included; `from` is each key's offset in it. */
export function parseProperties(source: string): Property[] {
  const lines = source.split("\n");
  const out: Property[] = [];
  let at = 0;
  let current: Property | null = null;
  lines.forEach((line, i) => {
    const offset = at;
    at += line.length + 1;
    if (i === 0 || /^(?:---|\.\.\.)\s*$/.test(line) || !line.trim() || line.trimStart().startsWith("#")) return;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && current) {
      const list: string[] = Array.isArray(current.value) ? current.value : current.value ? [current.value] : [];
      list.push(unquote(item[1]!));
      current.value = list;
      return;
    }
    const pair = /^([^\s:#][^:]*):(?:\s+(.*))?$/.exec(line);
    if (pair) {
      const raw = pair[2] ?? "";
      current = { key: pair[1]!.trim(), value: flowList(raw) ?? unquote(raw), from: offset };
      out.push(current);
      return;
    }
    // A continuation of something deeper: keep it visible rather than lose it.
    if (current && !Array.isArray(current.value)) current.value = `${current.value} ${line.trim()}`.trim();
  });
  return out;
}
