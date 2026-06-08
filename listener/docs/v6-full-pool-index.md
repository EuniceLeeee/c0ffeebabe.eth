# V6: Full Pool Index — 启动时全量扫描，运行时 O(1) 匹配

## 问题

当前 `POOL_REGISTRY` 硬编码 7 个池子。MEV-Share hint 里的 swap 如果不在这 7 个里就
skip。生产 MEV bot 的做法是启动时一次性扫全链 factory events，建完整 pool index，运行
时纯 hash 查表。

## 链上数据量

| Factory | 地址 | 数量 |
|---|---|---|
| UniV2 | `0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f` | 511,663 |
| SushiSwap | `0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac` | 4,712 |
| UniV3 | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | ~20,000 |
| Curve MetaRegistry | `0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC` | 2,299 |
| **合计** | | **~540,000** |

## 架构

```
启动阶段 (一次性，5-15 分钟，可缓存):
  扫 factory events → poolIndex: Map<address, PoolInfo>
  PoolInfo = { token0, token1, adapter, fee? }
  
  从 poolIndex 中筛选 routing backbone:
    token0 或 token1 ∈ {WETH, USDC, DAI, USDT, wstUSR, DOLA, sUSDS}
    → 骨干 graph (~2000-5000 edges)

运行时:
  hint 进来 → log.address 查 poolIndex → O(1)
  命中 → 池子的 token pair 已知
       → 检查是否在骨干 graph 里（大部分是）
       → 如果不在，临时加 2 条边
       → DFS 找闭环 → simulate → submit
  未命中 → skip（不是已知 DEX pool）
```

## 要改的文件

### 1. 新建 `searcher/indexer/pool-indexer.ts` (~200 行)

```typescript
export interface PoolInfo {
  address: string;
  token0: string;
  token1: string;
  adapter: "univ2" | "univ3" | "curve" | "sushi";
  fee?: number;       // UniV3 fee tier
}

export interface PoolIndex {
  pools: Map<string, PoolInfo>;   // key = address.toLowerCase()
  timestamp: number;              // last scan block
}

interface FactoryConfig {
  name: string;
  address: string;
  adapter: PoolInfo["adapter"];
  deployBlock: number;
  eventSignature: string;         // PairCreated / PoolCreated topic0
  parseLog: (log: Log) => { pool: string; token0: string; token1: string; fee?: number };
}

const FACTORIES: FactoryConfig[] = [
  {
    name: "UniswapV2",
    address: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
    adapter: "univ2",
    deployBlock: 10_000_835,
    eventSignature: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
    parseLog: (log) => ({
      token0: "0x" + log.topics[1].slice(26),
      token1: "0x" + log.topics[2].slice(26),
      pool: "0x" + log.data.slice(26, 66),
    }),
  },
  {
    name: "SushiSwap",
    address: "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac",
    adapter: "sushi",
    deployBlock: 10_794_229,
    eventSignature: "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9",
    parseLog: (log) => ({
      token0: "0x" + log.topics[1].slice(26),
      token1: "0x" + log.topics[2].slice(26),
      pool: "0x" + log.data.slice(26, 66),
    }),
  },
  {
    name: "UniswapV3",
    address: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    adapter: "univ3",
    deployBlock: 12_369_621,
    // PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)
    eventSignature: "0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118",
    parseLog: (log) => ({
      token0: "0x" + log.topics[1].slice(26),
      token1: "0x" + log.topics[2].slice(26),
      fee: parseInt(log.topics[3], 16),
      pool: "0x" + log.data.slice(90, 130),  // 4th word in data
    }),
  },
];

// Curve: 用 MetaRegistry.pool_list(i) 遍历，不用 events

/**
 * 全量扫描所有 DEX factory events，返回 pool index。
 * 第一次执行 5-15 分钟，结果缓存到 CACHE_PATH。
 * 后续启动只扫新区块增量。
 */
export async function buildPoolIndex(
  provider: JsonRpcProvider,
  cachePath?: string,
): Promise<PoolIndex> {
  let index = loadCache(cachePath);
  const latestBlock = await provider.getBlockNumber();

  for (const factory of FACTORIES) {
    const fromBlock = Math.max(factory.deployBlock, index.timestamp + 1);
    if (fromBlock > latestBlock) continue;

    console.log(`[indexer] scanning ${factory.name} from block ${fromBlock}...`);
    const logs = await getLogs(provider, factory.address, factory.eventSignature, fromBlock, latestBlock);
    
    for (const log of logs) {
      const parsed = factory.parseLog(log);
      index.pools.set(parsed.pool.toLowerCase(), {
        address: ethers.getAddress(parsed.pool),
        token0: ethers.getAddress(parsed.token0),
        token1: ethers.getAddress(parsed.token1),
        adapter: factory.adapter,
        fee: parsed.fee,
      });
    }
    console.log(`[indexer] ${factory.name}: ${logs.length} pools scanned`);
  }

  // Curve: iterate MetaRegistry
  await indexCurveMetaRegistry(provider, index);

  index.timestamp = latestBlock;
  saveCache(cachePath, index);
  console.log(`[indexer] total: ${index.pools.size} pools indexed up to block ${latestBlock}`);
  return index;
}

/** 分块 getLogs，每次最多 10k blocks */
async function getLogs(
  provider: JsonRpcProvider,
  address: string,
  topic0: string,
  fromBlock: number,
  toBlock: number,
): Promise<Log[]> {
  const CHUNK = 10_000;
  const all: Log[] = [];
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    const logs = await provider.getLogs({
      address,
      topics: [topic0],
      fromBlock: start,
      toBlock: end,
    });
    all.push(...logs);
  }
  return all;
}

/** Curve MetaRegistry: pool_list(i) for i in 0..pool_count() */
async function indexCurveMetaRegistry(provider: JsonRpcProvider, index: PoolIndex): Promise<void> {
  const META_REGISTRY = "0xF98B45FA17DE75FB1aD0e7aFD971b0ca00e379fC";
  const iface = new ethers.Interface([
    "function pool_count() view returns (uint256)",
    "function pool_list(uint256) view returns (address)",
    "function get_coins(address) view returns (address[8])",
  ]);

  const countRaw = await provider.call({ to: META_REGISTRY, data: iface.encodeFunctionData("pool_count") });
  const count = Number(BigInt(countRaw));
  
  for (let i = 0; i < count; i++) {
    const poolRaw = await provider.call({ to: META_REGISTRY, data: iface.encodeFunctionData("pool_list", [i]) });
    const pool = ethers.getAddress("0x" + poolRaw.slice(-40));
    
    const coinsRaw = await provider.call({ to: META_REGISTRY, data: iface.encodeFunctionData("get_coins", [pool]) });
    const decoded = iface.decodeFunctionResult("get_coins", coinsRaw)[0] as string[];
    const coins = decoded.filter(c => c !== ethers.ZeroAddress);
    
    if (coins.length >= 2) {
      index.pools.set(pool.toLowerCase(), {
        address: pool,
        token0: coins[0],
        token1: coins[1],  // 简化：只存前 2 个 coin
        adapter: "curve",
      });
    }
  }
}

function loadCache(path?: string): PoolIndex { /* 读 JSON 文件，不存在返回空 */ }
function saveCache(path: string | undefined, index: PoolIndex): void { /* 写 JSON */ }
```

