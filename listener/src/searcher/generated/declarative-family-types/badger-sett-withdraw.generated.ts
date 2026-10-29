// Generated from Family JSON type metadata. Do not edit.
// Type schema SHA-256: 7fa332c9ce7e01b903860d0072fbabc94b6159bbf4b8eac6eed12318204e9f9a
import type { InstanceKey } from "../../venues/adapter-family-identifiers.js";
import type { CompiledInstanceDescriptor, FamilyCandidate, FamilyRouteDescriptor, VerifiedIdentity } from "../../venues/adapter-family-plugin.js";
import type { CanonicalSource } from "../../venues/adapter-request-program.js";

export type BadgerBinding = BadgerRootBinding & {
  readonly strategyImplementation: string;
  readonly strategyAdmin: string;
  readonly locker: string;
};

export type BadgerCandidate = FamilyCandidate & {
  readonly candidateKind: "badger-sett-withdraw";
  readonly vault: string;
};

export type BadgerDescriptor = CompiledInstanceDescriptor & {
  readonly vault: string;
  readonly vaultImplementation: string;
  readonly vaultAdmin: string;
  readonly strategy: string;
  readonly strategyImplementation: string;
  readonly strategyAdmin: string;
  readonly asset: string;
  readonly locker: string;
};

export type BadgerExactEvidence = {
  readonly kind: "badger-sett-liquid-local";
  readonly source: CanonicalSource;
  readonly fingerprint: string;
  readonly routeKey: string;
  readonly executor: string;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
};

export type BadgerIdentity = VerifiedIdentity & {
  readonly binding: BadgerBinding;
};

export type BadgerIdentityEvidence = {
  readonly phase: ("root") | ("strategy") | ("complete") | ("unavailable");
  readonly source?: CanonicalSource;
  readonly root?: BadgerRootBinding;
  readonly binding?: BadgerBinding;
  readonly reason?: string;
};

export type BadgerPricingDescriptor = BadgerPricingDraft & BadgerPricingStatic & {

};

export type BadgerPricingDraft = {
  readonly instanceKey: InstanceKey;
  readonly routes: ReadonlyArray<BadgerRoute>;
};

export type BadgerPricingStatic = {

};

export type BadgerRootBinding = {
  readonly vault: string;
  readonly vaultImplementation: string;
  readonly vaultAdmin: string;
  readonly asset: string;
  readonly strategy: string;
};

export type BadgerRoute = FamilyRouteDescriptor & {
  readonly target: string;
  readonly direction: "redeem";
  readonly adapterId: "badger-sett-withdraw";
};

export type FamilyTypes = {
  readonly candidate: BadgerCandidate;
  readonly identityEvidence: BadgerIdentityEvidence;
  readonly identity: BadgerIdentity;
  readonly descriptor: BadgerDescriptor;
  readonly route: BadgerRoute;
  readonly pricingDraft: BadgerPricingDraft;
  readonly pricingDescriptor: BadgerPricingDescriptor;
  readonly pricingStatic: BadgerPricingStatic;
  readonly exactEvidence: BadgerExactEvidence;
};
