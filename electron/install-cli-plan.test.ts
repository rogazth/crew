import { describe, expect, it } from "vitest";
import { adminScript, chooseDir, classify, onPath, parseMarkedPath, shellQuote, SYSTEM_BIN } from "./install-cli-plan";

describe("parseMarkedPath", () => {
  it("skips whatever the rc files printed", () => {
    expect(parseMarkedPath("Using node 22\n__CREW_PATH__/a:/b:__CREW_PATH__\nbye")).toEqual(["/a", "/b"]);
  });

  it("gives up without both markers or with an empty PATH", () => {
    expect(parseMarkedPath("no markers")).toBeNull();
    expect(parseMarkedPath("__CREW_PATH__/a")).toBeNull();
    expect(parseMarkedPath("__CREW_PATH____CREW_PATH__")).toBeNull();
  });
});

describe("chooseDir", () => {
  it("links into ~/.local/bin when the shell looks there", () => {
    expect(chooseDir(["/usr/bin", "/Users/me/.local/bin/"], "/Users/me")).toBe("/Users/me/.local/bin");
  });

  it("falls back to /usr/local/bin", () => {
    expect(chooseDir(["/usr/bin", "/opt/homebrew/bin"], "/Users/me")).toBe(SYSTEM_BIN);
    expect(onPath(["/usr/local/bin/"], SYSTEM_BIN)).toBe(true);
  });
});

describe("adminScript", () => {
  it("quotes paths with spaces and quotes for the shell and for AppleScript", () => {
    const script = adminScript("/Applications/Crew \"β\".app/Contents/Resources/crew", "/usr/local/bin/crew");
    expect(script).toBe(
      `do shell script "mkdir -p '/usr/local/bin' && ln -sfn '/Applications/Crew \\"β\\".app/Contents/Resources/crew' '/usr/local/bin/crew'" with administrator privileges`,
    );
  });

  it("closes a single quote the shell way", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe("classify", () => {
  const source = "/Applications/Crew.app/Contents/Resources/crew";

  it("tells Crew's own link from the user's file", () => {
    expect(classify(null, source)).toBe("none");
    expect(classify({ isSymbolicLink: true, target: source }, source)).toBe("ours");
    expect(classify({ isSymbolicLink: true, target: "/elsewhere/crew" }, source)).toBe("other-link");
    expect(classify({ isSymbolicLink: false, target: null }, source)).toBe("file");
  });
});
