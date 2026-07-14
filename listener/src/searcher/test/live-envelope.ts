import { validateLiveEnvelope, type LiveEnvelopeInput } from "../live-envelope.js";

const WALLET = "0x0000000000000000000000000000000000000001";
const BOTVM = "0x0000000000000000000000000000000000000002";
const OTHER = "0x0000000000000000000000000000000000000003";

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${message}`);
}

async function expectReject(
  input: LiveEnvelopeInput,
  reason: string,
  owner = WALLET,
  balance = 1n,
): Promise<void> {
  try {
    await validateLiveEnvelope(input, {
      walletBalance: async () => balance,
      botvmOwner: async () => owner,
    });
  } catch (err) {
    assert(String(err).includes(reason), `expected ${reason}, got ${String(err)}`);
    return;
  }
  throw new Error(`FAIL: expected rejection containing ${reason}`);
}

const live: LiveEnvelopeInput = {
  dryRun: false,
  evGate: true,
  walletAddress: WALLET,
  botvmAddress: BOTVM,
  configuredBotvmOwner: WALLET,
  maxWalletEth: "0.2",
};

await validateLiveEnvelope(live, {
  walletBalance: async () => 1n,
  botvmOwner: async () => WALLET,
});
await expectReject({ ...live, evGate: false }, "SEARCHER_EV_GATE=1");
await expectReject({ ...live, configuredBotvmOwner: undefined }, "BOTVM_OWNER");
await expectReject({ ...live, configuredBotvmOwner: OTHER }, "does not match BOTVM_OWNER");
await expectReject({ ...live, maxWalletEth: "0.200000000000000001" }, "no greater than 0.2 ETH");
await expectReject(live, "is not BotVM owner", OTHER);
await expectReject(live, "exceeds cap", WALLET, 200000000000000001n);

await validateLiveEnvelope({ ...live, dryRun: true, evGate: false }, {
  walletBalance: async () => { throw new Error("dry-run must not probe balance"); },
  botvmOwner: async () => { throw new Error("dry-run must not probe owner"); },
});

console.log("live-envelope PASS (8/8)");
