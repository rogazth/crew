import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | ArrayBuffer) {
    if (typeof data === "string") this.sent.push(data);
  }
}

describe("transport connect", () => {
  beforeEach(() => {
    vi.resetModules();
    invoke.mockReset();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  it("retries after a rejected daemon_info", async () => {
    invoke.mockRejectedValueOnce(new Error("not ready"));
    invoke.mockResolvedValue({ url: "ws://127.0.0.1:9", token: "tok" });
    const { transport } = await import("./transport");
    await expect(transport.request("state_get", { key: "x" })).rejects.toThrow("not ready");

    const pending = transport.request<string>("state_get", { key: "x" });
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const ws = FakeSocket.instances[0];
    expect(ws).toBeTruthy();
    ws!.readyState = FakeSocket.OPEN;
    ws!.onopen?.();
    await vi.waitFor(() => expect(ws!.sent.length).toBe(2));
    const req = JSON.parse(ws!.sent[1] ?? "{}") as { id: number };
    ws!.onmessage?.({ data: JSON.stringify({ id: req.id, ok: true, result: "ok" }) });
    await expect(pending).resolves.toBe("ok");
  });
});
