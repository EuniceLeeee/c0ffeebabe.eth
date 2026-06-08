# V5: Production MEV

## 改动

### 1. Pool Registry 自动建图

**改 `searcher/planner/token-graph.ts`**

删除 `defaultTokenGraph()` 手写 edge。改为：

- 新增 `POOL_REGISTRY`：只有 pool 地址 + adapter 类型
- 新增 `async buildTokenGraph(state)`：启动时 eth_call 每个 pool 查 token 对，自动生成所有 edge
  - Curve: `coins(0), coins(1), ...` → 生成所有 i→j 组合
  - UniV3: `token0(), token1()` → 生成双向 edge
  - PSM / Fluid: 固定方向（协议决定的，不是 token 决定的）

### 2. MEV-Share 接入 + Main Loop

**新建 `searcher/main.ts`**

- SSE 连 `https://mev-share.flashbots.net`
- hint 到达 → log.address 匹配 POOL_REGISTRY
- 命中 → snapshot → impersonate 在本地做等效 swap（从 log 解析 pool/i/j/amount）
- 跑已有 pipeline：detect → plan → solve → simulate
- profitable → 调已有 `src/submitter.ts` 的 `submitBundle()`
- revert snapshot，等下一个 hint

### 3. Bundle Router 接真提交

**改 `searcher/execution/bundle-router.ts`**

接 `src/submitter.ts` 的 `submitBundle()`。

## 不动

quoter / amount-propagation / plan-builder / solver / simulator / compiler / adapter / submitter 全不动。

## 验收

### AC-4a: 自动建图

```
启动 → eth_call 查所有 pool 的 token → 生成 edge 数 ≥ 现有手写数量（12）
→ 对 AC-3 的两个 fixture 跑 pipeline → profit 结果跟手写 graph 一致（误差 < 1%）
```

### AC-4b: MEV-Share 连接

```
npm run searcher:live 启动
→ 日志显示 "connected to MEV-Share"
→ 持续收到 hint
→ 命中 pool 时日志显示 "pool hit: 0x... tokenIn→tokenOut amountIn=..."
→ 进 pipeline 跑 detect/plan/solve
```

### AC-4c: 端到端

```
收到 hint → detect 命中 pool → solve 找到 profitable plan
→ submitBundle 发到 builder → 收到 bundleHash 回执
→ 日志打印 profit 金额 + bundle hash
```

不要求真被 include（那是竞争问题）。

## 运行

```bash
PRIVATE_KEY=0x... MAINNET_RPC_URL=https://... npm run searcher:live
```
