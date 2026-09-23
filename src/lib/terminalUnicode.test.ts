import { Unicode11Addon } from "@xterm/addon-unicode11";
import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { ZwjUnicodeProvider, activateZwjUnicode } from "./terminalUnicode";

/** The real Unicode 11 widths, taken from the addon the terminal loads. */
function unicode11(): IUnicodeVersionProvider {
  let provider: IUnicodeVersionProvider | undefined;
  new Unicode11Addon().activate({
    unicode: { register: (p: IUnicodeVersionProvider) => (provider = p) },
  } as unknown as Terminal);
  if (!provider) throw new Error("the addon registered nothing");
  return provider;
}

/** The cells a string advances, the way xterm's UnicodeService sums them. */
function cells(provider: IUnicodeVersionProvider, text: string): number {
  let total = 0;
  let preceding = 0;
  for (const char of text) {
    const current = provider.charProperties(char.codePointAt(0)!, preceding);
    let width = (current >> 1) & 3;
    if (current & 1) width -= (preceding >> 1) & 3;
    total += width;
    preceding = current;
  }
  return total;
}

const FAMILY = "👨\u200d👩\u200d👧";

describe("ZwjUnicodeProvider", () => {
  it("fits a ZWJ emoji sequence in one wide cell pair", () => {
    const base = unicode11();
    expect(cells(base, FAMILY)).toBe(6);
    expect(cells(new ZwjUnicodeProvider(base), FAMILY)).toBe(2);
    expect(cells(new ZwjUnicodeProvider(base), `[${FAMILY}]`)).toBe(4);
  });

  it("measures plain text, wide CJK and lone emoji exactly as Unicode 11 does", () => {
    const base = unicode11();
    const zwj = new ZwjUnicodeProvider(base);
    for (const text of ["hello", "日本語", "👍 ok", "e\u0301"]) {
      expect(cells(zwj, text)).toBe(cells(base, text));
    }
  });

  it("does not join after a ZWJ that follows nothing", () => {
    const zwj = new ZwjUnicodeProvider(unicode11());
    expect(cells(zwj, "\u200d👩")).toBe(2);
  });

  it("keeps a zero-width mark after a ZWJ at Unicode 11 widths", () => {
    const base = unicode11();
    expect(cells(new ZwjUnicodeProvider(base), "👩\u200d\u0301")).toBe(cells(base, "👩\u200d\u0301"));
  });

  it("names its version and defers wcwidth to the base", () => {
    const base = unicode11();
    const zwj = new ZwjUnicodeProvider(base);
    expect(zwj.version).toBe("11-zwj");
    expect(zwj.wcwidth(0x1f468)).toBe(base.wcwidth(0x1f468));
    expect(zwj.wcwidth(0x61)).toBe(1);
  });
});

type FakeTerm = {
  unicode: { activeVersion: string; versions: string[]; register: ReturnType<typeof vi.fn> };
  _core?: { unicodeService?: { _providers?: Record<string, IUnicodeVersionProvider> } };
};

function term(providers?: Record<string, IUnicodeVersionProvider>): FakeTerm {
  const unicode = {
    activeVersion: "6",
    versions: ["6", ...Object.keys(providers ?? {})],
    register: vi.fn((provider: IUnicodeVersionProvider) => unicode.versions.push(provider.version)),
  };
  return providers ? { unicode, _core: { unicodeService: { _providers: providers } } } : { unicode };
}

describe("activateZwjUnicode", () => {
  it("registers the ZWJ provider over Unicode 11 and makes it active", () => {
    const base = unicode11();
    const fake = term({ "11": base });
    activateZwjUnicode(fake as unknown as Terminal);
    expect(fake.unicode.activeVersion).toBe("11-zwj");
    const registered = fake.unicode.register.mock.calls[0]?.[0] as IUnicodeVersionProvider;
    expect(registered).toBeInstanceOf(ZwjUnicodeProvider);
    expect(cells(registered, FAMILY)).toBe(2);
  });

  it("registers only once per terminal", () => {
    const fake = term({ "11": unicode11() });
    activateZwjUnicode(fake as unknown as Terminal);
    activateZwjUnicode(fake as unknown as Terminal);
    expect(fake.unicode.register).toHaveBeenCalledTimes(1);
    expect(fake.unicode.activeVersion).toBe("11-zwj");
  });

  it("falls back to plain Unicode 11 when xterm's internals are not where it expects", () => {
    for (const fake of [term(), term({})]) {
      activateZwjUnicode(fake as unknown as Terminal);
      expect(fake.unicode.register).not.toHaveBeenCalled();
      expect(fake.unicode.activeVersion).toBe("11");
    }
  });
});