### 2. 改 `searcher/main.ts` — hint 匹配用 poolIndex

```typescript
// 启动阶段
const poolIndex = await buildPoolIndex(provider, ".cache/pool-index.json");
console.log(`[searcher/live] pool index: ${poolIndex.pools.size} pools`);

// handleHint 里：
const SWAP_TOPICS = new Set([
  "0x8b3e96f2b889fa771c53c981b40daf005f63f637f1869f707052d15a3dd97140", // Curve TokenExchange
  "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67", // UniV3 Swap
  "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", // UniV2 Swap
]);

function matchHintPool(logs: HintLog[], poolIndex: PoolIndex): PoolInfo | null {
  for (const log of logs) {
    if (!SWAP_TOPICS.has(log.topics[0]?.toLowerCase())) continue;
    const info = poolIndex.pools.get(log.address.toLowerCase());
    if (info) return info;
  }
  return null;
}
```

### 3. 改 `searcher/planner/token-graph.ts` — 骨干 graph + 动态扩展

```typescript
// POOL_REGISTRY 改名为 ROUTING_BACKBONE — 高流动性中间路由池
// 启动时从 poolIndex 中筛选：token ∈ 主流 token 集合的池子
// 或者保持静态骨干 + 动态加边

export function buildBackboneGraph(poolIndex: PoolIndex): TokenEdge[] {
  const CORE_TOKENS = new Set([
    ADDR.WETH, ADDR.USDC, ADDR.DAI, ADDR.USDT,
    ADDR.WSTUSR, ADDR.DOLA, ADDR.SUSDS,
  ].map(a => a.toLowerCase()));

  const edges: TokenEdge[] = [];
  for (const [, pool] of poolIndex.pools) {
    const t0 = pool.token0.toLowerCase();
    const t1 = pool.token1.toLowerCase();
    if (!CORE_TOKENS.has(t0) && !CORE_TOKENS.has(t1)) continue;
    
    edges.push(
      { adapterId: adapterFor(pool), target: pool.address, tokenIn: pool.token0, tokenOut: pool.token1, slotKind: "swap" },
      { adapterId: adapterFor(pool), target: pool.address, tokenIn: pool.token1, tokenOut: pool.token0, slotKind: "swap" },
    );
  }
  
  // + Fluid/PSM/Morpho 固定方向边（不在 factory 里）
  edges.push(...fixedProtocolEdges());
  
  return edges;
}
```

