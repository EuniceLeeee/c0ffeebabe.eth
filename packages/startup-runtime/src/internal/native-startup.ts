import { hashSchema, type Hash } from "../../../canonical-codec/src/index.ts";
import {
  decodeNativeStartupGenerationIdentityV1,
  type NativeStartupAuthorityProjectionV1,
  type NativeStartupOwnerPortV1,
  type NativeStartupGenerationHandleV1,
  type NativeStartupGenerationIdentityV1,
  type NativeStartupLoadedGenerationV1,
  type NativeStartupPromotionRequestV1,
} from "./native-startup-contract.ts";

function decimal(value: string, context: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new TypeError(`${context} is not a canonical decimal`);
  return BigInt(value);
}

export function nativeStartupAuthoritiesEqual(
  left: NativeStartupAuthorityProjectionV1,
  right: NativeStartupAuthorityProjectionV1,
): boolean {
  return left.authorityClass === right.authorityClass
    && left.runtimeInstanceId === right.runtimeInstanceId
    && left.runtimeLineageRoot === right.runtimeLineageRoot
    && left.implementationCommit === right.implementationCommit;
}

export function pinNativeStartupAuthority(
  current: NativeStartupAuthorityProjectionV1 | null,
  next: NativeStartupAuthorityProjectionV1,
): NativeStartupAuthorityProjectionV1 {
  if (current === null) return Object.freeze({ ...next });
  if (!nativeStartupAuthoritiesEqual(current, next)) {
    throw new Error("startup-generation-authority-changed");
  }
  return current;
}

export type NativeStartupPromotionRecoveryV1 = "keep-closed" | "reopen-current" | "load-current";

export function classifyNativeStartupPromotionRecovery(
  previousRecordRoot: Hash | null,
  currentRecordRoot: Hash | null,
  hasActiveGeneration: boolean,
): NativeStartupPromotionRecoveryV1 {
  if (currentRecordRoot === null) return "keep-closed";
  if (currentRecordRoot === previousRecordRoot) {
    return hasActiveGeneration ? "reopen-current" : "keep-closed";
  }
  return "load-current";
}

export interface NativeStartupServingGenerationV1 extends NativeStartupGenerationIdentityV1 {
  readonly handle: NativeStartupGenerationHandleV1;
}

