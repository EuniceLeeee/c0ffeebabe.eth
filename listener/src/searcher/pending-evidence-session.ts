import { ethers } from "ethers";
import { sendDexDiscoveryRpc } from "./dex-discovery-transport.js";
import {
  PendingEvidenceTaskQueueFullError,
  type PendingEvidenceTaskPriority,
  type PendingEvidenceTaskScheduler,
} from "./pending-evidence-admission-queue.js";
import type { PendingTransactionEvidenceProjection } from "./venues/adapter-family-registry.js";
import type {
  ExecutionFamilyId,
  PendingExecutionEvidence,
  PendingTransactionEvidenceHead,
  PendingTransactionEvidenceInput,
} from "./venues/route-leg-adapter.js";

export interface PendingEvidenceSession {
  readonly candidateFamilyIds: readonly ExecutionFamilyId[];
  head(priority: PendingEvidenceTaskPriority): Promise<PendingTransactionEvidenceHead>;
  observeFamily(
    familyId: ExecutionFamilyId,
    priority: PendingEvidenceTaskPriority,
  ): Promise<PendingExecutionEvidence | undefined>;
  resolve(
    familyIds: readonly ExecutionFamilyId[],
    priority: PendingEvidenceTaskPriority,
  ): Promise<readonly PendingExecutionEvidence[]>;
}

export function createPendingEvidenceSession(
  tx: Pick<ethers.TransactionResponse, "hash" | "to" | "data">,
  provider: ethers.JsonRpcProvider,
  projection: PendingTransactionEvidenceProjection,
  observerScheduler: PendingEvidenceTaskScheduler,
  readScheduler: PendingEvidenceTaskScheduler,
  currentHead: (
    priority: PendingEvidenceTaskPriority,
  ) => Promise<PendingTransactionEvidenceHead>,
  timeoutMs: number,
  maxReadsPerFamily: number,
  reportFailure: (familyId: ExecutionFamilyId | "kernel", code: string) => void,
): PendingEvidenceSession {
  const input: PendingTransactionEvidenceInput = Object.freeze({
    hash: tx.hash,
    to: tx.to,
    data: tx.data,
  });
  const candidateFamilyIds = projection.candidateFamilyIds(input);
  let frozenHead:
    Promise<PendingTransactionEvidenceHead> | undefined;
  const byFamily = new Map<
    ExecutionFamilyId,
    Promise<PendingExecutionEvidence | undefined>
  >();

  const head = (
    priority: PendingEvidenceTaskPriority,
  ): Promise<PendingTransactionEvidenceHead> => {
    frozenHead ??= currentHead(priority);
    return frozenHead;
  };

  const observeFamily = (
    familyId: ExecutionFamilyId,
    priority: PendingEvidenceTaskPriority,
  ): Promise<PendingExecutionEvidence | undefined> => {
    let pending = byFamily.get(familyId);
    if (pending) return pending;
    pending = (async () => {
      const dispatchHead = await head(priority);
      return observerScheduler.run(priority, async () => {
        const result = await projection.observe(
          input,
          {
            head: dispatchHead,
            call(read, control) {
              return readScheduler.run(priority, () =>
                sendDexDiscoveryRpc<string>(
                  provider,
                  "eth_call",
                  [
                    provider.getRpcTransaction({
                      to: read.to,
                      data: read.data,
                    }),
                    {
                      blockHash: dispatchHead.hash,
                      requireCanonical: true,
                    },
                  ],
                  control,
                ),
                familyId,
              );
            },
          },
          {
            familyIds: [familyId],
            timeoutMs,
            maxReadsPerFamily,
          },
        );
        for (const failure of result.failures) {
          reportFailure(failure.familyId, failure.code);
        }
        return result.evidence[0];
      }, familyId);
    })();
    byFamily.set(familyId, pending);
    return pending;
  };

  return Object.freeze({
    candidateFamilyIds,
    head,
    observeFamily,
    async resolve(
      familyIds: readonly ExecutionFamilyId[],
      priority: PendingEvidenceTaskPriority,
    ) {
      const selected = [...new Set(familyIds)]
        .filter((familyId) => candidateFamilyIds.includes(familyId));
      const settled = await Promise.allSettled(
        selected.map((familyId) => observeFamily(familyId, priority)),
      );
      const observed = settled.flatMap((result, index) => {
        if (result.status === "fulfilled") return [result.value];
        const error = result.reason;
        reportFailure(
          selected[index]!,
          error instanceof PendingEvidenceTaskQueueFullError
            ? `${error.priority}_queue_full`
            : "observer_exception",
        );
        return [];
      });
      return Object.freeze(observed.filter(
        (item): item is PendingExecutionEvidence => item !== undefined,
      ));
    },
  });
}
