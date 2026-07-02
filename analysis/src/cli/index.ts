const sub = process.argv[2];
if (sub === "address") {
  await import("./address.js");
} else if (sub === "live-loss") {
  await import("./live-loss.js");
} else if (sub === "redact-live-run") {
  await import("./redact-live-run.js");
} else if (sub === "hermes-gate") {
  process.argv.splice(2, 1); // drop "hermes-gate" so the md path is argv[2]
  await import("./hermes-gate.js");
} else {
  console.error("Usage: pnpm analysis <address|live-loss|redact-live-run|hermes-gate> ...");
  process.exit(1);
}
