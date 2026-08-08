import type {
  CreditDomainSemantics,
  CreditRiskProgramInput,
} from "../../adapter-family-plugin.js";
import type {
  AdapterRequestResult,
} from "../../adapter-request-program.js";
import { hashCanonical } from "../../canonical-value.js";
import {
  assertSource,
  decodeOperateResult,
  FLUID_ERC20_INTERFACE,
  FLUID_VAULT_INTERFACE,
  fluidDebtAmount,
  requireSuccessfulResult,
  sameAddress,
  tokenDelta,
} from "./codec.js";
import type {
  FluidCreditDescriptor,
  FluidCreditRiskEvidence,
  FluidCreditRoute,
} from "./types.js";

const RISK_OPERATE_ID = "risk-operate-effect-proof";
export const FLUID_CREDIT_DEBT_BPS_CANDIDATES = Object.freeze([
  8_500n,
  9_500n,
  10_000n,
  10_400n,
  10_800n,
  11_200n,
]);

export const fluidCreditDomain = {
  activeBehaviorProof: "required",
  position: {
    lifecycle: "standing-position",
    finalSafety: "position-and-repayment-required",
    positionKey: ({ descriptor, route }) => hashCanonical({
      familyId: descriptor.familyId,
      vault: descriptor.vault,
      routeKey: route.routeKey,
      lifecycle: route.lifecycle,
    }),
  },
  risk: {
    debtBpsCandidates: FLUID_CREDIT_DEBT_BPS_CANDIDATES,
    blocksPrefixInversion: true,
    evidence: {
      requirements: () => ({
        transports: ["effect-delta-simulation"],
        caller: "executor",
        effects: ["return-data", "token-delta"],
      }),
      buildRequests(input) {
        assertRiskInput(input);
        const debtAmount = quoteDebt(input);
        return Object.freeze([Object.freeze({
          id: RISK_OPERATE_ID,
          kind: "effect-delta-simulation" as const,
          preCalls: Object.freeze([Object.freeze({
            caller: Object.freeze({ kind: "executor" as const }),
            to: input.descriptor.supplyToken,
            data: FLUID_ERC20_INTERFACE.encodeFunctionData("approve", [
              input.descriptor.vault,
              input.collateralAmount,
            ]),
          })]),
          call: Object.freeze({
            caller: Object.freeze({ kind: "executor" as const }),
            to: input.descriptor.vault,
            data: FLUID_VAULT_INTERFACE.encodeFunctionData("operate", [
              0n,
              input.collateralAmount,
              debtAmount,
              input.executor,
            ]),
          }),
          overrideIntent: Object.freeze({
            caller: Object.freeze({ kind: "executor" as const }),
            tokenBalances: Object.freeze([Object.freeze({
              token: input.descriptor.supplyToken,
              amount: input.collateralAmount,
            })]),
          }),
          observe: Object.freeze(["return-data" as const, "token-delta" as const]),
        })]);
      },
      decode({ programInput, results }) {
        assertRiskInput(programInput);
        return decodeRiskEvidence(programInput, results);
      },
    },
    quoteOutputByDebtBps(input) {
      assertRiskInput(input);
      const amountOut = quoteDebt(input);
      if (input.evidence !== undefined) {
        assertRiskEvidence(input, amountOut);
      }
      return amountOut;
    },
  },
} satisfies CreditDomainSemantics<
  FluidCreditDescriptor,
  FluidCreditRoute,
  FluidCreditRiskEvidence
>;

function decodeRiskEvidence(
  input: CreditRiskProgramInput<FluidCreditDescriptor, FluidCreditRoute>,
  results: readonly AdapterRequestResult[],
): FluidCreditRiskEvidence {
  const result = requireSuccessfulResult(results, RISK_OPERATE_ID);
  assertSource(result.source, input.source);
  const debtAmount = quoteDebt(input);
  const operate = decodeOperateResult(result.data);
  const collateralDelta = tokenDelta(
    result,
    input.descriptor.supplyToken,
    input.executor,
  );
  const debtDelta = tokenDelta(
    result,
    input.descriptor.borrowToken,
    input.executor,
  );
  if (
    operate.nftId <= 0n ||
    operate.finalSupply <= 0n ||
    operate.finalBorrow <= 0n ||
    collateralDelta !== -input.collateralAmount ||
    debtDelta !== debtAmount
  ) {
    throw new Error("fluid-credit risk simulation did not prove standing position effects");
  }
  return Object.freeze({
    kind: "fluid-credit-effect-delta-risk-proof" as const,
    source: result.source,
    vault: input.descriptor.vault,
    routeKey: input.route.routeKey,
    executor: input.executor,
    collateralAmount: input.collateralAmount,
    debtBps: input.debtBps,
    debtAmount,
    nftId: operate.nftId,
    finalSupply: operate.finalSupply,
    finalBorrow: operate.finalBorrow,
    collateralDelta,
    debtDelta,
  });
}

function quoteDebt(input: {
  readonly descriptor: FluidCreditDescriptor;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
}): bigint {
  return fluidDebtAmount({
    collateralAmount: input.collateralAmount,
    debtBps: input.debtBps,
    supplyDecimals: input.descriptor.supplyDecimals,
    borrowDecimals: input.descriptor.borrowDecimals,
  });
}

function assertRiskInput(input: {
  readonly descriptor: FluidCreditDescriptor;
  readonly route: FluidCreditRoute;
  readonly collateralAmount: bigint;
  readonly debtBps: bigint;
  readonly executor?: string;
}): void {
  if (
    input.route.instanceKey !== input.descriptor.instanceKey ||
    !sameAddress(input.route.vault, input.descriptor.vault) ||
    !sameAddress(input.route.tokenIn, input.descriptor.supplyToken) ||
    !sameAddress(input.route.tokenOut, input.descriptor.borrowToken) ||
    input.route.lifecycle !== "standing-position"
  ) {
    throw new Error("fluid-credit risk route does not match descriptor");
  }
  if (input.collateralAmount < 0n || input.debtBps < 0n) {
    throw new Error("fluid-credit risk inputs cannot be negative");
  }
  if (
    input.executor !== undefined &&
    !/^0x[0-9a-fA-F]{40}$/.test(input.executor)
  ) {
    throw new Error("fluid-credit risk executor is invalid");
  }
}

function assertRiskEvidence(
  input: {
    readonly descriptor: FluidCreditDescriptor;
    readonly route: FluidCreditRoute;
    readonly collateralAmount: bigint;
    readonly debtBps: bigint;
    readonly evidence?: FluidCreditRiskEvidence;
  },
  amountOut: bigint,
): void {
  const evidence = input.evidence;
  if (
    evidence === undefined ||
    evidence.kind !== "fluid-credit-effect-delta-risk-proof" ||
    !sameAddress(evidence.vault, input.descriptor.vault) ||
    evidence.routeKey !== input.route.routeKey ||
    evidence.collateralAmount !== input.collateralAmount ||
    evidence.debtBps !== input.debtBps ||
    evidence.debtAmount !== amountOut
  ) {
    throw new Error("fluid-credit risk quote received incompatible evidence");
  }
}
