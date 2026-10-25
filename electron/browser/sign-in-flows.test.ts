import { describe, expect, it } from "vitest";
import { FlowRegistry, landsOn, redirectDecision, signInRequest } from "./sign-in-flows";

const STATE = "s7Hq2-xYz_0123456789";
const REDIRECT = "http://127.0.0.1:53682/callback";
const flow = { state: STATE, redirectUri: REDIRECT };

describe("signInRequest", () => {
  const good = { state: STATE, authUrl: "https://mcp.notion.com/authorize?client_id=x", redirectUri: REDIRECT, incognito: true };

  it("keeps a well-formed request", () => {
    expect(signInRequest(good)).toEqual(good);
    expect(signInRequest({ ...good, incognito: "yes" })).toEqual({ ...good, incognito: false });
  });

  it("takes http sign-in pages only on loopback", () => {
    expect(signInRequest({ ...good, authUrl: "http://127.0.0.1:9000/authorize" })).not.toBeNull();
    expect(signInRequest({ ...good, authUrl: "http://mcp.notion.com/authorize" })).toBeNull();
    expect(signInRequest({ ...good, authUrl: "javascript:alert(1)" })).toBeNull();
    expect(signInRequest({ ...good, authUrl: "https://user:pw@evil.com/" })).toBeNull();
  });

  it("takes only a loopback http redirect URI with a port and no query", () => {
    expect(signInRequest({ ...good, redirectUri: "http://[::1]:4000/cb" })).not.toBeNull();
    expect(signInRequest({ ...good, redirectUri: "https://127.0.0.1:53682/callback" })).toBeNull();
    expect(signInRequest({ ...good, redirectUri: "http://127.0.0.1/callback" })).toBeNull();
    expect(signInRequest({ ...good, redirectUri: "http://example.com:53682/callback" })).toBeNull();
    expect(signInRequest({ ...good, redirectUri: "http://127.0.0.1.nip.io:53682/callback" })).toBeNull();
    expect(signInRequest({ ...good, redirectUri: `${REDIRECT}?x=1` })).toBeNull();
  });

  it("takes a provider CLI's loopback listener on any port, and its own kind of state", () => {
    expect(signInRequest({ ...good, redirectUri: "http://127.0.0.1:17899/callback" })).not.toBeNull();
    expect(signInRequest({ ...good, redirectUri: "http://127.0.0.1:60694/callback" })).not.toBeNull();
    expect(signInRequest({ ...good, redirectUri: "http://localhost:33418/oauth/callback" })).not.toBeNull();
    expect(signInRequest({ ...good, state: "q1w2E3r4+t5y6/U7i8o9==" })).not.toBeNull();
  });

  it("refuses a short or odd state, and anything that is not an object", () => {
    expect(signInRequest({ ...good, state: "short" })).toBeNull();
    expect(signInRequest({ ...good, state: "has space in it" })).toBeNull();
    expect(signInRequest(null)).toBeNull();
    expect(signInRequest("https://mcp.notion.com")).toBeNull();
  });
});

describe("landsOn", () => {
  it("matches the origin and path whatever the query", () => {
    expect(landsOn(`${REDIRECT}?code=abc&state=${STATE}`, REDIRECT)).toBe(true);
    expect(landsOn(REDIRECT, REDIRECT)).toBe(true);
    expect(landsOn(`${REDIRECT}#frag`, REDIRECT)).toBe(true);
  });

  it("does not match another port, host, path or scheme", () => {
    expect(landsOn("http://127.0.0.1:53683/callback?code=a", REDIRECT)).toBe(false);
    expect(landsOn("http://localhost:53682/callback?code=a", REDIRECT)).toBe(false);
    expect(landsOn("http://127.0.0.1:53682/callbackx?code=a", REDIRECT)).toBe(false);
    expect(landsOn("http://127.0.0.1:53682/callback/more", REDIRECT)).toBe(false);
    expect(landsOn("https://127.0.0.1:53682/callback", REDIRECT)).toBe(false);
    expect(landsOn("not a url", REDIRECT)).toBe(false);
  });
});

