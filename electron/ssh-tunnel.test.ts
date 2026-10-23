import { describe, expect, it } from "vitest";
import { isLoopback, tunnelArgs } from "./ssh-tunnel";

describe("ssh tunnels", () => {
  it("takes a crewd on the machine's loopback as one reached over ssh", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("100.102.48.125")).toBe(false);
  });

  // crewd and its SOCKS5 proxy on the next port, both only on the machine's loopback.
  it("forwards crewd and its proxy from this Mac's loopback", () => {
    const args = tunnelArgs({ destination: "atlas", user: "root", port: 2222 }, { port: 50001, socksPort: 50002 }, 17877);
    expect(args).toContain("127.0.0.1:50001:127.0.0.1:17877");
    expect(args).toContain("127.0.0.1:50002:127.0.0.1:17878");
    expect(args).toContain("ExitOnForwardFailure=yes");
    expect(args).toContain("ControlMaster=yes");
    expect(args).toContain("ForwardAgent=no");
    expect(args.slice(-6)).toEqual(["-l", "root", "-p", "2222", "--", "atlas"]);
  });
});
