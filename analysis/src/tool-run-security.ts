const SECRET_ARG_NAME = /(?:^|[-_])(?:rpc(?:[-_]url)?|provider[-_]url|url|endpoint|api[-_]?key|private[-_]?key|secret|password|passwd|credential|auth|access[-_]token|auth[-_]token|bearer[-_]token)$/i;
const LOOPBACK_URL_ARG_NAME = /^(?:rpc(?:-url)?|provider-url)$/i;
const SECRET_ENV_NAME = /(?:^|[-_])(?:key|token|secret|password|passwd|credential|auth|rpc|url)(?:$|[-_])/i;
const SECRET_QUERY_NAME = /(?:key|token|secret|password|credential|auth|rpc|url)/i;
const REMOTE_URL = /(?:https?|wss?):\/\/[^\s"'`<>]+/gi;

/** Tool evidence must never put RPC credentials in argv, where npm/process logs can expose them. */
export function assertNoSecretBearingToolArgs(args: readonly string[]): void {
  for (let index = 0; index < args.length; index++) {
    const entry = args[index];
    const equalsAt = entry.indexOf("=");
    const name = equalsAt >= 0 ? entry.slice(0, equalsAt) : entry;
    const normalizedName = normalizeArgName(name);
    const argumentValue = equalsAt >= 0 ? entry.slice(equalsAt + 1) : (args[index + 1] ?? "");
    if (
      name.startsWith("-")
      && SECRET_ARG_NAME.test(normalizedName)
      && !isAllowedLoopbackArgument(normalizedName, argumentValue)
    ) {
      throw new Error(
        `tool-run forbids secret-bearing argument ${name}; use an environment variable, restricted file, or FD`,
      );
    }
    if (containsRemoteUrl(entry)) {
      throw new Error("tool-run forbids remote URLs in argv; use an environment variable, restricted file, or FD");
    }
  }
}

export function redactToolArgv(input: readonly string[], offset = 0): string[] {
  return input.map((entry, index) => {
    const previous = input[index - 1] ?? "";
    const previousName = normalizeArgName(previous);
    if (
      index > offset
      && SECRET_ARG_NAME.test(previousName)
      && !isAllowedLoopbackArgument(previousName, entry)
    ) return "<redacted>";
    const equalsAt = entry.indexOf("=");
    if (equalsAt > 0) {
      const name = entry.slice(0, equalsAt);
      const value = entry.slice(equalsAt + 1);
      const normalizedName = normalizeArgName(name);
      if (SECRET_ARG_NAME.test(normalizedName)) {
        return isAllowedLoopbackArgument(normalizedName, value)
          ? entry
          : `${name}=<redacted>`;
      }
    }
    return redactRemoteUrls(entry);
  });
}

function normalizeArgName(input: string): string {
  return input
    .replace(/^-+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function isAllowedLoopbackArgument(name: string, value: string): boolean {
  return LOOPBACK_URL_ARG_NAME.test(name) && isLoopbackUrl(value);
}

/** Sanitize child output before forwarding it to the terminal; receipts retain only hashes and sizes. */
export function redactToolOutput(
  input: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  let output = redactRemoteUrls(input);
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    output = output.split(value).join("<redacted-env>");
    for (const credential of secretFragments(value)) {
      output = output.split(credential).join("<redacted-env-fragment>");
    }
  }
  return output;
}

function redactRemoteUrls(input: string): string {
  return input.replace(REMOTE_URL, (candidate) => isLoopbackUrl(candidate) ? candidate : "<redacted-url>");
}

function containsRemoteUrl(input: string): boolean {
  const candidates = input.match(REMOTE_URL) ?? [];
  return candidates.some((candidate) => !isLoopbackUrl(candidate));
}

function secretFragments(value: string): string[] {
  const fragments = new Set<string>();
  try {
    const parsed = new URL(value);
    for (const candidate of [parsed.username, parsed.password]) {
      if (candidate.length >= 8) fragments.add(candidate);
    }
    for (const [name, candidate] of parsed.searchParams) {
      if (SECRET_QUERY_NAME.test(name) && candidate.length >= 8) fragments.add(candidate);
    }
    for (const segment of parsed.pathname.split("/")) {
      if (segment.length >= 8 && !/^(?:mainnet|ethereum)$/i.test(segment)) fragments.add(segment);
    }
  } catch {
    // A non-URL secret is already replaced as one complete environment value.
  }
  return [...fragments];
}

function isLoopbackUrl(input: string): boolean {
  try {
    const parsed = new URL(input);
    return isLoopbackHost(parsed.hostname)
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.pathname === "/"
      && parsed.search.length === 0
      && parsed.hash.length === 0;
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
