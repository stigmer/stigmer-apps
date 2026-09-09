#!/usr/bin/env node

/**
 * Stamps, packs and publishes the commons packages as ONE lockstep release.
 *
 * The version lives in the git tag, nowhere else (the platform's convention:
 * stigmer/stigmer keeps `0.0.0-dev` in every package.json and derives the
 * release version from the `v*` tag in `release.npm-libs.yaml`). In the
 * workspace every `@stigmer/*` range is `*`, which is what lets npm link the
 * sibling package instead of fetching from the registry; at publish time the
 * stamp pins each of those ranges to the exact release version, so a
 * published `@stigmer/identity@X` resolves precisely the `@stigmer/resource-api@X`
 * it was built and tested against. A caret here would let two copies of the
 * pipeline coexist in one consumer, and `instanceof` on the pipeline's error
 * classes would silently stop matching.
 *
 * Two stages, deliberately separate, so the lane publishes the very tarballs
 * it verified (the image job's principle: what ships is byte-for-byte what
 * booted):
 *
 *   pack    --version X   stamps each manifest, runs `npm pack` into
 *                         dist-release/, restores the manifest (the tree
 *                         keeps the sentinel; only the tarball carries the
 *                         version), and writes dist-release/manifest.json
 *   publish --version X   reads that manifest and `npm publish`es each tarball
 *                         in dependency order with --provenance; the dist-tag
 *                         is `next` for a pre-release, `latest` otherwise
 *
 * `scripts/verify-publish.mjs` sits between the two in the lane and runs on
 * every PR with a throwaway version. The pure functions here are unit-tested
 * in publish-packages.test.mjs.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Publish order is dependency order: identity's peer on resource-api must
 * already resolve on the registry by the time a consumer installs identity.
 * authorization has no commons dependency and goes last only for symmetry
 * with the build order in the root package.json.
 */
export const PACKAGES = ["packages/resource-api", "packages/identity", "packages/authorization"];

export const RELEASE_DIR = "dist-release";

/** The sentinel every workspace manifest carries between releases. */
export const DEV_VERSION = "0.0.0-dev";

const SCOPE = "@stigmer/";
const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"];

/**
 * A release version is a bare semver (`1.2.3`) or a semver pre-release
 * (`1.2.3-rc.1`); the leading `v` belongs to the tag, not the package.
 */
export function assertReleaseVersion(version) {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Not a release version: "${version}" (expected X.Y.Z or X.Y.Z-pre.N, no leading v)`);
  }
  return version;
}

/**
 * `next` for a pre-release, `latest` for a release — the same inference the
 * platform's publisher makes, so `npm install @stigmer/resource-api` never
 * resolves to an rc.
 */
export function distTagFor(version) {
  return version.includes("-") ? "next" : "latest";
}

/**
 * Returns a new manifest with the version stamped and every `@stigmer/*`
 * range that is `*` pinned to the same version. A range that is not `*` is
 * left alone and reported by the caller: the workspace convention is `*`,
 * and a stray caret would publish a range the lockstep does not promise.
 */
export function stampManifest(manifest, version) {
  assertReleaseVersion(version);
  const stamped = { ...manifest, version };
  for (const field of DEPENDENCY_FIELDS) {
    const entries = manifest[field];
    if (!entries) continue;
    stamped[field] = Object.fromEntries(
      Object.entries(entries).map(([name, range]) => [
        name,
        name.startsWith(SCOPE) && range === "*" ? version : range,
      ]),
    );
  }
  return stamped;
}

/** Every `@stigmer/*` range in a manifest that the stamp would NOT pin. */
export function unpinnableCommonsRanges(manifest) {
  const offenders = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (name.startsWith(SCOPE) && range !== "*") offenders.push(`${field}.${name}=${range}`);
    }
  }
  return offenders;
}

export function readManifest(pkgDir) {
  return JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8"));
}

