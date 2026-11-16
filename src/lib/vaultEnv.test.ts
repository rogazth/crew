import { beforeEach, describe, expect, it, vi } from "vitest";

// The window at boot: the address book is read from this Mac's daemon after a
// while, and until then the links hold this Mac alone.
const boot = vi.hoisted(() => {
  const mac = { id: "local", name: "This Mac" };
  const vault = { id: "falcon", name: "falcon-heavy" };
  let links = [mac];
  let release = () => {};
  let loaded = new Promise<void>((done) => (release = done));
  return {
    vault,
    links: () => links,
    reset() {
      links = [mac];
      loaded = new Promise<void>((done) => (release = done));
    },
    load(withVault = true) {
      links = withVault ? [mac, vault] : [mac];
      release();
    },
    loaded: () => loaded,
  };
});

let vaultEnv = "local";
let kept: string | null = boot.vault.id;

vi.mock("./api", () => ({
  getVaultEnv: () => vaultEnv,
  setVaultEnv: (env: string) => (vaultEnv = env),
  stateGet: async () => kept,
  stateSet: async () => {},
}));
vi.mock("./client/registry", () => ({
  getLinks: () => boot.links(),
  remotesLoaded: () => boot.loaded(),
  subscribeLinks: () => () => {},
}));
vi.mock("./client/route", () => ({ LOCAL: "local" }));
vi.mock("./host", () => ({ remotesHost: () => null }));
vi.mock("./remotes", () => ({ DEFAULT_PORT: 17877, isLoopback: () => false }));

const { loadVault } = await import("../surfaces/settings/integrations/vault");

describe("loadVault", () => {
  beforeEach(() => {
    boot.reset();
    vaultEnv = "local";
    kept = boot.vault.id;
  });

  it("waits for the address book, so a vault on another machine isn't taken for one removed", async () => {
    const loading = loadVault();
    // Read before the machines are known, it would fall back to this Mac and
    // send every sign-in there, where no call ever uses it.
    await new Promise((settle) => setTimeout(settle, 0));
    expect(vaultEnv).toBe("local");
    boot.load();
    await expect(loading).resolves.toBe(boot.vault.id);
    expect(vaultEnv).toBe(boot.vault.id);
  });

  it("gives the vault back to this Mac when its machine was removed", async () => {
    const loading = loadVault();
    boot.load(false);
    await expect(loading).resolves.toBe("local");
  });

  it("keeps this Mac when nothing was chosen", async () => {
    kept = null;
    const loading = loadVault();
    boot.load();
    await expect(loading).resolves.toBe("local");
  });
});
