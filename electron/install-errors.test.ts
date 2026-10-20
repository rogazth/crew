import { describe, expect, it } from "vitest";
import { classifyInstallFailure } from "./install-errors";

const context = { destination: "falcon", port: 17877 };

describe("install failures", () => {
  it("says SSH is unreachable, with the command that tests it", () => {
    for (const message of [
      "Could not reach falcon on port 22: no answer",
      "Could not reach falcon on port 22: unknown host",
      "ssh: connect to host falcon port 22: Connection refused",
      "ssh: Could not resolve hostname falcon: nodename nor servname provided",
      "ssh: connect to host 10.0.0.4 port 22: Operation timed out",
    ]) {
      const failure = classifyInstallFailure(message, context);
      expect(failure.code).toBe("unreachable");
      expect(failure.message).toBe(message);
      expect(failure.fix).toBe("ssh falcon");
    }
  });

  it("names the SSH port and user in the fix", () => {
    const failure = classifyInstallFailure("Could not reach falcon on port 2222: no answer", {
      destination: "falcon",
      user: "deploy",
      sshPort: 2222,
      port: 17877,
    });
    expect(failure.fix).toBe("ssh -p 2222 deploy@falcon");
  });

  it("offers ssh-copy-id when the key is refused", () => {
    const failure = classifyInstallFailure("deploy@falcon: Permission denied (publickey).", { ...context, user: "deploy" });
    expect(failure.code).toBe("auth");
    expect(failure.fix).toBe("ssh-copy-id deploy@falcon");
  });

  it("points at the advanced options when the port is taken", () => {
    const failure = classifyInstallFailure("Port 17877 is already in use on that machine", context);
    expect(failure.code).toBe("port");
    expect(failure.hint).toContain("17877");
    expect(failure.hint).toContain("Advanced options");
    expect(failure.fix).toBeUndefined();
  });

  it("keeps the raw message for anything else, and for a daemon that cannot be reached", () => {
    for (const message of ["Could not reach ws://100.64.0.1:17877", "x86_64 is fine, riscv64 is not a Linux architecture Crew ships"]) {
      expect(classifyInstallFailure(message, context)).toEqual({ code: "other", message, hint: "" });
    }
  });
});
