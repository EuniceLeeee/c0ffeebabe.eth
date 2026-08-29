export type EconomicSafetyPolicyRejectionCodeV1 =
  | "quoted-gain-not-positive"
  | "quoted-gain-below-minimum"
  | "value-at-risk-exceeded"
  | "declared-gas-exceeded"
  | "net-profit-not-positive";

export class EconomicSafetyPolicyRejectionErrorV1 extends Error {
  readonly name = "EconomicSafetyPolicyRejectionErrorV1";
  readonly code: EconomicSafetyPolicyRejectionCodeV1;

  constructor(code: EconomicSafetyPolicyRejectionCodeV1) {
    super(code);
    this.code = code;
  }
}
