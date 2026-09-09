// Tests for the pure half of scripts/publish-packages.mjs. Run via
// `node --test scripts/*.test.mjs` (wired into the root `npm test`).
//
// What these guard: the lockstep pin. A published @stigmer/identity must
// depend on exactly the @stigmer/resource-api it was built against, and the
// pre-release/dist-tag inference must never let `latest` point at an rc.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEV_VERSION,
  PACKAGES,
  ROOT,
  assertReleaseVersion,
  distTagFor,
  stampManifest,
  unpinnableCommonsRanges,
} from "./publish-packages.mjs";

test("PACKAGES publishes resource-api before identity, which peers on it", () => {
  assert.ok(
    PACKAGES.indexOf("packages/resource-api") < PACKAGES.indexOf("packages/identity"),
    "identity's peer must already be on the registry when identity publishes",
  );
});

test("every workspace manifest carries the dev sentinel and only `*` commons ranges", () => {
  // The lane stamps in place, so the committed manifests must be in the
  // shape the stamp expects; a stray caret would publish a range the
  // lockstep does not promise.
  for (const pkgDir of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, pkgDir, "package.json"), "utf8"));
    assert.equal(manifest.version, DEV_VERSION, `${pkgDir} version must be the ${DEV_VERSION} sentinel`);
    assert.deepEqual(unpinnableCommonsRanges(manifest), [], `${pkgDir} has non-* @stigmer/* ranges`);
    assert.equal(manifest.publishConfig?.access, "public", `${pkgDir} must publish public`);
    assert.equal(manifest.publishConfig?.provenance, true, `${pkgDir} must publish with provenance`);
  }
});

test("stampManifest sets the version and pins `*` commons ranges in every dependency field", () => {
  const stamped = stampManifest(
    {
      name: "@stigmer/identity",
      version: DEV_VERSION,
      dependencies: { pg: "^8.22.0", "@stigmer/other": "*" },
      peerDependencies: { "@stigmer/resource-api": "*" },
      optionalDependencies: { "@stigmer/optional": "*" },
    },
    "0.6.0",
  );
  assert.equal(stamped.version, "0.6.0");
  assert.equal(stamped.dependencies.pg, "^8.22.0", "third-party ranges are untouched");
  assert.equal(stamped.dependencies["@stigmer/other"], "0.6.0");
  assert.equal(stamped.peerDependencies["@stigmer/resource-api"], "0.6.0");
  assert.equal(stamped.optionalDependencies["@stigmer/optional"], "0.6.0");
});

test("stampManifest leaves a non-* commons range alone and unpinnableCommonsRanges names it", () => {
  const manifest = { name: "x", version: DEV_VERSION, dependencies: { "@stigmer/resource-api": "^0.5.0" } };
  assert.equal(stampManifest(manifest, "0.6.0").dependencies["@stigmer/resource-api"], "^0.5.0");
  assert.deepEqual(unpinnableCommonsRanges(manifest), ["dependencies.@stigmer/resource-api=^0.5.0"]);
});

test("stampManifest does not mutate its input", () => {
  const manifest = { name: "x", version: DEV_VERSION, peerDependencies: { "@stigmer/resource-api": "*" } };
  stampManifest(manifest, "0.6.0");
  assert.equal(manifest.version, DEV_VERSION);
  assert.equal(manifest.peerDependencies["@stigmer/resource-api"], "*");
});

test("distTagFor sends pre-releases to next and releases to latest", () => {
  assert.equal(distTagFor("0.6.0-rc.1"), "next");
  assert.equal(distTagFor("0.6.0"), "latest");
  assert.equal(distTagFor("1.0.0-beta.2"), "next");
});

test("assertReleaseVersion refuses a leading v, a partial version and garbage", () => {
  assert.equal(assertReleaseVersion("0.6.0"), "0.6.0");
  assert.equal(assertReleaseVersion("0.6.0-rc.1"), "0.6.0-rc.1");
  for (const bad of ["v0.6.0", "0.6", "latest", "", "0.6.0 "]) {
    assert.throws(() => assertReleaseVersion(bad), /Not a release version/, `"${bad}" must be refused`);
  }
});
