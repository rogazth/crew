import { describe, expect, it } from "vitest";
import { commandBoxes, langOf } from "./toolBody";

describe("langOf", () => {
  it("takes the leaf's extension as it is written", () => {
    expect(langOf("/w/src/App.TSX")).toBe("TSX");
    expect(langOf("Makefile.am")).toBe("am");
  });

  it("has none for dotfiles and bare names", () => {
    expect(langOf("/w/.env")).toBeUndefined();
    expect(langOf("/w/Makefile")).toBeUndefined();
    expect(langOf("")).toBeUndefined();
  });
});

describe("commandBoxes", () => {
  it("shows a one-line command only as its output", () => {
    expect(commandBoxes({ kind: "command", command: "ls", output: "a\nb\n" })).toEqual({
      command: null,
      output: { head: "output", text: "a\nb\n", danger: false },
    });
  });

  it("shows a multi-line command in its own box", () => {
    const command = "cat <<EOF\nhi\nEOF";
    expect(commandBoxes({ kind: "command", command, exitCode: 0 })).toEqual({
      command: { head: "command", text: command, danger: false },
      output: null,
    });
  });

  it("heads the output with the exit code and marks a failure", () => {
    expect(commandBoxes({ kind: "command", command: "x", exitCode: 0, output: "ok" }).output).toEqual({
      head: "exit 0",
      text: "ok",
      danger: false,
    });
    expect(commandBoxes({ kind: "command", command: "x", exitCode: 2, output: "boom" }).output).toEqual({
      head: "exit 2",
      text: "boom",
      danger: true,
    });
  });

  it("drops output that is only whitespace", () => {
    expect(commandBoxes({ kind: "command", command: "true", exitCode: 1, output: " \n" }).output).toBeNull();
  });
});
