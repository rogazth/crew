// electron-builder's afterSign hook: signs the macOS app with a Developer ID,
// over the ad-hoc signature electron-builder leaves, and notarizes it.
//
// An ad-hoc signature is a hash of the binary, and so is the keychain's grant
// to anything not signed by Apple: every build is a new app to the keychain,
// and macOS asks for the password again after each update. A Developer ID
// makes the grant "team 9MB77G5MG6", which every later build keeps.
//
// The identity is CREW_SIGN_IDENTITY (a SHA-1 hash or a name), in
// CREW_SIGN_KEYCHAIN if set; otherwise the first valid "Developer ID
// Application" in the keychains macOS searches. Without either the build keeps
// its ad-hoc signature.
//
// Notarizing needs one of: APPLE_API_KEY (path to the .p8), APPLE_API_KEY_ID
// and APPLE_API_ISSUER; or APPLE_KEYCHAIN_PROFILE, a profile saved with
// `xcrun notarytool store-credentials`. Without them the app is signed but not
// notarized, which is enough for the keychain; Gatekeeper wants the ticket.
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const KIND = "Developer ID Application";
const ENTITLEMENTS = path.join(__dirname, "..", "build", "entitlements.mac.plist");

/** The SHA-1 of the first valid Developer ID Application identity, or null. */
function localIdentity() {
  try {
    const out = execFileSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
    const line = out.split("\n").find((row) => row.includes(`"${KIND}: `));
    return line?.trim().split(/\s+/)[1] ?? null;
  } catch {
    return null;
  }
}

/** @electron/notarize's credentials from the environment, or null. */
function notaryCredentials() {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, APPLE_KEYCHAIN_PROFILE, APPLE_KEYCHAIN } = process.env;
  if (APPLE_API_KEY && APPLE_API_KEY_ID && APPLE_API_ISSUER) {
    return { appleApiKey: APPLE_API_KEY, appleApiKeyId: APPLE_API_KEY_ID, appleApiIssuer: APPLE_API_ISSUER };
  }
  if (APPLE_KEYCHAIN_PROFILE) return { keychainProfile: APPLE_KEYCHAIN_PROFILE, keychain: APPLE_KEYCHAIN || undefined };
  return null;
}

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const identity = process.env.CREW_SIGN_IDENTITY || localIdentity();
  if (!identity) {
    console.log(`  • no "${KIND}" certificate: the app keeps its ad-hoc signature`);
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { signAsync } = require("@electron/osx-sign");
  await signAsync({
    app,
    identity,
    keychain: process.env.CREW_SIGN_KEYCHAIN || undefined,
    platform: "darwin",
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // The hardened runtime keeps other processes of the user's from injecting code (DYLD_*) or
    // attaching; the entitlements give back what Electron and the browser need. osx-sign asks
    // Apple's timestamp server, which notarization requires.
    optionsForFile: () => ({ hardenedRuntime: true, entitlements: ENTITLEMENTS }),
  });
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  const requirement = execFileSync("/usr/bin/codesign", ["-d", "-r-", app], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  console.log(`  • signed: ${requirement.trim().split("\n").pop()}`);

  const credentials = notaryCredentials();
  if (!credentials) {
    console.log("  • no notarization credentials: the app is signed but not notarized");
    return;
  }
  console.log("  • notarizing (a few minutes)");
  const { notarize } = require("@electron/notarize");
  // Waits for Apple's verdict, then staples the ticket so Gatekeeper passes offline.
  await notarize({ appPath: app, ...credentials });
  execFileSync("/usr/bin/xcrun", ["stapler", "validate", app], { stdio: "inherit" });
  console.log("  • notarized and stapled");
};
