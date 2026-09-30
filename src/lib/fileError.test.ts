import { describe, expect, it } from "vitest";
import { describeFileError } from "./fileError";

describe("describeFileError", () => {
  it("names a folder as one", () => {
    const problem = describeFileError("Is a directory (os error 21)", "experiments");
    expect(problem.title).toBe("experiments is a folder.");
    expect(problem.openable).toBe(false);
  });

  it("tells a missing file from an unreadable one", () => {
    expect(describeFileError("No such file or directory (os error 2)", "a.ts").title).toBe("a.ts isn't there anymore.");
    expect(describeFileError("Permission denied (os error 13)", "a.ts").title).toBe("Crew can't read a.ts.");
  });

  it("offers another app for binary and oversized files", () => {
    expect(describeFileError("stream did not contain valid UTF-8", "a.bin").openable).toBe(true);
    expect(describeFileError("File is too large to open", "a.log").openable).toBe(true);
  });

  it("keeps the daemon's words for anything else", () => {
    expect(describeFileError("Input/output error (os error 5)", "a.ts").detail).toBe("Input/output error (os error 5)");
  });
});
