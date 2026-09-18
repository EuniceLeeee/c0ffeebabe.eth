import type { CreditDomainSemantics, CreditRiskProgramInput } from "../../adapter-family-plugin.js";
import { hashCanonical } from "../../canonical-value.js";
import { sameAddress } from "./codec.js";
import { fluidMaxBorrowRequest } from "./borrow-math.js";
import { assertFluidCreditRoute, fluidCreditBorrowProgram } from "./exact.js";
import type { FluidCreditDescriptor, FluidCreditRiskEvidence, FluidCreditRoute } from "./types.js";

// Fractions of the current oracle/CF ceiling, not assumed token/USD parity.
export const FLUID_CREDIT_DEBT_BPS_CANDIDATES = Object.freeze([8_500n, 9_500n, 10_000n]);
type RiskInput = CreditRiskProgramInput<FluidCreditDescriptor, FluidCreditRoute>;
const quoteInput = (input: RiskInput) => ({ ...input, amountIn: input.collateralAmount });

export const fluidCreditDomain = {
  activeBehaviorProof: "required",
  position: {
    lifecycle: "standing-position",
    finalSafety: "position-and-repayment-required",
    positionKey: ({ descriptor, route }) => hashCanonical({ familyId: descriptor.familyId,
      vault: descriptor.vault, routeKey: route.routeKey, lifecycle: route.lifecycle }),
  },
  risk: {
    debtBpsCandidates: FLUID_CREDIT_DEBT_BPS_CANDIDATES,
    blocksPrefixInversion: true,
    evidence: {
      requirements: input => fluidCreditBorrowProgram.requirements(quoteInput(input)),
      buildRequests: input => fluidCreditBorrowProgram.buildRequests(quoteInput(input)),
      buildDependentProgram: input => fluidCreditBorrowProgram.buildDependentProgram({
        ...input, programInput: quoteInput(input.programInput) }),
      decode: ({ programInput, results }) => fluidCreditBorrowProgram.decode({
        programInput: quoteInput(programInput), initialResults: results, dependentEvidence: [] }).evidence,
    },
    quoteOutputByDebtBps(input) {
      assertFluidCreditRoute(input.descriptor, input.route);
      const proof = input.evidence;
      if (!proof || proof.kind !== "fluid-credit-effect-delta-risk-proof" ||
          !sameAddress(proof.vault, input.descriptor.vault) || proof.routeKey !== input.route.routeKey ||
          proof.collateralAmount !== input.collateralAmount || proof.debtBps !== input.debtBps ||
          proof.collateralDelta !== -input.collateralAmount || proof.debtDelta !== proof.debtAmount ||
          proof.debtAmount !== fluidMaxBorrowRequest(input.collateralAmount, proof.borrowState, input.debtBps)) {
        throw new Error("fluid-credit risk quote requires compatible current oracle and operate evidence");
      }
      return proof.debtDelta;
    },
  },
} satisfies CreditDomainSemantics<FluidCreditDescriptor, FluidCreditRoute, FluidCreditRiskEvidence>;
