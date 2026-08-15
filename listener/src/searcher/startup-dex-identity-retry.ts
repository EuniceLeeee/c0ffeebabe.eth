import type {
  AttestedPoolEntry,
  IdentityPoolEntry,
  RejectedPoolIdentity,
} from "./venues/identity.js";

export interface StartupDexIdentityRetryState<T extends IdentityPoolEntry> {
  readonly accepted: readonly AttestedPoolEntry<T>[];
  readonly remaining: readonly T[];
}

export interface StartupDexPermanentIdentityRejection<T extends IdentityPoolEntry> {
  readonly candidate: T;
  readonly rejection: RejectedPoolIdentity;
}

export interface StartupDexIdentityRetryStage<T extends IdentityPoolEntry>
  extends StartupDexIdentityRetryState<T> {
  readonly sourceBlock: number;
  readonly permanentlyRejected: readonly StartupDexPermanentIdentityRejection<T>[];
}