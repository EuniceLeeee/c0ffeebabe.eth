import { ethers } from "ethers";
import { compilePlan } from "../shared/compiler/compiler.js";
import { bytesToHex } from "../shared/compiler/encoder.js";
import { buildExecuteCalldata } from
  "../shared/executor/botvm-executor.js";
import type {
  GenericCaptureFinalSimulation,
  GenericCaptureFinalSimulationInput,
} from "./generic-family-capture.js";
import { RevmSimClient } from "./revm-sim-client.js";
import type { CanonicalValue } from "./venues/canonical-value.js";

const ERC20 = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);

/**
 * Real fork execution for capture fragments. The daemon executes the exact
 * compiled BotVM bytes against the descriptor's source block and returns
 * observed deltas/logs. Nothing is inferred from expectedEffects.
 */
export function createGenericCaptureRevmFinalSimulation(input: {
  readonly client: RevmSimClient;
  readonly rpcUrl: string;
  readonly owner: string;
  readonly executor: string;
}): GenericCaptureFinalSimulation {
  const owner = ethers.getAddress(input.owner);
  const executor = ethers.getAddress(input.executor);
  return Object.freeze({
    async simulate(
      request: GenericCaptureFinalSimulationInput,
    ): Promise<CanonicalValue> {
      if (request.fragment.nodes.length !== 1) {
        throw new Error(
          "generic final simulation requires one plugin-issued root node",
        );
      }
      const root = request.fragment.nodes[0]!;
      const scriptHex = bytesToHex(compilePlan(root, executor));
      const calldata = buildExecuteCalldata(ethers.getBytes(scriptHex));
      const amount = request.kind === "route"
        ? request.vector.amountIn
        : request.kind === "credit"
          ? request.vector.collateralAmount
          : request.vector.amount;
      const tokenDeals = uniqueAddresses([root.tokenIn])
        .map((token) => Object.freeze({
          token,
          to: executor,
          amount: amount.toString(),
        }));
      const preCalls = request.fragment.requirements.map((requirement) =>
        requirement.kind === "approve"
          ? Object.freeze({
              from: executor,
              to: ethers.getAddress(requirement.token),
              calldata: ERC20.encodeFunctionData("approve", [
                requirement.spender,
                requirement.amount,
              ]),
            })
          : Object.freeze({
              from: executor,
              to: ethers.getAddress(requirement.token),
              calldata: ERC20.encodeFunctionData("transfer", [
                requirement.pool,
                requirement.amount,
              ]),
            })
      );
      const response = await input.client.strictSimulate({
        blockNumber: request.source.number,
        rpcUrl: input.rpcUrl,
        from: owner,
        to: executor,
        data: calldata,
        gasLimit: 0x1000000,
        preCalls,
        tokenDeals,
        observeTokens: uniqueAddresses(collectTokens(root)),
        observeLogs: true,
      });
      if ((response.missingStateKeys?.length ?? 0) !== 0) {
        throw new Error(
          `generic final simulation missing state: ` +
            response.missingStateKeys!.slice(0, 6).join(","),
        );
      }
      if (response.success !== true) {
        throw new Error(
          `generic final simulation reverted: ` +
            (response.revertReason ?? response.error ?? "unknown"),
        );
      }
      return Object.freeze({
        sourceBlock: request.source.number,
        sourceBlockHash: request.source.hash,
        semanticId: request.semanticId,
        kind: request.kind,
        success: true,
        gasUsed: String(response.gasUsed ?? "0"),
        scriptHash: ethers.sha256(scriptHex),
        calldataHash: ethers.sha256(calldata),
        observed: Object.freeze({
          tokenDeltas: Object.freeze((response.strict?.tokenDeltas ?? []).map(
            (delta) => Object.freeze({
              token: delta.token.toLowerCase(),
              account: delta.account.toLowerCase(),
              delta: delta.delta,
            }),
          )),
          totalSupplyDeltas: Object.freeze(
            (response.strict?.totalSupplyDeltas ?? []).map((delta) =>
              Object.freeze({
                token: delta.token.toLowerCase(),
                delta: delta.delta,
              })
            ),
          ),
          logsHash: ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(
            response.strict?.logs ?? [],
          ))),
        }),
      });
    },
  });
}

function collectTokens(root: {
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly children: readonly unknown[];
}): string[] {
  const tokens = [root.tokenIn, root.tokenOut];
  for (const child of root.children) {
    if (
      child !== null && typeof child === "object" &&
      "tokenIn" in child && "tokenOut" in child && "children" in child
    ) {
      tokens.push(...collectTokens(child as Parameters<typeof collectTokens>[0]));
    }
  }
  return tokens;
}

function uniqueAddresses(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => ethers.getAddress(value).toLowerCase()))]
    .sort();
}
