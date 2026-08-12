# Phase E Pair A design：live execution 后端切到 strict publication 投影

## 目标

把 `revm-live-backend` 对 legacy `PRODUCTION_ADAPTER_FAMILIES.funding()/routes()`
的执行消费（prewarm 地址 + execution request）替换为 committed strict
publication 投影，随后删除 legacy funding/routes 消费。

## Gap（实测确认）

- `StrictFundingPublicationState.offers` 有 asset/maxBorrow/fee/actionAdapterId，
  `outcomes` 有 instanceKey/stateKey，但**没有执行 target / liquidityHolder**；
- `StrictShadowCatalogRouteHandle` 是 issuer-bound handle，但 live backend 需要
  `prewarmAddresses(request)` 这类 execution-facing 投影（legacy
  `adapter.prepared.prewarmAddresses`），strict 侧无对应 API；
- 因此不能机械替换 call-site，必须先在 strict 侧补齐 execution 投影。

## 设计

### 1. Funding execution projection

- 扩展 `FundingDomainSemantics` 增加可选
  `executionTargets(evidence): {target, liquidityHolder} | null`
  （family 插件声明，缺省 fail-closed）；
- `StrictFundingPublicationState` 增加 `executionTargets` 字段，在
  publication 组装时从 family 插件 + instance evidence 签发；
- `strictFundingPrewarmProjection(views, catalog)`：遍历 committed funding
  states，返回去重 target/holder 地址列表（缺失即跳过，不 fallback legacy）。

### 2. Route execution projection

- 扩展 Family 插件 execution 语义：`prewarmAddresses(request)` 由 strict
  route handle 对应的 family 插件提供（与 legacy prepared 语义对齐）；
- `strictRoutePrewarmProjection(views, hops)`：对每个 hop 用 committed
  handle 解析 family，取 prewarm 地址；handle 缺失即 fail-closed（不
  fallback legacy）。

### 3. Wiring

- `revm-live-backend` 新增 env gate（`SEARCHER_STRICT_LIVE_EXECUTION=1`）：
  有 committed publication 时用上述投影，否则 legacy；dry-run 验证后默认
  打开并删除 legacy funding/routes 消费。

## 验收

1. funding/route 投影合同测试（committed publication → 地址集合正确；
   evidence 缺失 fail-closed）；
2. `revm-live-backend` 在 env gate 下用 strict 投影完成 prewarm，逻辑与
   legacy 等价（合同级模拟）；
3. 节点 dry-run：开启 gate 跑 600s 串行对比，priced/edges/events 不劣于
   当前 challenger；
4. 删除 `revm-live-backend` 内 legacy funding/routes 消费，build/suite/
   sweep 全绿。
