import { describe, expect, it } from "vitest";
import { AGENT_AVATARS, avatarRender } from "./agentAvatar";

describe("avatarRender", () => {
  it("drops the square behind figures and rounds the styles that are a square", () => {
    expect(avatarRender("voxel-bot").backgroundColor).toEqual(["#00000000"]);
    expect(avatarRender("moods").backgroundColor).toEqual(["#00000000"]);
    for (const id of ["pixelbot", "bottts-neutral", "glass", "blobs"] as const) {
      expect(avatarRender(id).borderRadius).toBeGreaterThan(0);
    }
  });

  it("has an answer for every style", () => {
    for (const { id } of AGENT_AVATARS) expect(avatarRender(id)).toBeDefined();
  });
});
