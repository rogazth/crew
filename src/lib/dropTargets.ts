import { writeTempFile } from "./api";
import { focusEnv } from "./client/registry";
import { LOCAL } from "./client/route";
import { onDragDrop } from "./host";

type Target = {
  el: () => HTMLElement | null;
  onDrop: (paths: string[]) => void;
  onOver: (over: boolean) => void;
};

const targets = new Set<Target>();
let hovered: Target | null = null;
let listening = false;

function under(position: { x: number; y: number }): Target | null {
  const ratio = window.devicePixelRatio || 1;
  const x = position.x / ratio;
  const y = position.y / ratio;
  let found: Target | null = null;
  for (const target of targets) {
    const el = target.el();
    // Background tabs keep their DOM to keep their process; offsetParent tells them apart.
    if (!el?.offsetParent) continue;
    const rect = el.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) found = target;
  }
  return found;
}

function hover(next: Target | null) {
  if (hovered === next) return;
  hovered?.onOver(false);
  hovered = next;
  next?.onOver(true);
}

function listen() {
  if (listening) return;
  listening = true;
  onDragDrop((payload) => {
    if (payload.type === "enter" || payload.type === "over") {
      hover(under(payload.position));
      return;
    }
    if (payload.type === "drop") {
      const target = under(payload.position);
      hover(null);
      if (target) void deliver(target, payload.files, payload.paths);
      return;
    }
    hover(null);
  });
}

async function deliver(target: Target, files: File[], paths: string[]) {
  if (focusEnv() === LOCAL) {
    if (paths.length > 0) target.onDrop(paths);
    return;
  }
  // A remote workspace cannot read this Mac's disk: the bytes go to its machine first.
  const results = await Promise.allSettled(files.map((file) => writeTempFile(file)));
  const uploaded: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") uploaded.push(result.value);
    else console.error("Drop rejected:", result.reason instanceof Error ? result.reason.message : result.reason);
  }
  if (uploaded.length > 0) target.onDrop(uploaded);
}

export function registerDropTarget(target: Target): () => void {
  listen();
  targets.add(target);
  return () => {
    if (hovered === target) hover(null);
    targets.delete(target);
  };
}
