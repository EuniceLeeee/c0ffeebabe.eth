import type {
  CompiledInstanceDescriptor,
  FamilyCandidate,
  FamilyRouteDescriptor,
  VerifiedIdentity,
} from "../../adapter-family-plugin.js";
import type { CanonicalSource } from "../../adapter-request-program.js";

export interface Candidate extends FamilyCandidate {
  readonly candidateKind: "ammalgam-pair";
  readonly pair: string;
}

/**
 * Static binding proven by identity. `proxyCodeHash` pins the Ammalgam
 * `PairBeaconProxy` runtime and `implementationCodeHash` pins the verified
 * `AmmalgamPair` implementation currently installed on the beacon. `tokenX`
 * and `tokenY` are the pair's own `underlyingTokens()` order, which is the
 * order used by `swap(amountXOut, amountYOut, to, data)`.
 */
export interface Binding {
  readonly pair: string;
  readonly beacon: string;
  readonly implementation: string;
  readonly proxyCodeHash: string;
  readonly implementationCodeHash: string;
  readonly tokenX: string;
  readonly tokenY: string;
  readonly decimalsX: bigint;
  readonly decimalsY: bigint;
}

export interface Identity extends VerifiedIdentity {
  readonly facts: Binding;
}

export interface Descriptor extends CompiledInstanceDescriptor, Binding {}

export interface Route extends FamilyRouteDescriptor {
  readonly pair: string;
  readonly xForY: boolean;
}

/** Complete swap-relevant pair state at the source block. */
export interface State {
  readonly source: CanonicalSource;
  readonly reserves: readonly [bigint, bigint];
  readonly references: readonly [bigint, bigint];
  /** Ammalgam token-controller asset totals in token-type order:
   *  [DEPOSIT_L, DEPOSIT_X, DEPOSIT_Y, BORROW_L, BORROW_X, BORROW_Y]. */
  readonly assets: readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  readonly balances: readonly [bigint, bigint];
  readonly lastUpdateTimestamp: bigint;
}

export interface Evidence {
  readonly kind: "ammalgam-pair-execution";
  readonly source: CanonicalSource;
  readonly binding: string;
  readonly routeKey: Route["routeKey"];
  readonly executor: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
}
