import { describe, expect, it } from "vitest";
import { appName, channelOf, cliLinkName } from "./channel";
import { remoteLayout } from "./remote-ssh";

describe("what each build keeps apart", () => {
  it("tells the builds apart", () => {
    expect(channelOf(true, true)).toBe("release");
    expect(channelOf(true, false)).toBe("local");
    expect(channelOf(false, true)).toBe("dev");
  });

  it("gives each its own keychain item and its own command, the release keeping its own", () => {
    expect(appName("release")).toBe("Crew");
    expect(cliLinkName("release")).toBe("crew");
    const channels = ["release", "local", "dev"] as const;
    expect(new Set(channels.map(appName)).size).toBe(3);
    expect(new Set(channels.map(cliLinkName)).size).toBe(3);
  });

  it("gives each a remote port pair no other build's daemon or SOCKS listener takes", () => {
    const taken = ["release", "local", "dev"].flatMap((channel) => {
      const { port } = remoteLayout(channel as "release");
      return [port, port + 1];
    });
    expect(new Set(taken).size).toBe(taken.length);
    expect(remoteLayout("release").port).toBe(17877);
  });
});