export interface NativeStartupRuntimeV1<Observation extends object, Session extends object> {
  readonly activeGeneration: NativeStartupServingGenerationV1;
  readonly generationId: string;
  readonly graphRoot: Hash;
  readActiveGeneration(): NativeStartupServingGenerationV1;
  readServingGeneration(generationId: string): NativeStartupServingGenerationV1;
  readProducerSessionGeneration(session: object): NativeStartupServingGenerationV1;
  withProducerSession<Result>(
    headObservation: Observation,
    run: (session: Session) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result>;
  waitForGenerationIdle(): Promise<void>;
  close(): Promise<void>;
}

function servingGeneration(generation: NativeStartupLoadedGenerationV1): NativeStartupServingGenerationV1 {
  return Object.freeze({
    ...generation.identity,
    handle: generation.handle,
  });
}

/**
 * The single native startup/session state machine. It knows only owner-issued
 * generation handles and neutral lineage. Source-specific implementation
 * records remain closed inside the exact adapter.
 */
export async function runNativeStartupStateMachineForExactAdapter<
  Observation extends object,
  Lease extends object,
  Session extends object,
>(
  owner: NativeStartupOwnerPortV1<Observation, Lease, Session>,
  signal: AbortSignal,
): Promise<NativeStartupRuntimeV1<Observation, Session>> {
  let closed = false;
  let promotionClosed = false;
  let sessionOpening = false;
  let activeSession: Session | null = null;
  let activeLease: Lease | null = null;
  let activeGeneration: NativeStartupLoadedGenerationV1 | null = null;
  let pinnedAuthority: NativeStartupAuthorityProjectionV1 | null = null;
  const servedGenerations = new Map<string, NativeStartupServingGenerationV1>();
  const sessionGenerations = new WeakMap<object, NativeStartupServingGenerationV1>();
  let refreshTask: Promise<void> | null = null;
  let refreshController: AbortController | null = null;
  let refreshFailure: unknown = null;
  const admissionWaiters = new Set<() => void>();
  const quiescenceWaiters = new Set<() => void>();

  const wakeAdmission = (): void => {
    for (const resolve of admissionWaiters) resolve();
    admissionWaiters.clear();
  };
  const wakeQuiescence = (): void => {
    if (sessionOpening || activeSession !== null) return;
    for (const resolve of quiescenceWaiters) resolve();
    quiescenceWaiters.clear();
  };
  const waitForAdmission = async (): Promise<void> => {
    while (promotionClosed && !closed) {
      await new Promise<void>(resolve => admissionWaiters.add(resolve));
    }
    if (closed) throw new Error("startup-runtime-closed");
  };
  const waitForQuiescence = async (): Promise<void> => {
    while (sessionOpening || activeSession !== null) {
      await new Promise<void>(resolve => quiescenceWaiters.add(resolve));
    }
  };
  const loadGeneration = async (
    handle: NativeStartupGenerationHandleV1,
  ): Promise<NativeStartupLoadedGenerationV1> => {
    const rawGeneration = await owner.loadGeneration(handle);
    if (rawGeneration.handle === null || typeof rawGeneration.handle !== "object") {
      throw new TypeError("native startup generation handle is invalid");
    }
    const decodedIdentity = decodeNativeStartupGenerationIdentityV1(rawGeneration.identity);
    pinnedAuthority = pinNativeStartupAuthority(pinnedAuthority, decodedIdentity.authority);
    const generation = Object.freeze({
      handle: rawGeneration.handle,
      identity: Object.freeze({ ...decodedIdentity, authority: pinnedAuthority }),
    });
    const serving = servingGeneration(generation);
    const existing = servedGenerations.get(serving.generationId);
    if (existing !== undefined
      && (existing.recordRoot !== serving.recordRoot
        || existing.graphRoot !== serving.graphRoot
        || existing.sourceCoverageRoot !== serving.sourceCoverageRoot
        || !nativeStartupAuthoritiesEqual(existing.authority, serving.authority))) {
      throw new Error("startup-generation-identity-rebound");
    }
    servedGenerations.set(serving.generationId, serving);
    return generation;
  };

  const promoteAtSafeBoundary = async (
    request: NativeStartupPromotionRequestV1,
  ): Promise<NativeStartupGenerationHandleV1> => {
    if (closed) throw new Error("startup-runtime-closed");
    if (promotionClosed) throw new Error("startup-promotion-already-open");
    promotionClosed = true;
    await waitForQuiescence();
    if (closed) {
      promotionClosed = false;
      wakeAdmission();
      throw new Error("startup-runtime-closed");
    }
    const previousRecordRoot = activeGeneration?.identity.recordRoot ?? null;
    let mayReopenAdmission = false;
    try {
      try {
        const promoted = await owner.promote(request);
        activeGeneration = await loadGeneration(promoted);
        mayReopenAdmission = true;
        return promoted;
      } catch (error) {
        // Promotion may have committed before its caller observed success.
        // Re-read the durable active authority while admission remains closed;
        // if it changed, install that exact closure before propagating the
        // original error to the builder recovery state machine.
        const current = await owner.findLatestReusable();
        const currentRecordRoot = current === null
          ? null
          : hashSchema.decode(
            owner.generationRecordRoot(current),
            "nativeStartup.currentRecordRoot",
          );
        const recovery = classifyNativeStartupPromotionRecovery(
          previousRecordRoot,
          currentRecordRoot,
          activeGeneration !== null,
        );
        if (recovery === "load-current") {
          if (current === null) throw new Error("native-startup-recovery-current-missing");
          activeGeneration = await loadGeneration(current);
          mayReopenAdmission = true;
        } else if (recovery === "reopen-current") {
          mayReopenAdmission = true;
        }
        throw error;
      }
    } finally {
      // A committed generation whose closure could not be installed is a hard
      // fail-closed state. Reopening the old pointer would splice it against
      // the new durable authority.
      if (mayReopenAdmission) {
        promotionClosed = false;
        wakeAdmission();
      }
    }
  };

  const builder = owner.createGenerationBuilder(Object.freeze({ promote: promoteAtSafeBoundary }));
  const initial = await builder.loadOrBuildInitial(signal);
  if (activeGeneration === null) activeGeneration = await loadGeneration(initial);

  const startRefreshIfDue = (
    headNumber: string,
    generation: NativeStartupLoadedGenerationV1,
  ): void => {
    if (closed || refreshTask !== null || generation !== activeGeneration) return;
    const age = decimal(headNumber, "startup.producerHead.number")
      - decimal(generation.identity.cutoff.number, "startup.activeReady.cutoff.number");
    if (age < decimal(owner.targetRefreshAgeBlocks, "startup.policy.targetRefreshAgeBlocks")) return;
    const controller = new AbortController();
    refreshController = controller;
    refreshFailure = null;
    const task = builder.buildNext(controller.signal);
    // Observe rejection immediately so a slow Producer callback cannot leave
    // a background promise unhandled. A later head retries while the old
    // generation remains within its independently enforced serving age.
    refreshTask = task.catch(error => { refreshFailure = error; }).finally(() => {
      if (refreshController === controller) refreshController = null;
      if (refreshTask !== null) refreshTask = null;
    });
  };

  return Object.freeze({
    get activeGeneration() {
      return servedGenerations.get(activeGeneration!.identity.generationId)!;
    },
    get generationId() { return activeGeneration!.identity.generationId; },
    get graphRoot() { return activeGeneration!.identity.graphRoot; },
    readActiveGeneration(): NativeStartupServingGenerationV1 {
      if (closed || activeGeneration === null) throw new Error("startup-runtime-closed");
      return servedGenerations.get(activeGeneration.identity.generationId)!;
    },
    readServingGeneration(generationId: string): NativeStartupServingGenerationV1 {
      if (typeof generationId !== "string" || generationId.length === 0) {
        throw new TypeError("startup serving generation id is required");
      }
      const serving = servedGenerations.get(generationId);
      if (serving === undefined) throw new Error("startup-serving-generation-unknown");
      return serving;
    },
    readProducerSessionGeneration(session: object): NativeStartupServingGenerationV1 {
      if (session === null || typeof session !== "object") throw new TypeError("startup producer session is required");
      const serving = sessionGenerations.get(session);
      if (serving === undefined) throw new Error("startup-producer-session-unknown");
      return serving;
    },
    async waitForGenerationIdle(): Promise<void> {
      const task = refreshTask;
      if (task !== null) await task;
      if (refreshFailure !== null) throw refreshFailure;
    },
    async withProducerSession<Result>(
      headObservation: Observation,
      run: (session: Session) => Promise<Result>,
      sessionSignal?: AbortSignal,
    ): Promise<Result> {
      if (typeof run !== "function") throw new TypeError("startup producer callback is required");
      await waitForAdmission();
      if (sessionOpening || activeSession !== null) throw new Error("startup-producer-session-already-open");
      sessionOpening = true;
      const generation = activeGeneration;
      if (generation === null) {
        sessionOpening = false;
        wakeQuiescence();
        throw new Error("startup-active-generation-unavailable");
      }
      let lease: Lease;
      try {
        lease = await owner.openProducerLease(generation.handle);
      } catch (error) {
        sessionOpening = false;
        wakeQuiescence();
        throw error;
      }
      if (closed) {
        owner.releaseProducerLease(lease);
        sessionOpening = false;
        wakeQuiescence();
        throw new Error("startup-runtime-closed");
      }
      activeLease = lease;
      let session: Session;
      try {
        session = await owner.openProducerSession(headObservation, lease, sessionSignal);
      } catch (error) {
        owner.releaseProducerLease(lease);
        activeLease = null;
        sessionOpening = false;
        wakeQuiescence();
        throw error;
      }
      if (closed) {
        await owner.closeProducerSession(session);
        owner.releaseProducerLease(lease);
        activeLease = null;
        sessionOpening = false;
        wakeQuiescence();
        throw new Error("startup-runtime-closed");
      }
      activeSession = session;
      sessionGenerations.set(session, servedGenerations.get(generation.identity.generationId)!);
      sessionOpening = false;
      startRefreshIfDue(owner.producerSessionHeadNumber(session), generation);
      try {
        return await run(session);
      } finally {
        activeSession = null;
        await owner.closeProducerSession(session);
        owner.releaseProducerLease(lease);
        activeLease = null;
        wakeQuiescence();
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      promotionClosed = true;
      wakeAdmission();
      refreshController?.abort(new Error("startup-runtime-closed"));
      if (activeSession !== null) {
        await owner.closeProducerSession(activeSession);
        activeSession = null;
      }
      if (activeLease !== null) {
        owner.releaseProducerLease(activeLease);
        activeLease = null;
      }
      sessionOpening = false;
      wakeQuiescence();
      const draining = refreshTask;
      if (draining !== null) await draining;
    },
  });
}
