/**
 * A page as an agent reads it: Chromium's accessibility tree, cut down to what
 * a person would name, as indented text. Modeled on chrome-devtools-mcp's
 * take_snapshot, so a model that has seen that format reads this one:
 *
 *     uid=3_7 button "Place order"
 *     uid=3_8 textbox "Email" value="ada@example.com" required
 *
 * Pure: it takes `Accessibility.getFullAXTree`'s nodes and gives back the
 * text and the uid → DOM node map the input tools resolve against.
 */

type AXValue = { type?: string; value?: unknown };

export type AXNode = {
  nodeId: string;
  parentId?: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  backendDOMNodeId?: number;
};

export type UidTarget = { backendNodeId: number; label: string };

export type AxSnapshot = { text: string; uids: Map<string, UidTarget> };

/** Past this the page is a feed or a table dump, and the rest is noise the model pays for. */
const MAX_LINES = 2000;
const MAX_NAME = 150;

/** Wrappers that carry nothing when they have no name of their own; their children move up. */
const TRANSPARENT = new Set(["none", "generic", "presentation", "LabelText", "LineBreak", "MenuListPopup", "Section"]);
/** A field shows its value on its own line; its inner editor would repeat it. */
const LEAF = new Set(["textbox", "searchbox", "InlineTextBox"]);

/** "3_7": the snapshot it came from, then the node's place in it. */
export function parseUid(uid: string): { snapshot: number; index: number } | null {
  const match = /^(\d+)_(\d+)$/.exec(uid.trim());
  if (!match) return null;
  return { snapshot: Number(match[1]), index: Number(match[2]) };
}

function str(value: AXValue | undefined): string {
  const raw = value?.value;
  return typeof raw === "string" || typeof raw === "number" ? String(raw) : "";
}

function clean(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.length > MAX_NAME ? `${flat.slice(0, MAX_NAME)}…` : flat;
  return cut.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function props(node: AXNode): Map<string, unknown> {
  return new Map((node.properties ?? []).map((prop) => [prop.name, prop.value?.value]));
}

/** The states worth a word, in a fixed order so two snapshots of one page diff cleanly. */
function attributes(node: AXNode, role: string): string[] {
  const p = props(node);
  const out: string[] = [];
  const value = clean(str(node.value));
  if (value) out.push(`value="${value}"`);
  const level = p.get("level");
  if (typeof level === "number") out.push(`level=${level}`);
  const url = p.get("url");
  // A data: image or a blob is bytes, not a place anyone goes.
  if (typeof url === "string" && (role === "link" || role === "RootWebArea") && /^https?:/i.test(url)) {
    out.push(`url="${clean(url)}"`);
  }
  if (p.get("focused") === true) out.push("focused");
  if (p.get("disabled") === true) out.push("disabled");
  const checked = p.get("checked") ?? p.get("pressed");
  if (checked === "true" || checked === true) out.push("checked");
  else if (checked === "mixed") out.push("mixed");
  if (p.get("selected") === true) out.push("selected");
  const expanded = p.get("expanded");
  if (expanded === true) out.push("expanded");
  if (p.get("required") === true) out.push("required");
  if (p.get("readonly") === true && role !== "RootWebArea") out.push("readonly");
  if (p.get("multiline") === true) out.push("multiline");
  if (p.get("invalid") === "true") out.push("invalid");
  return out;
}

export function formatAxTree(nodes: readonly AXNode[], snapshot: number): AxSnapshot {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const root = nodes.find((node) => !node.parentId || !byId.has(node.parentId));
  const lines: string[] = [];
  const uids = new Map<string, UidTarget>();
  let skipped = 0;

  /** Names of the non-text nodes directly under `id`, reached through the transparent ones. */
  const labelsUnder = (id: string | undefined): Set<string> => {
    const names = new Set<string>();
    const visit = (nodeId: string, depth: number) => {
      const node = byId.get(nodeId);
      if (!node || depth > 3) return;
      const role = str(node.role);
      const name = str(node.name).trim();
      if (!node.ignored && role !== "StaticText" && name) names.add(name);
      if (node.ignored || TRANSPARENT.has(role)) for (const child of node.childIds ?? []) visit(child, depth + 1);
    };
    for (const child of byId.get(id ?? "")?.childIds ?? []) visit(child, 0);
    return names;
  };

  const walk = (node: AXNode, depth: number, heading: string, siblings: Set<string>) => {
    const role = str(node.role);
    const name = str(node.name);
    const text = name.trim();
    if (role === "InlineTextBox") return;
    const quiet =
      node.ignored ||
      (TRANSPARENT.has(role) && !text) ||
      (role === "image" && !text) ||
      // Text that only repeats its link's or its field's name.
      (role === "StaticText" && (!text || text === heading || siblings.has(text)));
    let childDepth = depth;
    let childHeading = heading;
    if (!quiet) {
      if (lines.length >= MAX_LINES) {
        skipped += 1;
      } else {
        const parts: string[] = [];
        if (node.backendDOMNodeId !== undefined) {
          const uid = `${snapshot}_${uids.size}`;
          const label = text ? `${role} "${clean(text)}"` : role;
          uids.set(uid, { backendNodeId: node.backendDOMNodeId, label });
          parts.push(`uid=${uid}`);
        }
        parts.push(role || "unknown");
        if (text) parts.push(`"${clean(text)}"`);
        parts.push(...attributes(node, role));
        lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
      }
      childDepth = depth + 1;
      childHeading = text;
    }
    if (LEAF.has(role)) return;
    // Ignored and transparent nodes pass their own siblings' names down, since their children now stand beside them.
    const childSiblings = quiet ? new Set([...siblings, ...labelsUnder(node.nodeId)]) : labelsUnder(node.nodeId);
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, childDepth, childHeading, childSiblings);
    }
  };

  if (root) walk(root, 0, "", new Set());
  if (skipped > 0) lines.push(`… ${skipped} more nodes not shown; the page is long. Use browser_evaluate to read a part of it.`);
  return { text: lines.join("\n"), uids };
}
