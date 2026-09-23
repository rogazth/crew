import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternal } from "./external";

const flush = () => new Promise((resolve) => setImmediate(resolve));

function host(openUrl: (url: string) => Promise<void> = () => Promise.resolve()) {
  const crewHost = { openUrl: vi.fn(openUrl) };
  vi.stubGlobal("window", { crewHost });
  return crewHost;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openExternal", () => {
  it("opens web and mail links in the system handler", async () => {
    const crewHost = host();
    openExternal("https://example.com/docs");
    openExternal("http://localhost:1420/");
    openExternal("mailto:team@example.com");
    await flush();
    expect(crewHost.openUrl.mock.calls).toEqual([
      ["https://example.com/docs"],
      ["http://localhost:1420/"],
      ["mailto:team@example.com"],
    ]);
  });

  it("accepts the scheme in any case", async () => {
    const crewHost = host();
    openExternal("HTTPS://example.com");
    await flush();
    expect(crewHost.openUrl).toHaveBeenCalledWith("HTTPS://example.com");
  });

  it("refuses anything a browser would not follow from untrusted output", async () => {
    const crewHost = host();
    for (const uri of ["javascript:alert(1)", "file:///etc/passwd", "vscode://open", "/tmp/a.txt", "example.com", ""]) {
      openExternal(uri);
    }
    await flush();
    expect(crewHost.openUrl).not.toHaveBeenCalled();
  });

  it("swallows a failure to open", async () => {
    const crewHost = host(() => Promise.reject(new Error("no handler")));
    openExternal("https://example.com");
    await flush();
    expect(crewHost.openUrl).toHaveBeenCalledTimes(1);
  });
});
