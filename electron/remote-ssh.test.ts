import { describe, expect, it } from "vitest";
import { isTailnetIp, linuxArch, serviceUnit } from "./remote-ssh";

describe("linux installer", () => {
  it("maps uname to the builds Crew ships", () => {
    expect(linuxArch("aarch64\n")).toBe("arm64");
    expect(linuxArch("x86_64")).toBe("x64");
    expect(linuxArch("armv7l")).toBeNull();
  });

  it("writes a user unit that listens on the tailnet address", () => {
    const unit = serviceUnit("100.127.204.79", 17877);
    expect(unit).toContain("After=tailscaled.service");
    expect(unit).toContain("ExecStart=%h/.crew/bin/crewd serve --listen 100.127.204.79:17877 --data-dir %h/.crew/data");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("only takes a tailnet address as the one crewd listens on", () => {
    expect(isTailnetIp("100.127.204.79")).toBe(true);
    expect(isTailnetIp("100.64.0.1")).toBe(true);
    expect(isTailnetIp("100.128.0.1")).toBe(false);
    expect(isTailnetIp("163.192.102.220")).toBe(false);
  });
});
