import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SignInOutcome, SignInRequest } from "./browser/bridge";

const signIn = vi.fn<(request: SignInRequest) => Promise<SignInOutcome>>();
let host: { signIn?: typeof signIn } | null = null;
vi.mock("./host", () => ({ browserHost: () => host }));

const { catchRedirect, mockRedirect, runSignIn } = await import("./signInWindow");

const PAGE = { state: "state-1234abcd", authUrl: "https://mcp.example.com/authorize", redirectUri: "http://127.0.0.1:60694/callback" };

beforeEach(() => {
  signIn.mockReset();
  host = { signIn };
});

describe("mockRedirect", () => {
  it("comes back to the redirect URI with a code and the state", () => {
    expect(mockRedirect("http://127.0.0.1:17899/callback", "a b")).toBe("http://127.0.0.1:17899/callback?code=mock&state=a%20b");
    expect(mockRedirect("http://127.0.0.1:17899/callback?x=1", "s")).toBe("http://127.0.0.1:17899/callback?x=1&code=mock&state=s");
  });
});

describe("catchRedirect", () => {
  it("asks the window with the page's redirect, whatever port it names", async () => {
    signIn.mockResolvedValue({ kind: "caught", url: `${PAGE.redirectUri}?code=c&state=${PAGE.state}` });
    await expect(catchRedirect(PAGE)).resolves.toBe(`${PAGE.redirectUri}?code=c&state=${PAGE.state}`);
    expect(signIn).toHaveBeenCalledWith({ ...PAGE, incognito: false });
  });

  it("answers null when the window closed, and throws on a redirect for another request", async () => {
    signIn.mockResolvedValueOnce({ kind: "closed" });
    await expect(catchRedirect(PAGE)).resolves.toBeNull();
    signIn.mockResolvedValueOnce({ kind: "refused" });
    await expect(catchRedirect(PAGE)).rejects.toThrow(/another request/);
  });

  it("throws why when the sign-in couldn't go on", async () => {
    signIn.mockResolvedValueOnce({ kind: "failed", message: "Port 17899 on this Mac is in use." });
    await expect(catchRedirect(PAGE)).rejects.toThrow("Port 17899 on this Mac is in use.");
  });

  it("comes back at once where there is no sign-in window", async () => {
    host = null;
    await expect(catchRedirect(PAGE)).resolves.toBe(mockRedirect(PAGE.redirectUri, PAGE.state));
  });
});

describe("runSignIn", () => {
  it("hands the caught URL to the caller's daemon, not anyone else's", async () => {
    const url = `${PAGE.redirectUri}?code=c&state=${PAGE.state}`;
    signIn.mockResolvedValue({ kind: "caught", url });
    const deliver = vi.fn(async (caught: string) => `redeemed ${caught}`);
    const cancel = vi.fn(async () => null);
    await expect(runSignIn(PAGE, { deliver, cancel })).resolves.toEqual({ kind: "done", value: `redeemed ${url}` });
    expect(deliver).toHaveBeenCalledWith(url);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels the flow when the window closes first", async () => {
    signIn.mockResolvedValue({ kind: "closed" });
    const deliver = vi.fn(async () => null);
    const cancel = vi.fn(async () => null);
    await expect(runSignIn(PAGE, { deliver, cancel })).resolves.toEqual({ kind: "closed" });
    expect(deliver).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("cancels, then throws, on a refused redirect", async () => {
    signIn.mockResolvedValue({ kind: "refused" });
    const cancel = vi.fn(async () => {
      throw new Error("gone already");
    });
    await expect(runSignIn(PAGE, { deliver: vi.fn(), cancel })).rejects.toThrow(/another request/);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
