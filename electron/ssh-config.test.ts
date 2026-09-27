import { describe, expect, it } from "vitest";
import { hostAliases, includes, parseResolved } from "./ssh-config";

const CONFIG = `
Host falcon-heavy
  HostName 100.127.204.79
  User agent

Host falcon-heavy-public
  HostName 163.192.102.220
  User agent
  ControlPath ~/.ssh/cm/%r@%h:%p

Host agents-sandbox asb   # two names, one machine
  HostName 100.76.47.8
Host=eq-style
Host *.internal !bastion
Host *
  ServerAliveInterval 30
Include config.d/work ~/.ssh/extra *.conf
`;

describe("ssh config", () => {
  it("lists the Hosts a user can type, not the patterns", () => {
    expect(hostAliases(CONFIG)).toEqual(["falcon-heavy", "falcon-heavy-public", "agents-sandbox", "asb", "eq-style"]);
  });

  it("follows Include files under ~/.ssh, leaving globs to ssh", () => {
    expect(includes(CONFIG, "/Users/me")).toEqual(["/Users/me/.ssh/config.d/work", "/Users/me/.ssh/extra"]);
  });

  it("reads what ssh -G resolved, and whether a proxy dials for it", () => {
    const direct = parseResolved("user agent\nhostname 163.192.102.220\nport 22\nproxycommand none\n");
    expect(direct).toEqual({ hostname: "163.192.102.220", port: 22, user: "agent", proxied: false });
    expect(parseResolved("hostname db\nport 2222\nuser me\nproxyjump bastion\n")).toMatchObject({ port: 2222, proxied: true });
  });
});
