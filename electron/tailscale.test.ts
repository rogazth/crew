import { describe, expect, it } from "vitest";
import { devicesFrom, tailnetFrom } from "./tailscale";

const status = {
  Self: {
    HostName: "mbp",
    DNSName: "mbp.tail.ts.net.",
    OS: "macOS",
    Online: true,
    TailscaleIPs: ["100.1.1.1", "fd7a::1"],
    CurAddr: "1.2.3.4:41641",
    Relay: "ord",
  },
  Peer: {
    a: {
      HostName: "falcon-heavy",
      DNSName: "falcon-heavy.tail.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.127.204.79", "fd7a::2"],
      CurAddr: "9.9.9.9:41641",
      Relay: "ord",
    },
    b: {
      HostName: "phone",
      DNSName: "phone.tail.ts.net.",
      OS: "iOS",
      Online: true,
      TailscaleIPs: ["100.2.2.2"],
      CurAddr: "",
      Relay: "sao",
    },
    c: {
      HostName: "down",
      DNSName: "down.tail.ts.net.",
      OS: "linux",
      Online: false,
      TailscaleIPs: ["100.3.3.3"],
      CurAddr: "",
      Relay: "sea",
    },
    d: {
      HostName: "far",
      DNSName: "far.tail.ts.net.",
      OS: "linux",
      Online: true,
      TailscaleIPs: ["100.4.4.4"],
      CurAddr: "",
      Relay: "sao",
    },
  },
};

describe("devicesFrom", () => {
  const rows = devicesFrom(status, new Set(["100.127.204.79"]));

  it("marks this Mac and keeps a direct Linux peer selectable until it is added", () => {
    expect(rows[0]).toMatchObject({ host: "mbp", self: true, reason: "This Mac", relay: false });
    expect(rows.find((row) => row.host === "falcon-heavy")).toMatchObject({
      ip: "100.127.204.79",
      os: "Linux",
      relay: false,
      reason: "Added",
    });
  });

  it("disables other operating systems, offline machines, and relays", () => {
    expect(rows.find((row) => row.host === "phone")?.reason).toBe("iOS isn't supported");
    expect(rows.find((row) => row.host === "down")?.reason).toBe("Offline");
    expect(rows.find((row) => row.host === "far")).toMatchObject({ relay: true, reason: null, online: true });
  });

  it("lists the machines that can be added first", () => {
    expect(rows.slice(1).map((row) => row.host)).toEqual(["far", "down", "falcon-heavy", "phone"]);
  });
});

describe("tailnetFrom", () => {
  it("names the signed-in account while Tailscale runs", () => {
    const tailnet = tailnetFrom(
      { ...status, BackendState: "Running", Self: { ...status.Self, UserID: 7 }, User: { "7": { LoginName: "me@github" } } },
      new Set(),
    );
    expect(tailnet).toMatchObject({ state: "running", account: "me@github", message: null });
    expect(tailnet.devices).toHaveLength(5);
  });

  it("says so when Tailscale is stopped or signed out", () => {
    expect(tailnetFrom({ BackendState: "Stopped" }, new Set())).toMatchObject({ state: "stopped", devices: [] });
    expect(tailnetFrom({ BackendState: "NeedsLogin" }, new Set()).message).toBe("Tailscale is signed out");
  });
});
