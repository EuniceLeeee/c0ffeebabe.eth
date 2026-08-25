import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  enumerateFundingTokenUniverse,
  FUNDING_TOKEN_UNIVERSE_FORMAT,
  loadFundingTokenUniverse,
  writeFundingTokenUniverse,
} from "../funding-token-universe.js";
import { ethers } from "ethers";
import { ADDR } from "../../shared/constants/addresses.js";
import {
  BLOCKSCAN_MULTICALL3,
  blockScanMulticallIface,
} from "../blockscan-multicall.js";

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "funding-token-universe-"));
  try {
    const path = join(dir, "funding-token-universe.json");
    const table = Object.freeze({
      format: FUNDING_TOKEN_UNIVERSE_FORMAT,
      enumeratedAtBlock: 25_800_000,
      tokens: Object.freeze([
        "0x" + "11".repeat(20),
        "0x" + "22".repeat(20),
        "0x" + "33".repeat(20),
      ]),
    });
    await writeFundingTokenUniverse(path, table);
    const loaded = await loadFundingTokenUniverse(path);
    assert.notEqual(loaded, null);
    assert.equal(loaded!.tokens.length, 3);
    assert.deepEqual([...loaded!.tokens].sort(), [...table.tokens].sort());
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.format, FUNDING_TOKEN_UNIVERSE_FORMAT);

    await assertEnumerationUsesBoundedMulticall();

    // A missing table loads as null (first boot enumerates instead).
    assert.equal(
      await loadFundingTokenUniverse(join(dir, "missing.json")),
      null,
    );
    // Corrupt / foreign tables fail closed (never trusted as-is).
    await writeFundingTokenUniverse(path, Object.freeze({
      format: FUNDING_TOKEN_UNIVERSE_FORMAT,
      enumeratedAtBlock: 1,
      tokens: Object.freeze(["not-an-address"]),
    }));
    assert.equal(await loadFundingTokenUniverse(path), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  console.log("funding token universe PASS");
}

async function assertEnumerationUsesBoundedMulticall(): Promise<void> {
  const head = 19_600_001;
  const marketId = 7n;
  const loanToken = "0x" + "44".repeat(20);
  const positiveBalancerToken = "0x" + "55".repeat(20);
  const emptyBalancerToken = "0x" + "66".repeat(20);
  const morpho = new ethers.Interface([
    "event CreateMarket(uint256 indexed id)",
    "function market(uint256 id) view returns " +
      "(tuple(address loanToken,address collateralToken,address oracle," +
      "address irm,uint256 lltv))",
  ]);
  const erc20 = new ethers.Interface([
    "function balanceOf(address account) view returns (uint256)",
  ]);
  let logCalls = 0;
  let multicallCalls = 0;
  let directCalls = 0;
  const provider = Object.freeze({
    getBlockNumber: async () => head,
    getLogs: async (filter: {
      readonly address?: string;
      readonly fromBlock?: number;
      readonly toBlock?: number;
    }) => {
      logCalls++;
      assert.equal(filter.address?.toLowerCase(), ADDR.MORPHO.toLowerCase());
      return [Object.freeze({
        address: ADDR.MORPHO,
        topics: Object.freeze([
          morpho.getEvent("CreateMarket")!.topicHash,
          ethers.zeroPadValue(ethers.toBeHex(marketId), 32),
        ]),
        data: "0x",
        blockNumber: 19_600_000,
      })];
    },
    call: async (request: {
      readonly to?: string;
      readonly data?: string;
      readonly blockTag?: number;
    }) => {
      assert.equal(request.blockTag, head);
      if (request.to?.toLowerCase() !== BLOCKSCAN_MULTICALL3.toLowerCase()) {
        directCalls++;
        assert.equal(
          request.data!.slice(0, 10),
          erc20.getFunction("balanceOf")!.selector,
        );
        return erc20.encodeFunctionResult("balanceOf", [
          request.to?.toLowerCase() === positiveBalancerToken ? 1n : 0n,
        ]);
      }
      multicallCalls++;
      const [calls] = blockScanMulticallIface.decodeFunctionData(
        "aggregate3",
        request.data!,
      ) as unknown as [readonly {
        readonly target: string;
        readonly callData: string;
      }[]];
      if (calls.some((call) =>
        call.target.toLowerCase() !== ADDR.MORPHO.toLowerCase()
      )) {
        throw new Error("synthetic aggregate failure");
      }
      const results = calls.map((call) => {
        const [id] = morpho.decodeFunctionData("market", call.callData);
        assert.equal(id, marketId);
        return Object.freeze({
          success: true,
          returnData: morpho.encodeFunctionResult("market", [[
            loanToken,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            0n,
          ]]),
        });
      });
      return blockScanMulticallIface.encodeFunctionResult("aggregate3", [
        results,
      ]);
    },
  });
  const table = await enumerateFundingTokenUniverse({
    provider: provider as never,
    candidateTokens: [positiveBalancerToken, emptyBalancerToken],
  });
  assert.deepEqual(table.tokens, [loanToken, positiveBalancerToken].sort());
  assert.equal(logCalls, 1);
  assert.equal(multicallCalls, 2);
  assert.equal(directCalls, 2);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
