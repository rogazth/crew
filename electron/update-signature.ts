import { createPublicKey, verify, type KeyObject } from "node:crypto";

/**
 * The ed25519 key release-publish.mjs signs latest.json with (SPKI, base64).
 * Only the release environment's UPDATE_SIGNING_KEY secret holds the private
 * half, so a release published any other way, or a manifest swapped on the
 * way, is refused. Changing it strands every installed copy on its version.
 */
export const UPDATE_PUBLIC_KEY = "MCowBQYDK2VwAyEARs5T5uYLE+WpgppEBj3O0qqouGfo5vGCM+4zClMMYxY=";

function keyOf(spki: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
}

/**
 * The manifest text inside latest.signed.json, once its signature checks out.
 * The signature covers those exact bytes, so nothing is re-serialized before
 * it is verified.
 */
export function openSigned(envelope: unknown, spki = UPDATE_PUBLIC_KEY): string {
  if (typeof envelope !== "object" || envelope === null) throw new Error("latest.signed.json is not an object");
  const { manifest, signature } = envelope as Record<string, unknown>;
  if (typeof manifest !== "string" || typeof signature !== "string") {
    throw new Error("latest.signed.json has no manifest and signature");
  }
  const bytes = Buffer.from(signature, "base64");
  if (bytes.length !== 64 || !verify(null, Buffer.from(manifest, "utf8"), keyOf(spki), bytes)) {
    throw new Error("latest.signed.json is not signed by Crew's release key");
  }
  return manifest;
}
