// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachedFile } from "../../lib/blocks";
import { click, mount, only, press, type Mounted } from "../../test/dom";
import { fake } from "../../test/fakeClient";
import { AttachmentStrip } from "./Attachments";

vi.mock("../../lib/client", async () => ({ client: (await import("../../test/fakeClient")).fake.client }));
vi.mock("@phosphor-icons/react", () => {
  const glyph = () => null;
  return new Proxy({}, { has: (_, key) => key !== "then", get: (_, key) => (key === "then" ? undefined : glyph) });
});

const A: AttachedFile = { name: "a.png", path: "/t/a.png", kind: "image" };
const B: AttachedFile = { name: "b.jpg", path: "/t/b.jpg", kind: "image" };
const C: AttachedFile = { name: "c.png", path: "/t/c.png", kind: "image" };
const NOTES: AttachedFile = { name: "notes.md", path: "/t/notes.md", kind: "file", size: 2048 };

let view: Mounted | null = null;
const onRemove = vi.fn<(path: string) => void>();

function render(files: AttachedFile[], removable = true) {
  view = mount(<AttachmentStrip files={files} {...(removable ? { onRemove } : {})} />);
}

/** The image the viewer shows, by its accessible name. */
const showing = () => document.querySelector('[role="dialog"]')?.getAttribute("aria-label") ?? null;

beforeEach(() => {
  fake.reset();
  onRemove.mockClear();
});
afterEach(() => {
  view?.unmount();
  view = null;
});

describe("removing", () => {
  it("removes an image or a file by its path", () => {
    render([A, NOTES]);
    click(only(view!.container, 'button[aria-label="Remove a.png"]'));
    click(only(view!.container, 'button[aria-label="Remove notes.md"]'));
    expect(onRemove.mock.calls).toEqual([["/t/a.png"], ["/t/notes.md"]]);
  });

  it("offers no removal on a sent turn", () => {
    render([A, NOTES], false);
    expect(view!.container.querySelectorAll('button[aria-label^="Remove"]')).toHaveLength(0);
  });
});

describe("viewer", () => {
  it("opens on the clicked image and walks the strip both ways, wrapping", () => {
    render([A, NOTES, B, C], false);
    click(only(view!.container, 'button[aria-label="Open b.jpg"]'));
    expect(showing()).toBe("b.jpg");
    click(only(document.body, 'button[aria-label="Next"]'));
    expect(showing()).toBe("c.png");
    click(only(document.body, 'button[aria-label="Next"]'));
    expect(showing()).toBe("a.png");
    click(only(document.body, 'button[aria-label="Previous"]'));
    expect(showing()).toBe("c.png");
  });

  it("walks with the arrow keys", () => {
    render([A, B], false);
    click(only(view!.container, 'button[aria-label="Open a.png"]'));
    press(document.body, "ArrowRight");
    expect(showing()).toBe("b.jpg");
    press(document.body, "ArrowLeft");
    press(document.body, "ArrowLeft");
    expect(showing()).toBe("b.jpg");
    press(document.body, "ArrowUp");
    expect(showing()).toBe("b.jpg");
  });

  it("has nowhere to walk with one image", () => {
    render([A], false);
    click(only(view!.container, 'button[aria-label="Open a.png"]'));
    press(document.body, "ArrowRight");
    expect(showing()).toBe("a.png");
    expect(document.querySelector('button[aria-label="Next"]')).toBeNull();
  });
});
