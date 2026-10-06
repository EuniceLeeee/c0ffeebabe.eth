import assert from "node:assert/strict";
import { ClientRequest } from "node:http";
import test from "node:test";
import { postJsonRpc } from "../../shared/state/state-backend.js";

test("aborted RPC owns late request errors without changing its rejection", async t => {
  let request: ClientRequest | undefined;
  t.mock.method(ClientRequest.prototype, "end", function (this: ClientRequest) {
    request = this;
    return this;
  });
  const controller = new AbortController();
  const reason = new Error("owned cancellation");
  const call = postJsonRpc("http://127.0.0.1:1", {
    jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [],
  }, controller.signal);
  assert(request);
  try {
    controller.abort(reason);
    await assert.rejects(call, error => error === reason);
    // A cancelled request and its TLS/socket teardown may both emit error.
    // Settlement is once-only; event ownership must last through teardown.
    request.emit("error", reason);
    assert.doesNotThrow(() => request!.emit("error", new Error("late socket error")));
  } finally {
    // Also drain the synthetic socket when the baseline assertion fails.
    request.on("error", () => {});
    request.destroy();
  }
});
