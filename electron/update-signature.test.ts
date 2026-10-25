import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSigned, UPDATE_PUBLIC_KEY } from "./update-signature";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const manifest = JSON.stringify({ version: "9.9.9", zip: "https://example/x.zip", sha256: "0".repeat(64) });

function envelope(text: string, key = privateKey) {
  return { manifest: text, signature: sign(null, Buffer.from(text, "utf8"), key).toString("base64") };
}

describe("openSigned", () => {
  it("returns the manifest a release key signed", () => {
    expect(openSigned(envelope(manifest), spki)).toBe(manifest);
  });

  it("refuses a manifest changed after signing", () => {
    const signed = envelope(manifest);
    expect(() => openSigned({ ...signed, manifest: manifest.replace("9.9.9", "9.9.10") }, spki)).toThrow(/not signed/);
  });

  it("refuses a signature from another key", () => {
    const other = generateKeyPairSync("ed25519").privateKey;
    expect(() => openSigned(envelope(manifest, other), spki)).toThrow(/not signed/);
  });

  it("refuses an envelope without both fields", () => {
    expect(() => openSigned(JSON.parse(manifest), spki)).toThrow(/no manifest/);
    expect(() => openSigned(null, spki)).toThrow(/not an object/);
    expect(() => openSigned({ manifest, signature: "short" }, spki)).toThrow(/not signed/);
  });

  it("embeds a key node can load", () => {
    expect(() => openSigned(envelope(manifest), UPDATE_PUBLIC_KEY)).toThrow(/not signed/);
  });
});
