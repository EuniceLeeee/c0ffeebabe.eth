# Plan: Filtered Mempool Subscription (P0 small change)

> 一句话原则：mempool 必须开,但**绝不能用 `newPendingTransactions -> getTransaction(hash)` 的 hash firehose 方式开**。改成服务端地址过滤的全 tx 订阅,把 CU 留在 Alchemy 端。

## 0. 动机

当前 route B([main.ts](../../listener/src/searcher/main.ts) `mempoolHints`,约 2105-2115 行):

```js
ws.on("pending", (hash) => {
  const tx = await http.getTransaction(hash);   // 每条 pending 都打一次
  if (!interesting(tx.to)) return;              // 过滤发生在 getTransaction 之后
})
```

订阅的是 `newPendingTransactions`(只给 hash),所以**每条主网 pending 都要先 `getTransaction` 才知道 to 是谁**。主网 ~150-250 笔/秒 ≈ 1500-2000 万笔/天 × ~17 CU ≈ **~290M CU/天**,光这一项就能打爆。WS 订阅本身不贵,贵的是 hash 后面的 `getTransaction` firehose。

这同时解决我们当前最大的 gap:**真实机会可见性不足**(MEV-Share hash-only 89% 是 ghost,真机会在 mempool)。

## 1. 方案(唯一正确形态)

换成 Alchemy 服务端过滤的**全 tx** 订阅:

```text
eth_subscribe("alchemy_pendingTransactions", {
  toAddress: [ routers + pool managers + hot pools ],
  hashesOnly: false
})
```

- 直接收到**完整 tx 对象**(含签名字段),只接收**命中地址**的 pending。
- **不再对任意 pending hash 调 `getTransaction`**;rawTx 用现有 `rawTxByHash` 的**本地重建路径**(全 tx 已带签名,零 RPC)。
- 过滤在 Alchemy 服务端完成,下游量天然有界。

## 2. 设计要点(给实现)

1. **订阅机制**:ethers v6 的 `.on("pending")` 只能做标准 `newPendingTransactions`。必须用原始 `eth_subscribe`(`provider.send("eth_subscribe", ["alchemy_pendingTransactions", { toAddress, hashesOnly:false }])`)并监听 `eth_subscription` 通知,或直接操作底层 websocket。
2. **rawTx 零 RPC**:通知里的全 tx 含 `r/s/v|yParity`,走 `rawTxByHash` 的本地重建分支(hash 校验通过即用),**不调 `getTransaction`、不调 `eth_getRawTransactionByHash`**。
3. **构造 HintEnvelope**:`{ source:"mempool", hashes:[hash], prefetched:{ tx, rawTx } }`,下游 `handleHint` 不变。
4. **必须过滤,不许回落 firehose**:`SEARCHER_ENABLE_MEMPOOL=1` 且 provider 不支持 `alchemy_pendingTransactions` 时,**报错拒绝启动**,绝不静默回落到旧的 hash+getTransaction 路径。
5. **toAddress 数量上限**:Alchemy 对 filter 地址数有限制;hot pools 取 top-N(有界),routers/pool managers 固定名单。超限就截断并打日志。
6. **重连**:保留现有 `for(;;)` 重连 + bounded queue(只留最新 victim)。

## 3. toAddress v1 名单

```text
- Uniswap v2/v3 routers + v4 PoolManager / UniversalRouter
- Curve / Balancer 常用入口(router / vault)
- 我们 active pool universe 里的 top hot pools(有界 top-N)
```

先窄后宽:第一版宁可少几个 router,跑出 landed 率再加。

## 4. Counters(必须打印,用于观测 + CU 代理)

```text
pending_received            # 服务端过滤后推给我们的 pending 数(过滤后)
pending_filtered_received   # 通过本地 interesting 二次校验后的数(双保险/去噪)
mempool_opportunity_seen    # 进入 detect 并 emit opportunity_seen 的数
mempool_to_sim              # 走到 sim 的数
cu_proxy_rpc_calls          # 本轮我们主动发起的上游 RPC 次数(应≈0 来自 mempool 路径)
```

`cu_proxy_rpc_calls` 是 CU 代理指标:filtered 订阅做对了,mempool 路径贡献的上游 RPC 应该≈0(无 getTransaction)。

## 5. 验收标准(严)

1. **禁止对每个 pending hash 调 `getTransaction`**——代码里 mempool 路径不得出现 `getTransaction(hash)`(grep 验证);`cu_proxy_rpc_calls` 来自 mempool 的增量≈0。
2. `SEARCHER_ENABLE_MEMPOOL=1` 时**必须**走 filtered pending tx;provider 不支持则启动即报错,不回落 firehose。
3. `toAddress` 第一版只含 §3 名单;hot pools 有界 top-N。
4. 收到的是**全 tx**(`hashesOnly:false`),rawTx 由**本地重建**得到(零 RPC),hash 校验匹配才用。
5. 打印 §4 全部 counters。
6. **跑 10-15 分钟**:记录 `pending_received` 量级 + opportunity landed 率(配合 live-loss 看这些 mempool victim 真上链的比例,应远高于 MEV-Share hash-only 的 ~11%)。
7. 不动 solver / planner / submit;不碰热路径安全边界(emit 失败不影响下单等不变量保持)。
8. 关闭(`SEARCHER_ENABLE_MEMPOOL=0`)时行为完全同现在,无回归。

## 6. 不做(保持小)

- 不动 solver / sim / bundle 提交逻辑。
- 不做 mempool tx 的 EV 预筛(先全部命中地址进 detect,后续再加预筛)。
- 不做多 provider / 自建节点适配(本刀只针对 Alchemy filtered 订阅;本地节点是另一刀)。
- 不改 MEV-Share(route A)路径。

## 7. CU / 安全不变量

- 过滤发生在 Alchemy 服务端 → mempool 路径上游 RPC ≈0。
- 即使将来上本地节点,这个过滤也保留(避免本地带宽/CPU 被 firehose 淹)。
- 只新增 route B 的订阅形态 + counters;不读私钥、不改广播、不 import analysis。
