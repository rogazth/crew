import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";

const VERSION = "11-zwj";
const BASE_VERSION = "11";
const ZERO_WIDTH_JOINER = 0x200d;

const width = (properties: number): 0 | 1 | 2 => ((properties >> 1) & 3) as 0 | 1 | 2;
const kind = (properties: number): number => properties >> 3;
const properties = (charKind: number, width: 0 | 1 | 2, join: boolean): number =>
  ((charKind & 0xffffff) << 3) | ((width & 3) << 1) | (join ? 1 : 0);

/**
 * Unicode 11 widths, except that a ZWJ emoji sequence occupies one wide cell
 * pair. CLIs budget it as a single glyph; stock Unicode11 advances for every
 * emoji in the sequence and the boxes agents draw drift right of their borders.
 */
export class ZwjUnicodeProvider implements IUnicodeVersionProvider {
  readonly version = VERSION;

  constructor(private readonly base: IUnicodeVersionProvider) {}

  wcwidth(codepoint: number): 0 | 1 | 2 {
    return this.base.wcwidth(codepoint);
  }

  charProperties(codepoint: number, preceding: number): number {
    const precedingWidth = width(preceding);
    if (codepoint === ZERO_WIDTH_JOINER && precedingWidth > 0) {
      return properties(ZERO_WIDTH_JOINER, precedingWidth, true);
    }
    if (kind(preceding) === ZERO_WIDTH_JOINER && precedingWidth > 0 && this.wcwidth(codepoint) > 0) {
      return properties(codepoint, precedingWidth, true);
    }
    return this.base.charProperties(codepoint, preceding);
  }
}

type Core = { _core?: { unicodeService?: { _providers?: Record<string, IUnicodeVersionProvider> } } };

/** Must run before the first write: widths already in the buffer are not recomputed. */
export function activateZwjUnicode(term: Terminal): void {
  const base = (term as Terminal & Core)._core?.unicodeService?._providers?.[BASE_VERSION];
  if (!base) {
    term.unicode.activeVersion = BASE_VERSION;
    return;
  }
  if (!term.unicode.versions.includes(VERSION)) term.unicode.register(new ZwjUnicodeProvider(base));
  term.unicode.activeVersion = VERSION;
}
