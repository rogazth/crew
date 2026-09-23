import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachedFile } from "./blocks";

// Hoisted so every fresh copy of the module under test (vi.resetModules) talks to this one fake.
const { fake } = await vi.hoisted(() => import("../test/fakeClient"));
vi.mock("./client", () => ({ client: fake.client }));

async function load() {
  return import("./attachments");
}

const file = (name: string, over: Partial<AttachedFile> = {}): AttachedFile => ({ name, path: `/tmp/${name}`, ...over });

beforeEach(() => {
  fake.reset();
  vi.resetModules();
});

describe("extensionOf", () => {
  it("is the lowercased text after the last dot", async () => {
    const { extensionOf } = await load();
    expect(extensionOf("shot.PNG")).toBe("png");
    expect(extensionOf("archive.tar.gz")).toBe("gz");
  });

  it("is empty for a name without one, or a dotfile", async () => {
    const { extensionOf } = await load();
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".bashrc")).toBe("");
    expect(extensionOf("")).toBe("");
  });
});

describe("imageMime", () => {
  it("knows the image types Claude takes inline", async () => {
    const { imageMime } = await load();
    expect(["a.png", "a.jpg", "a.JPEG", "a.gif", "a.webp"].map(imageMime)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/gif",
      "image/webp",
    ]);
  });

  it("gives null for anything else, images included", async () => {
    const { imageMime } = await load();
    expect(imageMime("a.svg")).toBeNull();
    expect(imageMime("a.heic")).toBeNull();
    expect(imageMime("notes.txt")).toBeNull();
    expect(imageMime("png")).toBeNull();
  });
});

describe("isImage", () => {
  it("trusts an explicit kind over the name", async () => {
    const { isImage } = await load();
    expect(isImage(file("clipboard", { kind: "image" }))).toBe(true);
    expect(isImage(file("shot.png", { kind: "file" }))).toBe(false);
  });

  it("goes by the name when the kind is unknown", async () => {
    const { isImage } = await load();
    expect(isImage(file("shot.png"))).toBe(true);
    expect(isImage(file("notes.md"))).toBe(false);
  });
});

describe("attachedFrom", () => {
  it("names the file after the last path segment and sets its kind", async () => {
    const { attachedFrom } = await load();
    expect(attachedFrom("/Users/me/shot.png")).toEqual({ name: "shot.png", path: "/Users/me/shot.png", kind: "image" });
    expect(attachedFrom("/Users/me/notes.md")).toEqual({ name: "notes.md", path: "/Users/me/notes.md", kind: "file" });
    expect(attachedFrom("bare.txt")).toEqual({ name: "bare.txt", path: "bare.txt", kind: "file" });
  });

  it("carries the size only when it is known, zero included", async () => {
    const { attachedFrom } = await load();
    expect(attachedFrom("/a/b.txt", 2048)).toEqual({ name: "b.txt", path: "/a/b.txt", kind: "file", size: 2048 });
    expect(attachedFrom("/a/b.txt", 0).size).toBe(0);
    expect(attachedFrom("/a/b.txt")).not.toHaveProperty("size");
  });
});

describe("loadInlineImages", () => {
  it("reads only the images, in order, as base64 with their media type", async () => {
    fake.respond("read_file_base64", ({ path }) => ({ mime: "ignored", data: `b64:${path as string}` }));
    const { loadInlineImages } = await load();
    const images = await loadInlineImages([
      file("a.png"),
      file("notes.md"),
      file("b.JPG"),
      file("c.svg", { kind: "image" }),
      file("d.gif", { kind: "file" }),
    ]);
    expect(images).toEqual([
      { path: "/tmp/a.png", mediaType: "image/png", data: "b64:/tmp/a.png" },
      { path: "/tmp/b.JPG", mediaType: "image/jpeg", data: "b64:/tmp/b.JPG" },
    ]);
    expect(fake.sent("read_file_base64")).toEqual([{ path: "/tmp/a.png" }, { path: "/tmp/b.JPG" }]);
  });

  it("leaves out an image it cannot read, so it travels as a path instead", async () => {
    fake.respond("read_file_base64", ({ path }) => {
      if (path === "/tmp/gone.png") throw new Error("ENOENT");
      return { mime: "image/png", data: "ok" };
    });
    const { loadInlineImages } = await load();
    expect(await loadInlineImages([file("gone.png"), file("here.png")])).toEqual([
      { path: "/tmp/here.png", mediaType: "image/png", data: "ok" },
    ]);
  });

  it("reads nothing when nothing is an image", async () => {
    const { loadInlineImages } = await load();
    expect(await loadInlineImages([])).toEqual([]);
    expect(await loadInlineImages([file("a.txt")])).toEqual([]);
    expect(fake.sent("read_file_base64")).toEqual([]);
  });
});

describe("imageSrc", () => {
  it("builds a data URL from the file's mime and bytes", async () => {
    fake.respond("read_file_base64", () => ({ mime: "image/webp", data: "AAAA" }));
    const { imageSrc } = await load();
    expect(await imageSrc("/tmp/a.webp")).toBe("data:image/webp;base64,AAAA");
  });

  it("reads each path once while it stays warm", async () => {
    fake.respond("read_file_base64", () => ({ mime: "image/png", data: "AAAA" }));
    const { imageSrc } = await load();
    const [first, second] = await Promise.all([imageSrc("/tmp/a.png"), imageSrc("/tmp/a.png")]);
    await imageSrc("/tmp/a.png");
    expect(first).toBe(second);
    expect(fake.sent("read_file_base64")).toHaveLength(1);
  });

  it("forgets a failed read so the next request tries again", async () => {
    const { imageSrc } = await load();
    const failing = imageSrc("/tmp/a.png");
    fake.take("read_file_base64").reject(new Error("busy"));
    await expect(failing).rejects.toThrow("busy");
    const retry = imageSrc("/tmp/a.png");
    fake.take("read_file_base64").resolve({ mime: "image/png", data: "BBBB" });
    expect(await retry).toBe("data:image/png;base64,BBBB");
  });

  it("keeps only the 64 most recent paths warm", async () => {
    fake.respond("read_file_base64", () => ({ mime: "image/png", data: "AAAA" }));
    const { imageSrc } = await load();
    for (let i = 0; i <= 64; i++) await imageSrc(`/tmp/${i}.png`);
    expect(fake.sent("read_file_base64")).toHaveLength(65);
    await imageSrc("/tmp/64.png");
    await imageSrc("/tmp/1.png");
    expect(fake.sent("read_file_base64")).toHaveLength(65);
    await imageSrc("/tmp/0.png");
    expect(fake.sent("read_file_base64")).toHaveLength(66);
  });
});

describe("formatBytes", () => {
  it("shows bytes under a kilobyte", async () => {
    const { formatBytes } = await load();
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("shows one decimal under 10 KB and whole kilobytes above", async () => {
    const { formatBytes } = await load();
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(10 * 1024 - 1)).toBe("10.0 KB");
    expect(formatBytes(10 * 1024)).toBe("10 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("shows megabytes with one decimal", async () => {
    const { formatBytes } = await load();
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5.25 * 1024 * 1024)).toBe("5.3 MB");
  });
});
