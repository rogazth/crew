import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("./client", () => ({ client: { request: (...args: unknown[]) => request(...args) } }));

import { CHUNK, fileSource, upload } from "./upload";

describe("upload", () => {
  beforeEach(() => {
    request.mockReset();
  });

  it("sends a big file in small pieces, in order, and reports how far it got", async () => {
    request.mockImplementation(async () => "/tmp/crew/x.psd");
    const file = new File([new Uint8Array(CHUNK * 2 + 1000)], "banner.psd");
    const seen: number[] = [];
    const path = await upload(fileSource(file), "devbox", "psd", (sent) => seen.push(sent));
    expect(path).toBe("/tmp/crew/x.psd");
    expect(request.mock.calls.map((call) => (call[1] as { offset: number }).offset)).toEqual([0, CHUNK, CHUNK * 2]);
    expect(request.mock.calls.every((call) => call[0] === "upload_chunk" && call[2] === "devbox")).toBe(true);
    expect(seen).toEqual([CHUNK, CHUNK * 2, CHUNK * 2 + 1000]);
    const ids = new Set(request.mock.calls.map((call) => (call[1] as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("stops at the first piece the machine refuses", async () => {
    request.mockRejectedValueOnce(new Error("Unknown method: upload_chunk"));
    const file = new File([new Uint8Array(CHUNK * 2)], "banner.psd");
    await expect(upload(fileSource(file), "devbox", "psd")).rejects.toThrow("Unknown method");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stops at once when cancelled, without waiting for the piece in flight", async () => {
    request.mockImplementation(() => new Promise(() => {}));
    const file = new File([new Uint8Array(CHUNK * 3)], "banner.psd");
    const controller = new AbortController();
    const sending = upload(fileSource(file), "devbox", "psd", undefined, controller.signal);
    const cancelled = expect(sending).rejects.toThrow("Cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("Cancelled"));
    await cancelled;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("sends a piece again when the link drops under it", async () => {
    vi.useFakeTimers();
    const down = Object.assign(new Error("That machine is offline"), { name: "EnvDown" });
    request.mockRejectedValueOnce(down).mockResolvedValue("/tmp/crew/x.txt");
    const sending = upload(fileSource(new File([new Uint8Array(10)], "a.txt")), "devbox", "txt");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(sending).resolves.toBe("/tmp/crew/x.txt");
    expect(request).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("asks only for the path when the dropped piece had landed after all", async () => {
    vi.useFakeTimers();
    const down = Object.assign(new Error("That machine is offline"), { name: "EnvDown" });
    request
      .mockRejectedValueOnce(down)
      .mockRejectedValueOnce(new Error("Upload is out of order: 10 bytes arrived, the next piece starts at 0"))
      .mockResolvedValue("/tmp/crew/x.txt");
    const sending = upload(fileSource(new File([new Uint8Array(10)], "a.txt")), "devbox", "txt");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(sending).resolves.toBe("/tmp/crew/x.txt");
    const last = request.mock.calls.at(-1)?.[1] as { offset: number; base64Contents: string };
    expect(last.offset).toBe(10);
    expect(last.base64Contents).toBe("");
    vi.useRealTimers();
  });

  it("gives up on a piece the machine keeps dropping", async () => {
    vi.useFakeTimers();
    request.mockImplementation(async () => {
      throw Object.assign(new Error("That machine is offline"), { name: "EnvDown" });
    });
    const sending = upload(fileSource(new File([new Uint8Array(10)], "a.txt")), "devbox", "txt");
    const failed = expect(sending).rejects.toThrow("offline");
    await vi.advanceTimersByTimeAsync(20_000);
    await failed;
    expect(request).toHaveBeenCalledTimes(5);
    vi.useRealTimers();
  });

  it("sends nothing when it is cancelled before it starts", async () => {
    const file = new File([new Uint8Array(10)], "a.txt");
    await expect(upload(fileSource(file), "devbox", "txt", undefined, AbortSignal.abort())).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
