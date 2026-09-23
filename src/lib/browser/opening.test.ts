import { describe, expect, it } from "vitest";
import { RESTORE_PREFIX } from "./bridge";
import { openingSrc } from "./opening";

describe("openingSrc", () => {
  const restore = `${RESTORE_PREFIX}abc`;

  it("loads a restored stack when nothing was typed", () => {
    expect(openingSrc(restore, null)).toEqual({ src: restore, restoring: true });
    expect(openingSrc("https://example.com/", null)).toEqual({ src: "https://example.com/", restoring: false });
  });

  it("loads a URL typed during the wait instead of the stack", () => {
    expect(openingSrc(restore, "https://typed.example/")).toEqual({
      src: "https://typed.example/",
      restoring: false,
    });
    expect(openingSrc("https://restored.example/", "http://localhost:3000/")).toEqual({
      src: "http://localhost:3000/",
      restoring: false,
    });
  });

  it("ignores a queued value that is not a page, and a wait that found nothing", () => {
    expect(openingSrc(restore, "not a url")).toEqual({ src: restore, restoring: true });
    expect(openingSrc(null, null)).toEqual({ src: "about:blank", restoring: false });
    expect(openingSrc(null, "https://typed.example/")).toEqual({
      src: "https://typed.example/",
      restoring: false,
    });
  });
});