describe("redirectDecision", () => {
  it("catches the flow's redirect with its own state", () => {
    const url = `${REDIRECT}?code=abc&state=${STATE}&iss=https%3A%2F%2Fmcp.notion.com`;
    expect(redirectDecision(url, flow)).toEqual({ action: "catch", state: STATE, url });
  });

  it("catches an error redirect too: the daemon reads it", () => {
    const url = `${REDIRECT}?error=access_denied&state=${STATE}`;
    expect(redirectDecision(url, flow)).toEqual({ action: "catch", state: STATE, url });
  });

  it("refuses the redirect with another state or none", () => {
    expect(redirectDecision(`${REDIRECT}?code=abc&state=other-state-123`, flow)).toEqual({ action: "refuse", state: STATE });
    expect(redirectDecision(`${REDIRECT}?code=abc`, flow)).toEqual({ action: "refuse", state: STATE });
  });

  it("lets every other navigation through", () => {
    expect(redirectDecision("https://mcp.notion.com/consent", flow)).toEqual({ action: "pass" });
    expect(redirectDecision("http://127.0.0.1:3000/", flow)).toEqual({ action: "pass" });
  });

  it("leaves a page that belongs to no flow alone, even on the redirect URI", () => {
    expect(redirectDecision(`${REDIRECT}?code=abc&state=${STATE}`, null)).toEqual({ action: "pass" });
  });
});

describe("a provider server's redirect", () => {
  it("is caught on Crew's own port or on the CLI's, whichever the flow names", () => {
    const crews = { state: STATE, redirectUri: "http://127.0.0.1:17899/callback" };
    const cli = { state: "codex-state-8f3a91", redirectUri: "http://127.0.0.1:60694/callback" };
    const back = (uri: string, state: string) => `${uri}?code=abc&state=${encodeURIComponent(state)}`;
    expect(redirectDecision(back(crews.redirectUri, STATE), crews).action).toBe("catch");
    expect(redirectDecision(back(cli.redirectUri, cli.state), cli).action).toBe("catch");
    // Each flow catches only its own port: the other's redirect goes on as any navigation would.
    expect(redirectDecision(back(crews.redirectUri, STATE), cli).action).toBe("pass");
    expect(redirectDecision(back(cli.redirectUri, cli.state), crews).action).toBe("pass");
  });

  it("matches a base64 state once the query is decoded", () => {
    const state = "q1w2E3r4+t5y6/U7i8o9==";
    const flow = { state, redirectUri: "http://127.0.0.1:60694/callback" };
    const url = `${flow.redirectUri}?code=abc&state=${encodeURIComponent(state)}`;
    expect(redirectDecision(url, flow)).toEqual({ action: "catch", state, url });
  });
});

describe("FlowRegistry", () => {
  const url = `${REDIRECT}?code=abc&state=${STATE}`;

  it("catches only on the flow's window and the popups it adopted", () => {
    const flows = new FlowRegistry();
    flows.start(10, flow);
    flows.adopt(11, STATE);
    expect(flows.decide(10, url).action).toBe("catch");
    expect(flows.decide(11, url).action).toBe("catch");
    // An agent's tab, or any other page, on the same URL.
    expect(flows.decide(12, url).action).toBe("pass");
    expect(flows.decide(undefined, url).action).toBe("pass");
  });

  it("does not adopt a popup into a flow that is not pending", () => {
    const flows = new FlowRegistry();
    flows.adopt(11, STATE);
    expect(flows.decide(11, url).action).toBe("pass");
  });

  it("settles a flow once, and its pages stop catching", () => {
    const flows = new FlowRegistry();
    flows.start(10, flow);
    flows.adopt(11, STATE);
    expect(flows.settle(STATE)).toBe(true);
    expect(flows.settle(STATE)).toBe(false);
    expect(flows.decide(10, url).action).toBe("pass");
    expect(flows.decide(11, url).action).toBe("pass");
    expect(flows.get(STATE)).toBeNull();
  });

  it("keeps two flows apart: one window's redirect is not the other's", () => {
    const flows = new FlowRegistry();
    const second = { state: "second-state-456", redirectUri: "http://127.0.0.1:53690/callback" };
    flows.start(10, flow);
    flows.start(20, second);
    expect(flows.decide(20, url).action).toBe("pass");
    expect(flows.decide(20, `${second.redirectUri}?code=x&state=${STATE}`)).toEqual({ action: "refuse", state: second.state });
    expect(flows.decide(10, url).action).toBe("catch");
  });

  it("forgets a page that went away", () => {
    const flows = new FlowRegistry();
    flows.start(10, flow);
    flows.adopt(11, STATE);
    flows.forget(11);
    expect(flows.decide(11, url).action).toBe("pass");
    expect(flows.decide(10, url).action).toBe("catch");
  });
});
