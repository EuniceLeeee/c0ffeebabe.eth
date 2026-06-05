import { ADDR, KNOWN_SUCCESSFUL_ARB_TXS } from "../../shared/constants/addresses.js";

export interface VictimFixture {
  victimTxHash: string;
  blockNumber: number;
  description: string;
  expectedAffectedPool: string;
}

export const VICTIM_FIXTURES: VictimFixture[] = [
  {
    // Block 24710788 tx index 0: ordinary user swap that creates the wstUSR
    // depeg used by the reference episode. This is not the successful arb tx.
    victimTxHash: "0xc52bc6f4d29a96bc18efa09708636e9d37109918d28c52d585a5f3df1609bb22",
    blockNumber: 24710788,
    description: "Large wstUSR sell into Curve DOLA/wstUSR pool",
    expectedAffectedPool: ADDR.CURVE_DOLA_WSTUSR,
  },
];

export function assertVictimFixturesAreNotArbs(): void {
  for (const fixture of VICTIM_FIXTURES) {
    const hash = fixture.victimTxHash.toLowerCase();
    if (KNOWN_SUCCESSFUL_ARB_TXS.has(hash)) {
      throw new Error(`victim fixture is a known successful arb tx: ${hash}`);
    }
  }
}

