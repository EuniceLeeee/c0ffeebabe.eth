const FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES = Object.freeze([
  "BASH_ENV", "ENV",
  "LD_AUDIT", "LD_DEBUG", "LD_DEBUG_OUTPUT", "LD_LIBRARY_PATH", "LD_PRELOAD", "LD_PROFILE",
  "NODE_EXTRA_CA_CERTS", "NODE_OPTIONS", "NODE_PATH",
  "OPENSSL_CONF", "OPENSSL_ENGINES", "OPENSSL_MODULES",
  "OWNER_PRIVATE_KEY", "PRIVATE_KEY", "SSL_CERT_DIR", "SSL_CERT_FILE",
]);

export function assertInstalledProductionRuntimeEnvironmentV1(): void {
  for (const name of Object.keys(process.env)) {
    if (FORBIDDEN_RUNTIME_ENVIRONMENT_NAMES.includes(name)
      || name.startsWith("DYLD_")
      || name.startsWith("GIT_")) {
      throw new TypeError(`forbidden runtime environment ${name}`);
    }
  }
}
