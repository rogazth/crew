import { describe, expect, it } from "vitest";
import { aliasOfHost, isMachineAlias, isPlainLoopback, machineAliases, machineHeaders, onMachine } from "./machines";

describe("machineAliases", () => {
  it("names each machine after itself, as a DNS label", () => {
    const aliases = machineAliases([
      { id: "b", name: "sandbox" },
      { id: "a", name: "falcon-heavy" },
      { id: "c", name: "Máquina de Gabriel" },
      { id: "d", name: "!!!" },
    ]);
    expect(Object.fromEntries(aliases)).toEqual({ a: "falcon-heavy", b: "sandbox", c: "maquina-de-gabriel", d: "machine" });
    for (const alias of aliases.values()) expect(isMachineAlias(alias)).toBe(true);
  });

  it("tells two machines of one name apart the same way every time", () => {
    const one = machineAliases([
      { id: "2", name: "box" },
      { id: "1", name: "Box" },
    ]);
    const other = machineAliases([
      { id: "1", name: "Box" },
      { id: "2", name: "box" },
    ]);
    expect(Object.fromEntries(one)).toEqual({ "1": "box", "2": "box-2" });
    expect(Object.fromEntries(other)).toEqual(Object.fromEntries(one));
  });

  it("keeps a long name to one label", () => {
    const [alias] = machineAliases([{ id: "x", name: "a".repeat(80) }]).values();
    expect(isMachineAlias(alias)).toBe(true);
    expect(alias!.length).toBeLessThanOrEqual(32);
  });
});

describe("onMachine", () => {
  it.each([
    ["http://localhost:3200", "http://sandbox.localhost:3200/"],
    ["http://localhost:3000/static/index.js?v=1#top", "http://sandbox.localhost:3000/static/index.js?v=1#top"],
    ["https://127.0.0.1:8443/", "https://sandbox.localhost:8443/"],
    ["http://[::1]:5173/", "http://sandbox.localhost:5173/"],
    ["http://LOCALHOST/", "http://sandbox.localhost/"],
  ])("moves %s to the machine", (url, expected) => {
    expect(onMachine(url, "sandbox")).toBe(expected);
  });

  it.each([
    "http://sandbox.localhost:3000/",
    "http://app.localhost:3000/",
    "https://redmad.nerblabs.dev/",
    "http://10.0.0.1:3000/",
    "ws://localhost:3000/",
    "about:blank",
    "not a url",
  ])("leaves %s alone", (url) => {
    expect(onMachine(url, "sandbox")).toBe(url);
  });

  it("changes nothing for a workspace on this Mac", () => {
    expect(onMachine("http://localhost:3000/", null)).toBe("http://localhost:3000/");
  });
});

describe("hosts", () => {
  it.each([
    ["sandbox.localhost", "sandbox"],
    ["app.sandbox.localhost", "sandbox"],
    ["Sandbox.Localhost.", "sandbox"],
    ["localhost", null],
    ["sandbox.localhost.com", null],
    ["-bad.localhost", null],
  ])("%s is on %s", (host, alias) => {
    expect(aliasOfHost(host)).toBe(alias);
  });

  it.each([
    ["localhost", true],
    ["127.0.0.1", true],
    ["127.1.2.3", true],
    ["[::1]", true],
    ["sandbox.localhost", false],
    ["128.0.0.1", false],
  ])("%s is plain loopback: %s", (host, expected) => {
    expect(isPlainLoopback(host)).toBe(expected);
  });
});

describe("machineHeaders", () => {
  it("names the machine on plain-HTTP loopback only", () => {
    expect(machineHeaders({ Accept: "*/*" }, "http://localhost:4000/api", "sandbox")).toEqual({ Accept: "*/*", "x-crew-machine": "sandbox" });
    expect(machineHeaders({}, "https://localhost:4000/api", "sandbox")).toEqual({});
    expect(machineHeaders({}, "http://sandbox.localhost:4000/api", "sandbox")).toEqual({});
    expect(machineHeaders({}, "http://example.com/", "sandbox")).toEqual({});
  });

  it("drops one a page wrote, in any case", () => {
    expect(machineHeaders({ "X-Crew-Machine": "falcon", Accept: "*/*" }, "http://localhost:4000/", null)).toEqual({ Accept: "*/*" });
    expect(machineHeaders({ "x-crew-machine": "falcon" }, "http://localhost:4000/", "sandbox")).toEqual({ "x-crew-machine": "sandbox" });
  });
});