function writeManifest(pkgDir, manifest) {
  writeFileSync(join(ROOT, pkgDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * Stage one. Stamps each package, packs it, restores it. Returns the release
 * manifest (also written to dist-release/manifest.json) so the verifier and
 * the publisher read one list, in one order. The working tree is left as it
 * was found: the stamp lives only inside the tarballs, which is what lets a
 * developer run the verifier locally without dirtying their checkout.
 */
export function pack(version) {
  assertReleaseVersion(version);
  const outDir = join(ROOT, RELEASE_DIR);
  mkdirSync(outDir, { recursive: true });

  const tarballs = [];
  for (const pkgDir of PACKAGES) {
    const original = readFileSync(join(ROOT, pkgDir, "package.json"), "utf8");
    const manifest = JSON.parse(original);
    const offenders = unpinnableCommonsRanges(manifest);
    if (offenders.length > 0) {
      throw new Error(
        `${pkgDir}/package.json declares @stigmer/* ranges the lockstep cannot pin: ${offenders.join(", ")}. ` +
          `Workspace ranges must be "*" (see the header of scripts/publish-packages.mjs).`,
      );
    }

    writeManifest(pkgDir, stampManifest(manifest, version));
    let report;
    try {
      // `npm pack --json` reports the tarball name and its file list; the
      // verifier reads the list to check the `files` whitelist held.
      report = JSON.parse(
        execFileSync("npm", ["pack", "--json", "--pack-destination", outDir], {
          cwd: join(ROOT, pkgDir),
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        }),
      )[0];
    } finally {
      writeFileSync(join(ROOT, pkgDir, "package.json"), original);
    }
    tarballs.push({
      name: report.name,
      version: report.version,
      tarball: join(RELEASE_DIR, report.filename),
      files: report.files.map((f) => f.path),
    });
  }

  const releaseManifest = { version, distTag: distTagFor(version), tarballs };
  writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(releaseManifest, null, 2)}\n`);
  return releaseManifest;
}

export function readReleaseManifest() {
  return JSON.parse(readFileSync(join(ROOT, RELEASE_DIR, "manifest.json"), "utf8"));
}

/**
 * Stage two. Publishes the packed tarballs in order. Refuses a manifest
 * packed for a different version so a stale dist-release/ can never ship
 * under a new tag. Authentication is the runner's OIDC token (npm trusted
 * publishing); `--provenance` attaches the SLSA attestation binding each
 * tarball to this workflow run.
 */
export function publish(version, { dryRun = false } = {}) {
  assertReleaseVersion(version);
  const manifest = readReleaseManifest();
  if (manifest.version !== version) {
    throw new Error(
      `dist-release/manifest.json was packed for ${manifest.version}, not ${version}; run pack first`,
    );
  }
  for (const entry of manifest.tarballs) {
    const args = [
      "publish",
      join(ROOT, entry.tarball),
      "--access",
      "public",
      "--tag",
      manifest.distTag,
      "--provenance",
    ];
    if (dryRun) args.push("--dry-run");
    console.log(`publishing ${entry.name}@${entry.version} (${manifest.distTag})`);
    execFileSync("npm", args, { cwd: ROOT, stdio: "inherit" });
  }
}

function parseArgs(argv) {
  const [stage, ...rest] = argv;
  const opts = { stage, version: undefined, dryRun: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--version") opts.version = rest[++i];
    else if (rest[i] === "--dry-run") opts.dryRun = true;
    else throw new Error(`Unknown argument: ${rest[i]}`);
  }
  if (!opts.version) throw new Error("--version is required");
  return opts;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const { stage, version, dryRun } = parseArgs(process.argv.slice(2));
  if (stage === "pack") {
    const manifest = pack(version);
    for (const t of manifest.tarballs) console.log(`packed ${t.name}@${t.version} -> ${t.tarball}`);
  } else if (stage === "publish") {
    publish(version, { dryRun });
  } else {
    throw new Error(`Usage: publish-packages.mjs <pack|publish> --version X.Y.Z [--dry-run]`);
  }
}
