import { SYSTEM_MONO } from "./terminalPrefs";

/** WebKit has no font enumeration, so candidates are probed one by one. */
const CANDIDATES = [
  "Menlo",
  "Monaco",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "IBM Plex Mono",
  "Geist Mono",
  "Berkeley Mono",
  "Hack",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "Iosevka",
  "Victor Mono",
  "Commit Mono",
  "MonoLisa",
  "Operator Mono",
  "Dank Mono",
  "Input Mono",
  "0xProto",
  "Maple Mono",
  "Monaspace Neon",
  "DejaVu Sans Mono",
  "PT Mono",
  "Andale Mono",
  "Courier New",
];

const SAMPLE = "mmmmmmmmmmlliWW@";

/** A font is present when text measures differently than with both generic fallbacks. */
export function installedMonoFonts(): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [SYSTEM_MONO];
  const width = (font: string) => {
    ctx.font = `72px ${font}`;
    return ctx.measureText(SAMPLE).width;
  };
  const mono = width("monospace");
  const serif = width("serif");
  const found = CANDIDATES.filter((name) => {
    const asMono = width(`"${name}", monospace`);
    const asSerif = width(`"${name}", serif`);
    return asMono !== mono || asSerif !== serif;
  });
  return [SYSTEM_MONO, ...found];
}
