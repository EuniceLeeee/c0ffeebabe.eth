// arb-profit double-count gate: a WETH-received-then-unwrapped profit must net to
// 0 WETH (the value shows up once, as native ETH via the prestate delta). Before
// the fix, from-logs counted the WETH Transfer-in but ignored the Withdrawal, so
// the WETH holding was overstated and double-counted with the unwrapped ETH
// (0xd60d80df was priced ~$42 instead of the real ~$20).
import { actionsFromLogs } from "../actions/from-logs.js";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ACTOR = "0xe08d97e151473a848c3d9ca3f323cb720472d015";
const POOL = "0xe0554a476a092703abdb3ef35c80e0d76d32939f";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WITHDRAWAL = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65";
const amt = 13969839263635653n; // ~0.01397 WETH (the real 0xd60d80df leg)
const pad = (a: string) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();
const hex = "0x" + amt.toString(16).padStart(64, "0");

const wethDelta = (logs: unknown[]) => {
  const { rawDeltas } = actionsFromLogs({ logs }, [ACTOR]);
  return rawDeltas.find((d) => d.token.toLowerCase() === WETH.toLowerCase())?.raw ?? 0n;
};

function main() {
  let pass = true;
  const fail = (m: string) => { pass = false; console.log("FAIL: " + m); };

  // (1) received WETH then unwrapped the SAME amount -> net WETH holding = 0.
  const unwrapped = wethDelta([
    { address: WETH, logIndex: 0, topics: [TRANSFER, pad(POOL), pad(ACTOR)], data: hex },
    { address: WETH, logIndex: 1, topics: [WITHDRAWAL, pad(ACTOR)], data: hex },
  ]);
  if (unwrapped !== 0n) fail(`received+unwrapped WETH delta = ${unwrapped}, expected 0 (double-count)`);

  // (2) positive control: received WETH, kept it -> +amt.
  const kept = wethDelta([
    { address: WETH, logIndex: 0, topics: [TRANSFER, pad(POOL), pad(ACTOR)], data: hex },
  ]);
  if (kept !== amt) fail(`received-and-kept WETH delta = ${kept}, expected ${amt}`);

  // (3) wrap: actor deposits ETH -> +WETH (native ETH side captured by prestate).
  const DEPOSIT = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
  const wrapped = wethDelta([
    { address: WETH, logIndex: 0, topics: [DEPOSIT, pad(ACTOR)], data: hex },
  ]);
  if (wrapped !== amt) fail(`wrap WETH delta = ${wrapped}, expected +${amt}`);

  console.log(pass ? "\nWETH UNWRAP DELTA: PASS" : "\nWETH UNWRAP DELTA: FAIL");
  process.exit(pass ? 0 : 1);
}

main();
