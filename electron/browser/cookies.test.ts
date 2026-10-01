import { describe, expect, it } from "vitest";
import { cookieDetails } from "./cookies";

const base = {
  host: ".github.com",
  name: "user_session",
  value: "abc",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: 1_900_000_000,
};

describe("cookieDetails", () => {
  it("keeps a domain cookie's domain and expiry", () => {
    expect(cookieDetails(base)).toEqual({
      url: "https://github.com/",
      name: "user_session",
      value: "abc",
      domain: ".github.com",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      expirationDate: 1_900_000_000,
    });
  });

  it("leaves the domain off a host-only cookie and the expiry off a session one", () => {
    const details = cookieDetails({ ...base, host: "app.example.com", secure: false, expires: undefined, path: "/a" });
    expect(details).toMatchObject({ url: "http://app.example.com/a", path: "/a" });
    expect(details).not.toHaveProperty("domain");
    expect(details).not.toHaveProperty("expirationDate");
  });

  it("writes a __Host- cookie without a domain at path /", () => {
    const details = cookieDetails({ ...base, name: "__Host-id", path: "/x" });
    expect(details).toMatchObject({ url: "https://github.com/", path: "/" });
    expect(details).not.toHaveProperty("domain");
  });

  it("refuses malformed entries", () => {
    expect(cookieDetails(null)).toBeNull();
    expect(cookieDetails({ ...base, host: "evil.com/path" })).toBeNull();
    expect(cookieDetails({ ...base, sameSite: "none" })).toBeNull();
    expect(cookieDetails({ ...base, secure: "yes" })).toBeNull();
    expect(cookieDetails({ ...base, expires: Number.NaN })).toBeNull();
  });
});
