// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred, type Deferred } from "../test/deferred";
import { fake } from "../test/fakeClient";
import { act, renderHook } from "../test/renderHook";
import { useImageSrc } from "./useImageSrc";

vi.mock("../lib/client", async () => ({ client: (await import("../test/fakeClient")).fake.client }));

type Read = { mime: string; data: string };

// lib/attachments keeps a module-level cache of reads, so every test uses its own paths.
let run = 0;
const path = (name: string) => `/t${run}/${name}`;

/** Answers each read_file_base64 request with a gate the test opens, one per path. */
function gated() {
  const gates = new Map<string, Deferred<Read>>();
  const gate = (file: string) => {
    const found = gates.get(file) ?? deferred<Read>();
    gates.set(file, found);
    return found;
  };
  fake.respond("read_file_base64", (params) => gate(params.path as string).promise);
  return gate;
}

describe("useImageSrc", () => {
  beforeEach(() => {
    fake.reset();
    run += 1;
  });

  it("is null while the image loads, then its data URL", async () => {
    const shot = path("shot.png");
    const hook = renderHook(() => useImageSrc(shot));
    expect(hook.result.current).toBeNull();
    expect(fake.sent("read_file_base64")).toEqual([{ path: shot }]);
    await act(async () => fake.take("read_file_base64").resolve({ mime: "image/png", data: "iVBOR" }));
    expect(hook.result.current).toBe("data:image/png;base64,iVBOR");
    hook.unmount();
  });

  it("drops an image that lands after the path changed", async () => {
    const gate = gated();
    const [a, b] = [path("a.png"), path("b.jpg")];
    const hook = renderHook((p: string) => useImageSrc(p), a);
    hook.rerender(b);
    await act(async () => gate(a).resolve({ mime: "image/png", data: "AAAA" }));
    expect(hook.result.current).toBeNull();
    await act(async () => gate(b).resolve({ mime: "image/jpeg", data: "BBBB" }));
    expect(hook.result.current).toBe("data:image/jpeg;base64,BBBB");
    hook.unmount();
  });

  it("keeps the new image when the old one lands last", async () => {
    const gate = gated();
    const [a, b] = [path("a.png"), path("b.jpg")];
    const hook = renderHook((p: string) => useImageSrc(p), a);
    hook.rerender(b);
    await act(async () => gate(b).resolve({ mime: "image/jpeg", data: "BBBB" }));
    await act(async () => gate(a).resolve({ mime: "image/png", data: "AAAA" }));
    expect(hook.result.current).toBe("data:image/jpeg;base64,BBBB");
    hook.unmount();
  });

  it("never shows the previous image while the next one loads", async () => {
    const gate = gated();
    const [a, b] = [path("a.png"), path("b.png")];
    const hook = renderHook((p: string) => useImageSrc(p), a);
    await act(async () => gate(a).resolve({ mime: "image/png", data: "AAAA" }));
    hook.rerender(b);
    expect(hook.result.current).toBeNull();
    hook.unmount();
  });

  it("stays null when the file is gone", async () => {
    const hook = renderHook(() => useImageSrc(path("gone.png")));
    await act(async () => fake.take("read_file_base64").reject(new Error("ENOENT")));
    expect(hook.result.current).toBeNull();
    hook.unmount();
  });

  it("reads again on the next mount after a failure", async () => {
    const flaky = path("flaky.png");
    const first = renderHook(() => useImageSrc(flaky));
    await act(async () => fake.take("read_file_base64").reject(new Error("EBUSY")));
    first.unmount();

    const second = renderHook(() => useImageSrc(flaky));
    await act(async () => fake.take("read_file_base64").resolve({ mime: "image/png", data: "OK" }));
    expect(second.result.current).toBe("data:image/png;base64,OK");
    second.unmount();
  });

  it("serves an image it already read without reading it again", async () => {
    const shot = path("shot.png");
    fake.respond("read_file_base64", () => ({ mime: "image/png", data: "iVBOR" }));
    const first = renderHook(() => useImageSrc(shot));
    await act(async () => {});
    const second = renderHook(() => useImageSrc(shot));
    await act(async () => {});
    expect(second.result.current).toBe("data:image/png;base64,iVBOR");
    expect(fake.sent("read_file_base64")).toHaveLength(1);
    first.unmount();
    second.unmount();
  });

  it("drops an image that lands after unmount", async () => {
    const hook = renderHook(() => useImageSrc(path("late.png")));
    const request = fake.take("read_file_base64");
    hook.unmount();
    const renders = hook.renders();
    await act(async () => request.resolve({ mime: "image/png", data: "LATE" }));
    expect(hook.renders()).toBe(renders);
    expect(hook.result.current).toBeNull();
  });
});
