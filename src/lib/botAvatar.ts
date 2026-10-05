import { Avatar, Style, type StyleDefinition } from "@dicebear/core";

type Definition = { default: unknown };

/**
 * DiceBear styles a bot's face can come from. All CC0, and every one can
 * move: a working bot's face comes alive. Each definition is its own chunk,
 * loaded on first use.
 */
export const BOT_AVATARS = [
  { id: "gaze", label: "Gaze", load: (): Promise<Definition> => import("@dicebear/styles/gaze.json") },
  { id: "pixelbot", label: "Pixelbot", load: (): Promise<Definition> => import("@dicebear/styles/pixelbot.json") },
  { id: "voxel-bot", label: "Voxel Bot", load: (): Promise<Definition> => import("@dicebear/styles/voxel-bot.json") },
  { id: "moods", label: "Moods", load: (): Promise<Definition> => import("@dicebear/styles/moods.json") },
  { id: "glass", label: "Glass", load: (): Promise<Definition> => import("@dicebear/styles/glass.json") },
  { id: "blobs", label: "Blobs", load: (): Promise<Definition> => import("@dicebear/styles/blobs.json") },
] as const;

export type BotAvatarId = (typeof BOT_AVATARS)[number]["id"];

export const DEFAULT_BOT_AVATAR: BotAvatarId = "gaze";

export function parseBotAvatar(raw: string | null): BotAvatarId {
  return BOT_AVATARS.some((avatar) => avatar.id === raw)
    ? (raw as BotAvatarId)
    : DEFAULT_BOT_AVATAR;
}

/** A face picked for one bot: a style other than everyone's, a seed other than its id, or both. */
export type BotFace = { style?: BotAvatarId; seed?: string };
export type BotFaces = Record<string, BotFace>;

export function parseFaces(raw: string | null): BotFaces {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, { style?: unknown; seed?: unknown }>;
    const out: BotFaces = {};
    for (const [id, face] of Object.entries(parsed)) {
      const style = BOT_AVATARS.some((avatar) => avatar.id === face?.style) ? (face.style as BotAvatarId) : undefined;
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

const styles = new Map<BotAvatarId, Promise<Style<StyleDefinition>>>();

/** One parsed style per id, shared by every avatar that draws from it. */
export function loadAvatarStyle(id: BotAvatarId): Promise<Style<StyleDefinition>> {
  let style = styles.get(id);
  if (!style) {
    const entry = BOT_AVATARS.find((avatar) => avatar.id === id)!;
    style = entry.load().then((module) => new Style(module.default as StyleDefinition));
    // A failed chunk load shouldn't stick; the next render gets to try again.
    style.catch(() => styles.delete(id));
    styles.set(id, style);
  }
  return style;
}

/**
 * How each style sits in the chrome. Faces that are a figure on a square
 * (voxel bots, moods) drop the square and stand on the surface; styles whose
 * square is the face keep it, rounded like every other shape in the app.
 * Styles that leave a margin around the face crop in, as DiceBear's own Close
 * Up preset does, so the face fills the frame at chrome sizes.
 */
type Render = { backgroundColor?: string[]; borderRadius?: number; scale?: number };

const RENDER: Record<BotAvatarId, Render> = {
  gaze: { scale: 1.3 },
  "voxel-bot": { backgroundColor: ["#00000000"], scale: 1.2 },
  moods: { backgroundColor: ["#00000000"], scale: 1.3 },
  pixelbot: { borderRadius: 24, scale: 1.3 },
  glass: { borderRadius: 24 },
  blobs: { borderRadius: 24 },
};

export function avatarRender(id: BotAvatarId): Render {
  return RENDER[id];
}

const uris = new Map<string, string>();

/**
 * The same seed always draws the same face, so a rendered one is kept. An
 * animated face carries the style's own motion (a glance, a blink, a sway),
 * which holds still for anyone who asked for reduced motion.
 */
export function avatarUri(id: BotAvatarId, style: Style<StyleDefinition>, seed: string, animated = false): string {
  const key = `${id}\n${seed}\n${animated}`;
  let uri = uris.get(key);
  if (!uri) {
    uri = new Avatar(style, { seed, ...RENDER[id], animationVariant: [animated ? "fast" : "none"] }).toDataUri();
    uris.set(key, uri);
  }
  return uri;
}
