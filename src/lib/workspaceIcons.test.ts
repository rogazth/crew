import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceIcon } from "./protocol";

const asked: { id: string; opts: object }[] = [];
let answer: WorkspaceIcon;
vi.mock("./api", () => ({
  getWorkspaceIcon: async (id: string, opts: object) => {
    asked.push({ id, opts });
    return answer;
  },
  setWorkspaceIcon: async (_id: string, choice: { choice: WorkspaceIcon["choice"] }) => {
    if (choice.choice === "repo") throw new Error("Pick an image in the repo");
    return { ...answer, choice: choice.choice, image: null };
  },
}));

const { choose, iconOf, imageOf, mimeOf, pick, problemOf, refresh, resetWorkspaceIcons, sameIcon, snapshot, splitDataUrl } = await import(
  "./workspaceIcons"
);

const icon = (patch: Partial<WorkspaceIcon> = {}): WorkspaceIcon => ({
  choice: "auto",
  path: null,
  image: "data:image/png;base64,AAA",
  found: [],
  uploaded: null,
  ...patch,
});

describe("workspaceIcons", () => {
  beforeEach(() => {
    asked.length = 0;
    resetWorkspaceIcons();
    answer = icon();
  });

  it("keeps what the daemon shows, and asks once for the same question", async () => {
    expect(imageOf("w")).toBeNull();
    await Promise.all([refresh("w"), refresh("w"), refresh("w", { look: true })]);
    expect(asked).toEqual([
      { id: "w", opts: {} },
      { id: "w", opts: { look: true } },
    ]);
    expect(imageOf("w")).toBe("data:image/png;base64,AAA");
  });

  it("draws nothing again for the same answer", async () => {
    await refresh("w");
    const before = snapshot();
    await refresh("w");
    expect(snapshot()).toBe(before);
    answer = icon({ image: "data:image/png;base64,BBB" });
    await refresh("w");
    expect(snapshot()).toBe(before + 1);
  });

  it("keeps the choices the settings read when the rail asks without them", async () => {
    answer = icon({ found: [{ path: "public/logo.png", image: "data:x" }], uploaded: "data:y" });
    await refresh("w", { choices: true });
    answer = icon();
    await refresh("w");
    expect(iconOf("w")?.found.map((file) => file.path)).toEqual(["public/logo.png"]);
    expect(iconOf("w")?.uploaded).toBe("data:y");
  });

  it("takes the daemon's answer to a choice", async () => {
    await refresh("w");
    await choose("w", { choice: "initials" });
    expect(iconOf("w")?.choice).toBe("initials");
    expect(imageOf("w")).toBeNull();
  });

  it("says what went wrong with a pick until the next one", async () => {
    await pick("w", { choice: "repo", path: "../x.png" });
    expect(problemOf("w")).toBe("Pick an image in the repo");
    await pick("w", { choice: "initials" });
    expect(problemOf("w")).toBeNull();
    await pick("w", async () => {
      throw new Error("The image is over 2 MB");
    });
    expect(problemOf("w")).toBe("The image is over 2 MB");
  });

  it("compares answers by what they show", () => {
    expect(sameIcon(icon(), icon())).toBe(true);
    expect(sameIcon(icon(), icon({ choice: "repo" }))).toBe(false);
    expect(sameIcon(icon({ found: [{ path: "a", image: "x" }] }), icon({ found: [{ path: "a", image: "y" }] }))).toBe(false);
  });

  it("types a file by its name when the browser does not", () => {
    expect(mimeOf({ name: "favicon.ico", type: "" })).toBe("image/x-icon");
    expect(mimeOf({ name: "Logo.SVG", type: "" })).toBe("image/svg+xml");
    expect(mimeOf({ name: "a.png", type: "image/png" })).toBe("image/png");
    expect(mimeOf({ name: "notes.txt", type: "" })).toBe("");
  });

  it("takes the bytes out of a data URL", () => {
    expect(splitDataUrl("data:image/png;base64,iVBOR", "image/png")).toEqual({ mime: "image/png", data: "iVBOR" });
    expect(splitDataUrl("data:image/svg+xml,<svg/>", "image/svg+xml")).toBeNull();
  });
});
