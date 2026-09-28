// Makes the certificate Crew's macOS builds are signed with, once:
//
//   node scripts/signing-cert.mjs            → into the login keychain, for local builds
//   node scripts/signing-cert.mjs --github   → and into the repo's secrets, for releases
//
// It is self-signed: free, and trusted by nothing, which codesign doesn't need.
// What it buys is a stable identity. An ad-hoc build is a new app to the
// keychain every time; one signed with this certificate is the same app as the
// one before it, so "Always Allow" on the keychain prompt holds across updates.
// Losing it means one more prompt after the next update, nothing worse: run
// this again. The private key lives in the login keychain (and the repo's
// secrets); nothing is left on disk.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const NAME = "Crew Code Signing";
const REPO = "rogazth/crew";
const LOGIN = path.join(homedir(), "Library/Keychains/login.keychain-db");
// codesign refuses a certificate past its end date, so it outlasts any plan to use it.
const DAYS = 7300;
const github = process.argv.includes("--github");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.platform !== "darwin") fail("Run this on the Mac that builds Crew.");

const existing = execFileSync("/usr/bin/security", ["find-identity", "-p", "codesigning"], { encoding: "utf8" })
  .split("\n")
  .find((line) => line.includes(`"${NAME}"`));
if (existing) {
  fail(
    `"${NAME}" is already in your keychain (${existing.trim().split(/\s+/)[1]}).\n` +
      "A second one would give the app a new identity. To send this one to GitHub, export it from\n" +
      "Keychain Access (My Certificates › Export) and set MAC_SIGNING_P12 (base64) and MAC_SIGNING_PASSWORD.",
  );
}

const dir = mkdtempSync(path.join(tmpdir(), "crew-signing-"));
try {
  const config = path.join(dir, "cert.cnf");
  writeFileSync(
    config,
    [
      "[req]",
      "distinguished_name = dn",
      "prompt = no",
      "x509_extensions = v3",
      "[dn]",
      `CN = ${NAME}`,
      "[v3]",
      "basicConstraints = critical, CA:FALSE",
      "keyUsage = critical, digitalSignature",
      "extendedKeyUsage = critical, codeSigning",
      "subjectKeyIdentifier = hash",
      "",
    ].join("\n"),
  );
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  const p12 = path.join(dir, "crew.p12");
  const password = randomBytes(24).toString("base64url");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", String(DAYS), "-config", config], {
    stdio: "ignore",
  });
  // The keychain reads only the older PKCS#12 ciphers.
  execFileSync("openssl", [
    "pkcs12", "-export", "-inkey", key, "-in", cert, "-out", p12, "-name", NAME,
    "-passout", `pass:${password}`, "-keypbe", "PBE-SHA1-3DES", "-certpbe", "PBE-SHA1-3DES", "-macalg", "sha1",
  ]);

  execFileSync("/usr/bin/security", ["import", p12, "-k", LOGIN, "-P", password, "-T", "/usr/bin/codesign"], { stdio: "inherit" });
  console.log(`"${NAME}" is in your login keychain. The first local build asks once to let codesign use it.`);

  if (github) {
    const secret = (name, value) => {
      const result = spawnSync("gh", ["secret", "set", name, "--repo", REPO], { input: value, stdio: ["pipe", "inherit", "inherit"] });
      if (result.status !== 0) fail(`Couldn't set ${name}. Is gh signed in with access to ${REPO}?`);
    };
    secret("MAC_SIGNING_P12", readFileSync(p12).toString("base64"));
    secret("MAC_SIGNING_PASSWORD", password);
    console.log(`MAC_SIGNING_P12 and MAC_SIGNING_PASSWORD are set on ${REPO}: releases are signed with it from the next one.`);
  } else {
    console.log("Releases still build ad hoc. Run with --github once to hand the certificate to the release workflow.");
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
