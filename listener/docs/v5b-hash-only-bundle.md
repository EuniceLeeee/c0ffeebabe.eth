# V5b: Hash-Only MEV-Share Bundle 支持

## 问题

dry-run 测试结果：大部分 MEV-Share hint 只有 hash，public RPC 拿不到 pending tx（tx 是私发给 builder 的）。当前代码 `getTransaction(hash)` 失败就跳过 — 等于跳过了绝大部分机会。

## 要改两个地方

### 1. `main.ts` 的 `handleTxHash` → 改为 `handleHint`

当前流程（需要 rawTx，大部分失败）：
```
getTransaction(hash) → 拿 rawTx → applyRawTx 到 Anvil → simulate
```

改为两条路径：
```
路径 A（hint 带 logs）:
  从 hint.logs 解析 swap 信息（pool, tokenIn, tokenOut, amountIn）
  → impersonate whale 在 Anvil 上做等效 swap
  → 池子状态被打歪 → simulate → 找到利润
  → mev_sendBundle 用 hash 引用 victim

路径 B（hint 能拿到完整 tx）:
  getTransaction(hash) → rawTx → applyRawTx（当前逻辑，保留作 fallback）
  → mev_sendBundle 用 hash 引用 victim
```

核心改动在 `handleHint`：

```typescript
async function handleHint(
  hint: HintEnvelope,
  ctx: Context,
): Promise<void> {
  const victimHash = hint.hashes[0];

  // 先 fork 到最新 block
  const latestBlock = await ctx.provider.getBlockNumber();
  await ctx.state.forkAt(latestBlock);

  // ── 路径 A：从 hint.logs 模拟 victim ──
  const hintLogs = extractLogs(hint.payload);
  const impact = matchPoolImpactFromLogs(hintLogs, ctx.graph);
  
  if (impact) {
    // impersonate whale 做等效 swap
    await ctx.state.rpc("anvil_impersonateAccount", [WHALE]);
    await dealToken(ctx.state, impact.tokenIn, WHALE, impact.amountIn);
    await approveAndSwap(ctx.state, impact);
    await ctx.state.rpc("anvil_stopImpersonatingAccount", [WHALE]);
  } else {
    // ── 路径 B：fallback 拿完整 tx ──
    const tx = await ctx.provider.getTransaction(victimHash);
    if (!tx || tx.blockNumber !== null) throw new Error("tx unavailable or already mined");
    const rawTx = await rawTxByHash(ctx.provider, victimHash, tx);
    if (!rawTx) throw new Error("raw tx unavailable");
    await ctx.state.applyRawTx(rawTx);
  }

  // 后面不变：install executor → detect → plan → solve → simulate → submit
  await prepareForkExecutor(...);
  
  // 构造 event（从 hint.logs 或本地 receipt）
  const event = buildOrderflowEvent(victimHash, latestBlock, hintLogs, ctx);
  
  // pipeline
  const opps = await ctx.detector.detect(event, ctx.state);
  for (const opp of opps) {
    const plans = await ctx.planner.plan(opp, [FLASH_LEND_SWAP_REPAY]);
    for (const candidate of plans) {
      const resolved = await ctx.solver.solve(candidate, ctx.state, ctx.simulator);
      const sim = await ctx.simulator.simulate(resolved);
      if (!sim.success || sim.netProfit <= 0n) continue;

      // 用 mev_sendBundle（hash-only，不需要 rawTx）
      await ctx.bundleRouter.submit({
        victimTxHash: victimHash,
        // victimRawTx 可选 — 有就传，没有也行
        backrunCalldata: sim.calldata,
        targetBlock: latestBlock + 1,
        expectedProfit: sim.netProfit,
      });
      return;
    }
  }
}
```

辅助函数：

```typescript
// 从 hint payload 提取 logs
function extractLogs(payload: unknown): HintLog[] {
  // MEV-Share hint 格式: { hash, logs: [{ address, topics, data }], txs: [...] }
  if (payload && typeof payload === "object" && "logs" in payload) {
    return (payload as any).logs ?? [];
  }
  return [];
}

// 从 logs 匹配 token-graph pool 的 swap event
function matchPoolImpactFromLogs(logs: HintLog[], graph: TokenEdge[]): SwapImpact | null {
  const graphPools = new Set(graph.map(e => e.target.toLowerCase()));
  const CURVE_TOKEN_EXCHANGE = "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140";
  
  for (const log of logs) {
    if (!graphPools.has(log.address.toLowerCase())) continue;
    if (log.topics?.[0]?.toLowerCase() === CURVE_TOKEN_EXCHANGE && log.data) {
      const [soldId, tokensSold, boughtId] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256", "uint256", "uint256", "uint256"], log.data,
      );
      // 从 graph edge 查 coin index → token address
      return resolveImpact(log.address, soldId, tokensSold, boughtId, graph);
    }
  }
  return null;
}

// impersonate whale 做等效 swap
async function approveAndSwap(state: StateBackend, impact: SwapImpact): Promise<void> {
  // 1. deal tokenIn to whale
  // 2. approve pool for tokenIn
  // 3. call exchange(i, j, amountIn, 0)
  // 效果：pool reserves 变化 = victim 真实执行的效果
}

// Anvil 给地址铸 token（anvil_setStorageAt 或 deal）
async function dealToken(state: StateBackend, token: string, to: string, amount: bigint): Promise<void> {
  // 用 anvil_setStorageAt 写 balanceOf slot
  // 或者 impersonate token holder + transfer
}
```

