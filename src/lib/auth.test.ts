import { describe, expect, it } from "vitest";
import { isAuthFailure, loginArgv } from "./auth";

describe("isAuthFailure", () => {
  it("recognizes a Claude OAuth session that can no longer refresh", () => {
    expect(isAuthFailure("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(true);
  });

  it("recognizes the other ways a CLI asks for a login", () => {
    expect(isAuthFailure("Not logged in")).toBe(true);
    expect(isAuthFailure("Login expired · Please run /login")).toBe(true);
    expect(isAuthFailure('OAuth token has been revoked')).toBe(true);
  });

  it("knows the other CLIs' sign-in failures", () => {
    expect(isAuthFailure("Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.")).toBe(true);
    expect(isAuthFailure("OAuth refresh token was rejected: invalid_grant")).toBe(true);
    expect(isAuthFailure("Cursor Agent could not log in (run `cursor-agent login` in a terminal): Authentication required")).toBe(true);
    expect(isAuthFailure("Authentication required: token expired")).toBe(true);
    expect(isAuthFailure("Your team sign-in was rejected. It may have expired or lack access. Run `grok login` to sign in again.")).toBe(true);
    expect(isAuthFailure("Grok did not start: auth refresh failed")).toBe(true);
  });

  it("leaves an ordinary failure alone", () => {
    expect(isAuthFailure("Claude exited with code 1.")).toBe(false);
    expect(isAuthFailure("boom")).toBe(false);
  });
});

describe("loginArgv", () => {
  it("runs each CLI's own login", () => {
    expect(loginArgv("claude", false)).toEqual(["claude", "auth", "login"]);
    expect(loginArgv("codex", false)).toEqual(["codex", "login"]);
    expect(loginArgv("cursor", true)).toEqual(["cursor-agent", "login"]);
    expect(loginArgv("opencode", false)).toEqual(["opencode", "auth", "login"]);
    expect(loginArgv("grok", false)).toEqual(["grok", "login"]);
  });

  it("uses the device login of grok and codex on a remote machine, where a browser has nowhere to finish", () => {
    expect(loginArgv("grok", true)).toEqual(["grok", "login", "--device-auth"]);
    expect(loginArgv("codex", true)).toEqual(["codex", "login", "--device-auth"]);
  });

  it("has nothing for a provider without a login", () => {
    expect(loginArgv("gemini", false)).toBeNull();
  });
});
