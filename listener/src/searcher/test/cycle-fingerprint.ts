import { canonicalTokenRing, cycleFingerprint } from "../detector/cycle-fingerprint.js";

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function assertEqual(actual: string, expected: string, msg: string): void {
  assert(actual === expected, `${msg}: expected ${expected}, got ${actual}`);
}

function assertNotEqual(actual: string, expected: string, msg: string): void {
  assert(actual !== expected, `${msg}: both were ${actual}`);
}

function assertArrayEqual(actual: readonly string[], expected: readonly string[], msg: string): void {
  assert(
    actual.length === expected.length && actual.every((value, index) => value === expected[index]),
    `${msg}: expected [${expected.join(",")}], got [${actual.join(",")}]`,
  );
}

function lowerRing(ring: readonly string[]): string[] {
  return ring.map((token) => token.toLowerCase());
}

const SOURCE_BLOCK = 24710787;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

type TestCase = {
  name: string;
  run: () => void;
};

const tests: TestCase[] = [
  {
    name: "rotation-invariant",
    run: () => {
      const base = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC, DAI]);
      assertEqual(cycleFingerprint(SOURCE_BLOCK, [USDC, DAI, WETH]), base, "B,C,A rotation");
      assertEqual(cycleFingerprint(SOURCE_BLOCK, [DAI, WETH, USDC]), base, "C,A,B rotation");
    },
  },
  {
    name: "direction-invariant",
    run: () => {
      const forward = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC, DAI]);
      const reverse = cycleFingerprint(SOURCE_BLOCK, [WETH, DAI, USDC]);
      assertEqual(reverse, forward, "forward vs reverse ring");
    },
  },
  {
    name: "case-invariant",
    run: () => {
      const mixed = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC, DAI]);
      const lower = cycleFingerprint(SOURCE_BLOCK, lowerRing([WETH, USDC, DAI]));
      assertEqual(lower, mixed, "mixed-case vs lowercase");
    },
  },
  {
    name: "distinct rings",
    run: () => {
      const abc = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC, DAI]);
      const abd = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC, USDT]);
      assertNotEqual(abd, abc, "different token ring");
    },
  },
  {
    name: "sourceBlock identity",
    run: () => {
      const current = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC, DAI]);
      const next = cycleFingerprint(SOURCE_BLOCK + 1, [WETH, USDC, DAI]);
      assertNotEqual(next, current, "different sourceBlock");
    },
  },
  {
    name: "canonicalTokenRing variants and immutability",
    run: () => {
      const variants = [
        [WETH, USDC, DAI],
        [USDC, DAI, WETH],
        [DAI, WETH, USDC],
        [WETH, DAI, USDC],
        [DAI, USDC, WETH],
        [USDC, WETH, DAI],
      ];
      const expected = lowerRing([DAI, USDC, WETH]);
      for (const variant of variants) {
        assertArrayEqual(canonicalTokenRing(variant), expected, `canonical ${variant.join(" -> ")}`);
      }

      const frozen = Object.freeze([WETH, USDC, DAI]);
      const before = [...frozen];
      assertArrayEqual(canonicalTokenRing(frozen), expected, "canonical frozen input");
      assertArrayEqual(frozen, before, "caller input should not mutate");
    },
  },
  {
    name: "2-cycle realistic WETH/USDC",
    run: () => {
      const wethUsdc = cycleFingerprint(SOURCE_BLOCK, [WETH, USDC]);
      const usdcWeth = cycleFingerprint(SOURCE_BLOCK, [USDC, WETH]);
      assertEqual(usdcWeth, wethUsdc, "2-cycle rotation/direction");
      assertArrayEqual(canonicalTokenRing([WETH, USDC]), lowerRing([USDC, WETH]), "2-cycle canonical ring");
      assertEqual(
        wethUsdc,
        "0xf27ff232f4ba137fa2e3a23e17da0f3e7e344a525867e478d519093a8d5cd95e",
        "2-cycle stable fingerprint",
      );
    },
  },
];

let passed = 0;

for (const test of tests) {
  try {
    test.run();
    passed += 1;
    console.log(`[cycle-fingerprint] ${test.name}: PASS`);
  } catch (err) {
    console.error(`[cycle-fingerprint] ${test.name}: FAIL`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`cycle-fingerprint FAIL (${passed}/${tests.length})`);
    process.exit(1);
  }
}

console.log(`cycle-fingerprint PASS (${passed}/${tests.length})`);
