#!/usr/bin/env node

/**
 * Proves the commons tarballs are what a consumer will install, before
 * anything is published.
 *
 * Runs on every PR (with a throwaway version) and in the release lane between
 * `pack` and `publish` (with the tag's version, against the very tarballs
 * that will ship). Four checks, in the order a consumer would hit them:
 *
 *   1. Whitelist: every file in each tarball is under an entry the package's
 *      `files` field names (or is package.json, README, LICENSE), and no test
 *      module leaked into dist/. `npm pack` is generous by default; the
 *      whitelist is the promise.
 *   2. Stamp: the tarball's own package.json carries the release version and
 *      every @stigmer/* range pinned to it — the lockstep, checked in the
 *      artefact rather than trusted from the script that made it.
 *   3. Install: all tarballs install together into an empty project, so the
 *      exact peer pins resolve against each other and every third-party
 *      dependency is declared (a missing one fails here, not in a consumer).
 *   4. Import: every `exports` subpath loads under plain Node ESM. This is
 *      the DD-A8 gate (stigmer DD-018): an extension-less relative specifier
 *      resolves under bundlers and tsx but crashes `node`, and dev/tests
 *      never run the built output. The platform's verifier is static because
 *      its dev exports point at TypeScript source; ours point at dist/, so a
 *      real import is possible and is the stronger proof.
 *
 * Usage:
 *   node scripts/verify-publish.mjs                 # packs 0.0.0-verify, verifies
 *   node scripts/verify-publish.mjs --from-manifest # verifies dist-release/ as packed
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGES, ROOT, pack, readManifest, readReleaseManifest } from "./publish-packages.mjs";

const VERIFY_VERSION = "0.0.0-verify";
const ALWAYS_ALLOWED = new Set(["package.json", "README.md", "LICENSE"]);
const TEST_MODULE = /(^|\/)__tests__\/|\.test\.|\.integration\./;

function fail(message) {
  console.error(`verify-publish: ${message}`);
  process.exitCode = 1;
}

function checkWhitelist(entry, manifest) {
  const roots = (manifest.files ?? []).map((f) => f.replace(/\/$/, ""));
  for (const path of entry.files) {
    if (ALWAYS_ALLOWED.has(path)) continue;
    if (TEST_MODULE.test(path)) fail(`${entry.name}: test module leaked into the tarball: ${path}`);
    if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) {
      fail(`${entry.name}: ${path} is outside the files whitelist [${roots.join(", ")}]`);
    }
  }
}

function checkStamp(entry, releaseVersion) {
  const shipped = JSON.parse(
    execFileSync("tar", ["-xOf", join(ROOT, entry.tarball), "package/package.json"], { encoding: "utf8" }),
  );
  if (shipped.version !== releaseVersion) {
    fail(`${entry.name}: tarball package.json says ${shipped.version}, release is ${releaseVersion}`);
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [name, range] of Object.entries(shipped[field] ?? {})) {
      if (name.startsWith("@stigmer/") && range !== releaseVersion) {
        fail(`${entry.name}: ${field}.${name} is "${range}", not pinned to ${releaseVersion}`);
      }
    }
  }
}

/**
 * Optional peers (authorization's `testcontainers` for its ./testing
 * subpath) are not auto-installed, so the import check would fail for a
 * reason unrelated to our packages; install them explicitly at the declared
 * range.
 */
function optionalPeerSpecs(manifests) {
  const specs = [];
  for (const manifest of manifests) {
    for (const [name, meta] of Object.entries(manifest.peerDependenciesMeta ?? {})) {
      if (meta?.optional && manifest.peerDependencies?.[name]) {
        specs.push(`${name}@${manifest.peerDependencies[name]}`);
      }
    }
  }
  return specs;
}

function subpathsOf(manifest) {
  return Object.keys(manifest.exports ?? {}).filter((key) => key !== "./package.json");
}

function main() {
  const fromManifest = process.argv.includes("--from-manifest");
  const release = fromManifest ? readReleaseManifest() : pack(VERIFY_VERSION);
  const manifests = PACKAGES.map(readManifest);

  release.tarballs.forEach((entry, i) => {
    checkWhitelist(entry, manifests[i]);
    checkStamp(entry, release.version);
  });
  if (process.exitCode) return;

  const consumer = mkdtempSync(join(tmpdir(), "stigmer-apps-verify-"));
  try {
    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "verify-consumer", private: true, type: "module" }, null, 2),
    );
    execFileSync(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...release.tarballs.map((t) => join(ROOT, t.tarball)),
        ...optionalPeerSpecs(manifests),
      ],
      { cwd: consumer, stdio: "inherit" },
    );

    for (const [i, entry] of release.tarballs.entries()) {
      for (const subpath of subpathsOf(manifests[i])) {
        const specifier = subpath === "." ? entry.name : `${entry.name}/${subpath.slice(2)}`;
        try {
          execFileSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)})`], {
            cwd: consumer,
            stdio: ["ignore", "ignore", "pipe"],
            encoding: "utf8",
          });
          console.log(`ok  import ${specifier}`);
        } catch (err) {
          fail(`import ${specifier} failed under plain Node:\n${err.stderr ?? err.message}`);
        }
      }
    }
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }

  if (!process.exitCode) {
    console.log(`verify-publish: ${release.tarballs.length} tarballs at ${release.version} verified`);
  }
}

main();