### 4. 不动

solver / simulator / compiler / adapter / submitter / bundle-router 全不动。

## 验收标准

### AC-6a: Pool index 完整性

```
测试方式: 启动 buildPoolIndex()，检查结果

验证:
  1. poolIndex.pools.size >= 500_000（UniV2 511k + UniV3 ~20k + Sushi 4.7k + Curve 2.3k）
  2. 已知池子在 index 里:
     - ADDR.CURVE_DOLA_WSTUSR → adapter "curve"
     - ADDR.UNISWAP_V3_USDT_WETH → adapter "univ3"
     - "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc" (UniV2 USDC/WETH) → adapter "univ2"
  3. token0 / token1 都是合法 checksum 地址
  4. 第二次启动（有 cache）< 30 秒
```

### AC-6b: 骨干 graph 覆盖

```
测试方式: buildBackboneGraph(poolIndex) 

验证:
  1. edges.length >= 100（至少 50 个 pool × 双向 = 100 边）
  2. 包含原 POOL_REGISTRY 7 个池子的所有边（回归）
  3. 包含新池子: 至少有 1 个 UniV2 pair 和 1 个非 POOL_REGISTRY 的 UniV3 pool
  4. DFS(wstUSR → wstUSR) 路径数 >= 原来的路径数（不减少）
```

### AC-6c: Hint 匹配范围扩大

```
测试方式: 构造 mock hint，log.address 分别为:
  a) CURVE_DOLA_WSTUSR (原有)
  b) UniV2 USDC/WETH pair (新增)
  c) UniV3 WETH/USDT 500 fee pool (新增)
  d) 随机 EOA 地址 (不是 pool)

验证:
  a) matchHintPool 返回 PoolInfo, adapter="curve" ✅
  b) matchHintPool 返回 PoolInfo, adapter="univ2" ✅
  c) matchHintPool 返回 PoolInfo, adapter="univ3" ✅
  d) matchHintPool 返回 null ✅
```

### AC-6d: 端到端 dry-run

```
命令: SEARCHER_DRY_RUN=1 SEARCHER_ENABLE_HASH_ONLY=1 SEARCHER_MAX_HINTS=30 npm run searcher:live

验证日志:
  1. "[indexer] total: N pools indexed" 出现，N >= 500_000
  2. "pool index: N pools" 出现
  3. "backbone graph: N edges" 出现，N >= 100
  4. 至少 1 条 hint 匹配到 pool（不全是 skip）
     日志: "[searcher/live] hint via logs" 或 "[searcher/live] pool hit:"
  5. 相比 V5 dry-run，匹配率明显提高（V5 几乎全 skip）
  6. 进程正常退出
```

### AC-6e: AC-3 回归

```
命令: npm run searcher:ac3

验证:
  AC-3 PASS (2/2 fixtures)
  利润数字不变（579.57 / 8.12 wstUSR，±1%）
```

### AC-6f: Cache 持久化

```
测试方式:
  1. 删除 .cache/pool-index.json
  2. 跑 buildPoolIndex() → 记录耗时 T1（预期 5-15 分钟）
  3. 再跑一次 → 记录耗时 T2（预期 < 30 秒）

验证:
  T2 / T1 < 0.1（至少快 10 倍）
  .cache/pool-index.json 存在且 > 10MB
  cache 内容能被正确 load
```

## 不要求

- 不要求 UniV4 pool 索引（没有标准 factory event 格式）
- 不要求 Balancer pool 索引（可以后加）
- 不要求 impersonate swap 支持所有 DEX（Curve 先行，UniV2/V3 后加）
- 不要求每个 indexed pool 都能跑通完整 solver pipeline
- 不要求 pool 流动性过滤（DFS 会自然筛掉走不通的路径）

## 风险

1. **RPC 限频**: getLogs 扫 500k+ events 需要大量请求。如果 RPC 限频，启动会更慢。
   缓解: 分块请求 + 指数退避 + 磁盘缓存
2. **内存**: 540k entries × ~200 bytes ≈ ~100MB。可接受。
3. **DFS 爆炸**: 骨干 graph 如果有太多 edge，DFS maxDepth=8 可能很慢。
   缓解: 只把 CORE_TOKENS 相关池子放进骨干（~2000-5000 边），不是全量 540k
4. **Curve MetaRegistry 遍历慢**: 2299 个 pool 逐个查 get_coins = 2299 次 eth_call。
   缓解: 并行 batch call 或 multicall
