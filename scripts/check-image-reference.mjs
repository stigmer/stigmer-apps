/**
 * Image-reference guard — the registry path of the law backend image is
 * a wire contract that lives in three places: the CI workflow that
 * pushes it, the chart default that pulls it, and every firm's private
 * values file in stigmer-cloud (which pins an exact sha of it). Nobody
 * reviews those files together, and a rename in one place surfaces only
 * as an image-pull failure during a production install.
 *
 * This guard covers the two copies in this repo: it reads the
 * `image_repo` default out of the chart's values.yaml and asserts that
 * exact literal appears in the CI workflow. (The private values files
 * cannot be checked from here; they follow the chart default.)
 *
 * The workflow hardcodes the literal — never derives it from
 * github.repository — precisely so this check, and anyone grepping
 * across repos, can find it.
 */

import { readFileSync } from "node:fs";

const CHART_VALUES =
  "apps/law/deploy/infra-charts/stigmer-law-firm-stack/values.yaml";
const WORKFLOW = ".github/workflows/ci.yml";

function chartImageRepo(paramName) {
  const lines = readFileSync(CHART_VALUES, "utf8").split("\n");
  const nameIdx = lines.findIndex((l) =>
    new RegExp(`^\\s*-\\s*name:\\s*${paramName}\\s*$`).test(l),
  );
  if (nameIdx === -1) {
    console.error(`FAIL: no "- name: ${paramName}" entry found in ${CHART_VALUES}`);
    process.exit(1);
  }
  // The value: line belongs to this list item — stop at the next item.
  for (let i = nameIdx + 1; i < lines.length && !/^\s*-\s*name:/.test(lines[i]); i++) {
    const match = lines[i].match(/^\s*value:\s*(\S+)\s*$/);
    if (match) return match[1];
  }
  console.error(`FAIL: ${paramName} in ${CHART_VALUES} has no value: line`);
  process.exit(1);
}

// Every image the chart pulls must be one CI pushes: the backend (per
// commit) and the FGA engine wrapper (per engine version — DD-003).
const workflow = readFileSync(WORKFLOW, "utf8");
for (const paramName of ["image_repo", "openfga_image_repo"]) {
  const imageRepo = chartImageRepo(paramName);
  if (!workflow.includes(imageRepo)) {
    console.error(
      `Image-reference guard failed:\n` +
        `  The chart default (${CHART_VALUES}, ${paramName}) says firms pull\n` +
        `    ${imageRepo}\n` +
        `  but that literal does not appear in ${WORKFLOW}.\n` +
        `  Every firm's private values file pins tags under the chart default;\n` +
        `  if CI pushes somewhere else, firm installs break at pull time.\n` +
        `  Fix whichever side is wrong — they must name the same repository.`,
    );
    process.exit(1);
  }
  console.log(`Image-reference guard passed: CI pushes ${imageRepo}.`);
}
