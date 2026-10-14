import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();
vi.mock("./client", () => ({ client: { request: (...args: unknown[]) => request(...args) } }));

import { fileSource, upload } from "./upload";

describe("upload", () => {
  beforeEach(() => request.mockReset());

  it("sends a big file in 4 MB pieces, in order, and reports how far it got", async () => {
    request.mockImplementation(async () => "/tmp/crew/x.psd");
    const file = new File([new Uint8Array(9 * 1024 * 1024)], "banner.psd");
    const seen: number[] = [];
    const path = await upload(fileSource(file), "devbox", "psd", (sent) => seen.push(sent));
    expect(path).toBe("/tmp/crew/x.psd");
    expect(request.mock.calls.map((call) => (call[1] as { offset: number }).offset)).toEqual([0, 4194304, 8388608]);
    expect(request.mock.calls.every((call) => call[0] === "upload_chunk" && call[2] === "devbox")).toBe(true);
    expect(seen).toEqual([4194304, 8388608, 9437184]);
    const ids = new Set(request.mock.calls.map((call) => (call[1] as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("stops at the first piece the machine refuses", async () => {
    request.mockRejectedValueOnce(new Error("Unknown method: upload_chunk"));
    const file = new File([new Uint8Array(9 * 1024 * 1024)], "banner.psd");
    await expect(upload(fileSource(file), "devbox", "psd")).rejects.toThrow("Unknown method");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
