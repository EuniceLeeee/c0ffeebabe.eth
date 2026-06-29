const sub = process.argv[2];
if (sub === "address") {
  await import("./address.js");
} else if (sub === "live-loss") {
  await import("./live-loss.js");
} else if (sub === "redact-live-run") {
  await import("./redact-live-run.js");
} else {
  console.error("Usage: pnpm analysis <address|live-loss|redact-live-run> ...");
  process.exit(1);
}
