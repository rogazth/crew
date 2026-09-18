import { identityFor, type Identity } from "@crew/fixtures";

/**
 * Agent colour is generated, never chosen: `identityFor(name).hue` is the only
 * input, so a twelve-agent workspace stays readable without anyone picking
 * twelve swatches by hand.
 *
 * Every derivation is cached per seed. At four hundred sessions the sidebar
 * asks for the same handful of identities on every paint, and the hash plus the
 * PRNG behind `identityFor` is the one thing here that is not free.
 */
const identities = new Map<string, Identity>();

export function identity(seed: string): Identity {
  let held = identities.get(seed);
  if (!held) {
    held = identityFor(seed);
    identities.set(seed, held);
  }
  return held;
}

export const agentHue = (seed: string): number => identity(seed).hue;

const tints = new Map<string, string>();

export function agentTint(seed: string, dark: boolean): string {
  const key = `${dark ? "d" : "l"}:${seed}`;
  let held = tints.get(key);
  if (!held) {
    const h = agentHue(seed);
    held = dark ? `oklch(0.74 0.13 ${h})` : `oklch(0.58 0.15 ${h})`;
    tints.set(key, held);
  }
  return held;
}

export function agentWash(seed: string, dark: boolean): string {
  const h = agentHue(seed);
  return dark ? `oklch(0.74 0.13 ${h} / 0.14)` : `oklch(0.58 0.15 ${h} / 0.1)`;
}

const palettes = new Map<string, string[]>();

/**
 * The five fills a generated avatar draws with. Two ramps, because a mark tuned
 * for a white page turns to mud on a dark one.
 */
export function avatarPalette(seed: string, dark: boolean): string[] {
  const key = `${dark ? "d" : "l"}:${seed}`;
  let held = palettes.get(key);
  if (!held) {
    const [h1, h2, h3] = identity(seed).hues;
    held = dark
      ? [
          `oklch(0.36 0.09 ${h1})`,
          `oklch(0.78 0.13 ${h2})`,
          `oklch(0.6 0.15 ${h1})`,
          `oklch(0.88 0.09 ${h3})`,
          `oklch(0.48 0.13 ${h3})`,
        ]
      : [
          `oklch(0.88 0.08 ${h1})`,
          `oklch(0.56 0.16 ${h2})`,
          `oklch(0.72 0.15 ${h1})`,
          `oklch(0.95 0.04 ${h3})`,
          `oklch(0.45 0.14 ${h3})`,
        ];
    palettes.set(key, held);
  }
  return held;
}
