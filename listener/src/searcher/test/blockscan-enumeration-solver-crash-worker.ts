import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("crashing route-telemetry test worker requires parentPort");
}
const port = parentPort;

port.postMessage({ type: "ready", enabled: true });
port.on("message", (message: unknown) => {
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === "batch"
  ) {
    throw new Error("intentional route-telemetry worker crash");
  }
});
