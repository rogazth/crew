/**
 * Deterministic identity for an agent, so the same name always draws the same
 * face. Prototypes may render this themselves or feed the seed to a library
 * (`boring-avatars`, `@dicebear/core`, `minidenticons`) — the seed is the contract.
 */

export function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** A small deterministic PRNG, so a seed can drive several independent choices. */
export function seededRandom(seed: string): () => number {
  let state = hashSeed(seed) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

export type Identity = {
  seed: string;
  /** 0-359. Stable per seed. */
  hue: number;
  /** Two more hues a third of the wheel away, for multi-tone marks. */
  hues: [number, number, number];
  /** One or two letters. */
  initials: string;
  /** Which of a set of shapes this agent wears. */
  shape: number;
  /** Four normalised values a generator can use for placement. */
  jitter: [number, number, number, number];
};

const STOP_WORDS = /^(the|a|an|de|la|el)$/i;

function initialsOf(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.test(w));
  if (words.length === 0) return name.slice(0, 2).toUpperCase();
  if (words.length === 1) {
    const w = words[0]!;
    // camelCase or PascalCase: take the case boundary.
    const caps = w.match(/[A-Z]/g);
    if (caps && caps.length >= 2) return `${caps[0]}${caps[1]}`.toUpperCase();
    return w.slice(0, 2).toUpperCase();
  }
  return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
}

export function identityFor(seed: string): Identity {
  const rnd = seededRandom(seed);
  const hue = Math.floor(rnd() * 360);
  return {
    seed,
    hue,
    hues: [hue, (hue + 120 + Math.floor(rnd() * 40)) % 360, (hue + 240 + Math.floor(rnd() * 40)) % 360],
    initials: initialsOf(seed),
    shape: Math.floor(rnd() * 8),
    jitter: [rnd(), rnd(), rnd(), rnd()],
  };
}

/**
 * A ready-to-use inline SVG, for prototypes that do not want to pull a library.
 * Two overlapping blobs plus a dot: reads as a face at 16px and as a mark at 64.
 */
export function avatarSvg(seed: string, size = 32): string {
  const it = identityFor(seed);
  const [h1, h2] = it.hues;
  const bg = `oklch(0.72 0.14 ${h1})`;
  const fg = `oklch(0.52 0.16 ${h2})`;
  const cx = 12 + it.jitter[0] * 8;
  const cy = 12 + it.jitter[1] * 8;
  const r = 9 + it.jitter[2] * 7;
  const eye = 0.9 + it.jitter[3] * 0.8;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32" role="img" aria-label="${seed}">`,
    `<rect width="32" height="32" rx="16" fill="${bg}"/>`,
    `<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="${r.toFixed(2)}" fill="${fg}" opacity="0.55"/>`,
    `<circle cx="12" cy="14" r="${eye.toFixed(2)}" fill="oklch(0.22 0.02 ${h1})"/>`,
    `<circle cx="20" cy="14" r="${eye.toFixed(2)}" fill="oklch(0.22 0.02 ${h1})"/>`,
    `</svg>`,
  ].join("");
}

export function avatarDataUri(seed: string, size = 32): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(avatarSvg(seed, size))}`;
}
