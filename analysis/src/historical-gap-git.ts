import { execFileSync } from "node:child_process";

const SHA40_RE = /^[a-f0-9]{40}$/i;

export function cloneHistoricalGapValidationRoot(
  sourceRepository: string,
  destination: string,
  checkoutCommit: string,
  requiredCommits: string[],
  environment: NodeJS.ProcessEnv,
): void {
  const commits = [...new Set([checkoutCommit, ...requiredCommits])];
  if (commits.some((commit) => !SHA40_RE.test(commit))) {
    throw new Error("historical validation clone requires exact commit SHAs");
  }
  execFileSync("git", ["clone", "--no-local", "--no-checkout", "--quiet", sourceRepository, destination], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  execFileSync("git", [
    "-C", destination,
    "fetch", "--no-tags", "--quiet", "--no-write-fetch-head",
    sourceRepository,
    ...commits,
  ], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
  execFileSync("git", ["-C", destination, "checkout", "--detach", "--quiet", checkoutCommit], {
    env: environment,
    stdio: ["ignore", "ignore", "pipe"],
  });
}
