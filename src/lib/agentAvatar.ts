import { Avatar, Style, type StyleDefinition } from "@dicebear/core";

type Definition = { default: unknown };

/**
 * DiceBear styles an agent's face can come from. All CC0 except Bottts
 * Neutral, whose author allows personal and commercial use — none of them ask
 * for attribution. Each definition is its own chunk, loaded on first use.
 */
export const AGENT_AVATARS = [
  { id: "gaze", label: "Gaze", load: (): Promise<Definition> => import("@dicebear/styles/gaze.json") },
  { id: "pixelbot", label: "Pixelbot", load: (): Promise<Definition> => import("@dicebear/styles/pixelbot.json") },
  { id: "voxel-bot", label: "Voxel Bot", load: (): Promise<Definition> => import("@dicebear/styles/voxel-bot.json") },
  { id: "bottts-neutral", label: "Bottts", load: (): Promise<Definition> => import("@dicebear/styles/bottts-neutral.json") },
  { id: "moods", label: "Moods", load: (): Promise<Definition> => import("@dicebear/styles/moods.json") },
  { id: "glass", label: "Glass", load: (): Promise<Definition> => import("@dicebear/styles/glass.json") },
  { id: "blobs", label: "Blobs", load: (): Promise<Definition> => import("@dicebear/styles/blobs.json") },
] as const;

export type AgentAvatarId = (typeof AGENT_AVATARS)[number]["id"];

export const DEFAULT_AGENT_AVATAR: AgentAvatarId = "gaze";

export function parseAgentAvatar(raw: string | null): AgentAvatarId {
  return AGENT_AVATARS.some((avatar) => avatar.id === raw)
    ? (raw as AgentAvatarId)
    : DEFAULT_AGENT_AVATAR;
}

/** A face picked for one agent: a style other than everyone's, a seed other than its id, or both. */
export type AgentFace = { style?: AgentAvatarId; seed?: string };
export type AgentFaces = Record<string, AgentFace>;

export function parseFaces(raw: string | null): AgentFaces {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { style?: unknown; seed?: unknown }>;
    const out: AgentFaces = {};
    for (const [id, face] of Object.entries(parsed)) {
      const style = AGENT_AVATARS.some((avatar) => avatar.id === face?.style) ? (face.style as AgentAvatarId) : undefined;
      const seed = typeof face?.seed === "string" && face.seed ? face.seed : undefined;
      if (style || seed) out[id] = { ...(style ? { style } : {}), ...(seed ? { seed } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

/** Fresh seeds to choose a face from; each shuffle deals a new hand. */
export function dealSeeds(count: number): string[] {
  return Array.from({ length: count }, () => crypto.randomUUID().slice(0, 8));
}

const styles = new Map<AgentAvatarId, Promise<Style<StyleDefinition>>>();

/** One parsed style per id, shared by every avatar that draws from it. */
export function loadAvatarStyle(id: AgentAvatarId): Promise<Style<StyleDefinition>> {
  let style = styles.get(id);
  if (!style) {
    const entry = AGENT_AVATARS.find((avatar) => avatar.id === id)!;
    style = entry.load().then((module) => new Style(module.default as StyleDefinition));
    // A failed chunk load shouldn't stick; the next render gets to try again.
    style.catch(() => styles.delete(id));
    styles.set(id, style);
  }
  return style;
}

const uris = new Map<string, string>();

/** The same seed always draws the same face, so a rendered one is kept. */
export function avatarUri(id: AgentAvatarId, style: Style<StyleDefinition>, seed: string): string {
  const key = `${id}\n${seed}`;
  let uri = uris.get(key);
  if (!uri) {
    uri = new Avatar(style, { seed }).toDataUri();
    uris.set(key, uri);
  }
  return uri;
}
