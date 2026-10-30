import { Interface, toBeHex } from "ethers";

// Synthetic declarations for shared registration tests, not protocol admission.
export const oracleFixtureTarget = toBeHex(301, 20);
export const oracleFixtureArgument = toBeHex(302, 20);
export const oracleFixtureAbi = new Interface(["function forward(address,bytes)"]);
export const oracleFixtureData = oracleFixtureAbi.encodeFunctionData("forward", [oracleFixtureArgument, "0x12345678"]);
export function oracleModuleFixture(adapterId: string) {
  const op = (op: string, ...args: unknown[]) => ({ op, args });
  return {
    version: 1,
    callPatterns: [{ id: "fixture-forward", signature: "forward(address,bytes)",
      candidateAddress: { from: "call-target" }, targets: [oracleFixtureTarget],
      when: op("sameAddress", "$args.0", oracleFixtureArgument),
      result: { oracle: "$args.0", payloadHash: op("codeHash", "$args.1") },
    }],
    resultChecks: [op("sameAddress", "$result.oracle", oracleFixtureArgument),
      op("eq", "$result.payloadHash", op("codeHash", "$args.1"))],
    canonicalIntakeTargets: [oracleFixtureTarget],
    runtimeDetection: { id: "fixture-oracle", affectedEdges: [{ adapterId }],
      priceProbe: { signature: "quote(address,address,uint256) view returns (uint256)",
        functionName: "quote", amountIn: "100", outputIndex: 0 }, maxSearchHops: 4 },
  };
}