### 2. `submitter.ts` → 新增 `submitMevShareBundle`

当前 `submitBundle` 用 `eth_sendBundle`，需要 victim rawTx。
新增 `submitMevShareBundle`，用 `mev_sendBundle`，只需要 victim hash。

```typescript
// Flashbots MEV-Share bundle 格式
export async function submitMevShareBundle(params: {
  victimHash: string;
  signedBackrunTx: string;
  targetBlock: number;
  wallet: ethers.Wallet;
}): Promise<SubmitResult> {
  const { victimHash, signedBackrunTx, targetBlock, wallet } = params;

  // mev_sendBundle 格式: body 是有序 item 数组
  // item 可以是 { hash: "0x..." }（引用 pending tx）或 { tx: "0x...", canRevert: false }
  const bundleParams = {
    version: "v0.1",
    inclusion: {
      block: `0x${targetBlock.toString(16)}`,
      maxBlock: `0x${(targetBlock + 5).toString(16)}`,  // 5 block 窗口
    },
    body: [
      { hash: victimHash },                              // 引用 victim，不需要 rawTx
      { tx: signedBackrunTx, canRevert: false },          // 我们的 backrun
    ],
  };

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "mev_sendBundle",
    params: [bundleParams],
  });

  // 只发 Flashbots relay（mev_sendBundle 是 Flashbots 专有）
  const bodyHash = ethers.keccak256(ethers.toUtf8Bytes(body));
  const sig = await wallet.signMessage(ethers.getBytes(bodyHash));

  const res = await fetch("https://relay.flashbots.net", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Flashbots-Signature": `${wallet.address}:${sig}`,
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });

  const json = await res.json();
  if (json.error) {
    return { builder: "flashbots-mev-share", accepted: false, error: json.error.message };
  }
  return { builder: "flashbots-mev-share", accepted: true, bundleHash: json.result?.bundleHash };
}
```

`ProductionBundleRouter.submit()` 改为：
- 有 victimRawTx → 用 `eth_sendBundle` 发给所有 4 个 builder（当前逻辑）
- 没有 victimRawTx → 用 `mev_sendBundle` 发给 Flashbots relay

## 不动

solver / planner / simulator / compiler / adapter / quoter / token-graph / detector 全不动。

## 验收标准

### AC-5a: hint logs 解析

```
测试方式: 构造一个 mock hint，包含 Curve TokenExchange event log
（pool = CURVE_DOLA_WSTUSR, soldId=1, tokensSold=1000e18, boughtId=0）

验证:
  1. extractLogs(mockHint) 返回 1 条 log
  2. matchPoolImpactFromLogs(logs, graph) 返回非 null
  3. 返回的 impact.pool === CURVE_DOLA_WSTUSR
  4. 返回的 impact.tokenIn === wstUSR (coin index 1)
  5. 返回的 impact.tokenOut === DOLA (coin index 0)
  6. 返回的 impact.amountIn === 1000e18
```

### AC-5b: impersonate 等效 swap

```
测试方式: 在 Anvil fork 上:
  1. 记录 CURVE_DOLA_WSTUSR pool 的 get_dy(1, 0, 100e18) 结果 → preBefore
  2. impersonate whale → deal wstUSR → approve → exchange(1, 0, 1000e18, 0) 
  3. 再查 get_dy(1, 0, 100e18) → preAfter

验证:
  preAfter !== preBefore（池子状态确实被改变了）
  get_dy 返回值变小（wstUSR 在池子里多了，卖出价更差）
```

### AC-5c: mev_sendBundle 格式正确

```
测试方式: mock fetch，调 submitMevShareBundle

验证 request body:
  1. method === "mev_sendBundle"
  2. params[0].version === "v0.1"
  3. params[0].inclusion.block 是 hex 编码的 targetBlock
  4. params[0].body[0] === { hash: victimHash }（不是 rawTx）
  5. params[0].body[1].tx 是合法的签名 tx hex
  6. params[0].body[1].canRevert === false
  7. header 有 X-Flashbots-Signature
```

### AC-5d: 端到端 dry-run（hash-only hint）

```
命令: SEARCHER_DRY_RUN=1 SEARCHER_MAX_HINTS=20 npm run searcher:live

验证日志:
  1. "MEV-Share SSE connected" 出现
  2. "token graph: N edges" 出现
  3. 至少 1 条 hint 走路径 A（logs 解析 + impersonate）
     日志: "[searcher/live] hint via logs: pool=0x... amountIn=..."
  4. 走路径 A 的 hint 不再报 "tx not available from RPC"
  5. 如果有 pool 命中 → detector/planner/solver 日志出现
  6. 进程正常退出（maxHints=20 后自动停）

不要求:
  - 不要求找到 profitable opportunity（当前 pool 不一定有 depeg）
  - 不要求 bundle 被 include
```

### AC-5e: 回归 — AC-3 仍然 PASS

```
命令: npm run searcher:ac3

验证:
  AC-3 PASS (2/2 fixtures)
  数字跟之前一致（579.57 / 8.12 wstUSR，允许 ±1% 误差）
```
