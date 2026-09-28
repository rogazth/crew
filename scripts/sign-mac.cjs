// electron-builder's afterSign hook: signs the macOS app with Crew's own
// certificate, over the ad-hoc signature electron-builder leaves.
//
// An ad-hoc signature is a hash of the binary, so every build is a new app to
// the keychain and macOS asks for the password again after each update. A
// certificate makes the app's identity "rogazth.crew, signed by this
// certificate", which the next build keeps. electron-builder only signs with
// identities macOS trusts, and a self-signed one isn't, so the signing is
// done here instead.
//
// The identity is CREW_SIGN_IDENTITY (a SHA-1 hash or a name), in
// CREW_SIGN_KEYCHAIN if set; otherwise "Crew Code Signing" from the login
// keychain, which `node scripts/signing-cert.mjs` makes. Without either the
// build keeps its ad-hoc signature.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const CERT_NAME = "Crew Code Signing";
const ENTITLEMENTS = path.join(__dirname, "..", "build", "entitlements.mac.plist");

/** The SHA-1 of "Crew Code Signing" in the keychains macOS searches, or null. */
function localIdentity() {
  try {
    const out = execFileSync("/usr/bin/security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" });
    const line = out.split("\n").find((row) => row.includes(`"${CERT_NAME}"`));
    return line?.trim().split(/\s+/)[1] ?? null;
  } catch {
    return null;
  }
}

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const identity = process.env.CREW_SIGN_IDENTITY || localIdentity();
  if (!identity) {
    console.log(`  • no "${CERT_NAME}" certificate: the app keeps its ad-hoc signature`);
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { signAsync } = require("@electron/osx-sign");
  await signAsync({
    app,
    identity,
    keychain: process.env.CREW_SIGN_KEYCHAIN || undefined,
    platform: "darwin",
    // A self-signed certificate isn't a "valid" identity to macOS, but codesign signs with it all the same.
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // As the ad-hoc build was: no hardened runtime, the same entitlements, and no Apple timestamp,
    // which Apple's server gives only to its own certificates.
    optionsForFile: () => ({ hardenedRuntime: false, entitlements: ENTITLEMENTS, timestamp: "none" }),
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const requirement = execFileSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`  • signed with "${CERT_NAME}": ${requirement.trim().split("\n").pop()}`);
};
