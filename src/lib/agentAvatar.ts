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
