import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("blocked route-telemetry test worker requires parentPort");
}
const port = parentPort;

port.postMessage({ type: "ready", enabled: true });

// Intentionally retain every batch without acknowledging it. The parent-side
// credit accounting and bounded shutdown must remain fail-open under this
// condition.
port.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "shutdown"
  ) {
    port.postMessage({ type: "shutdown-complete" });
    port.close();
  }
});
