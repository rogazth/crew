import { beforeEach, describe, expect, it, vi } from "vitest";

const daemonInfo = vi.fn();
vi.mock("../host", () => ({ daemonInfo }));

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
    daemonInfo.mockReset();
    FakeSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });

  it("retries after a rejected daemon_info", async () => {
    daemonInfo.mockRejectedValueOnce(new Error("not ready"));
    daemonInfo.mockResolvedValue({ url: "ws://127.0.0.1:9", token: "tok" });
    const { transport } = await import("./transport");
    await expect(transport.request("state_get", { key: "x" })).rejects.toThrow("not ready");

    const pending = transport.request<string>("state_get", { key: "x" });
    await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    const ws = FakeSocket.instances[0];
    expect(ws).toBeTruthy();
    ws!.readyState = FakeSocket.OPEN;
    ws!.onopen?.();
    ws!.onmessage?.({ data: JSON.stringify({ event: "hello", payload: { protocol: 1, version: "0.1.0" } }) });
    const sentRequest = () =>
      ws!.sent.map((raw) => JSON.parse(raw) as { id: number; method?: string }).find((item) => item.method === "state_get");
    await vi.waitFor(() => expect(sentRequest()).toBeTruthy());
    const req = sentRequest()!;
    ws!.onmessage?.({ data: JSON.stringify({ id: req.id, ok: true, result: "ok" }) });
    await expect(pending).resolves.toBe("ok");
  });
});
