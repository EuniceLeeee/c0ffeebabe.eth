# SQL edge 合并验收 · 2026-11-20

本次交接到 SQL 输出的候选边为止。接收端核对独立发现的完整 edge 集合、启用 selector 后的子集，以及 OpenChain 对未知 selector 的签名标注。

## 1. 对齐代码和输入

来源分支 `codex/impl-sql-trace-edges-20261120`，IMPL 基线 `1ce6bd77`。独立发现、调用方收支归属、证据归属精简依次在 `925b59d7`、`a8652fd0`、`5a2b3fb3`，最终过滤开关在 **`be86af44`**。已有部分改动的工作区可按入口和测试对齐，保留自身其他修改。只移植最后一笔提交需要接收端已有前三笔的发现实现。早期快照含同工作区的其他改动，按 `scripts/independent-trace-edges.mjs`、`scripts/audit-trace-edge-selectors.mjs`、它们的 SQL 依赖及专项测试移植即可。

从接收工作区根目录运行，使用项目锁定的 listener 依赖。默认全量发现和开启过滤共用 `scripts/independent-trace-edges.mjs`、输出 schema 和四项去重逻辑。过滤发生在 trace 和回执完成归属之后，全部内部调用仍能提供结算证据。过滤名单来自生成的生产模块、本进程的 Family 启用开关以及 Swap／Protocol 两个兑换域。

```bash
node --import ./listener/node_modules/tsx/dist/loader.mjs --test scripts/independent-trace-edges.test.mjs
```

源提交的专项回归共 **34 项，全部通过**。其中的 CLI 测试实际切换启用配置，检查全关时输出空集合、只开指定兑换 selector 时的名单，以及关闭过滤时原 SQL 字节一致。

以下固定历史窗口包含 **56,390,529 笔交易**。从北京时间 10 月 10 日至 11 月 9 日，含首尾日期，共 31 个自然日。先在临时目录生成 SQL 核对查询定义，这一步没有 BigQuery 费用。

```bash
case_dir=$(mktemp -d)
cat > "$case_dir/window.json" <<'JSON'
{"chainId":1,"fromBlock":26155910,"toBlock":26378389,"firstTime":"2026-10-09T16:00:11.000000Z","lastTime":"2026-11-09T15:59:59.000000Z","headHash":"0x62b23cae3b410e09f24910f072a94e2a65b68917a91168dda8648e0d5375c618","transactions":"56390529"}
JSON
for mode in full filtered; do
  flags=()
  if [ "$mode" = filtered ]; then flags+=(--live-selectors-only); fi
  node --import ./listener/node_modules/tsx/dist/loader.mjs scripts/independent-trace-edges.mjs \
    --window "$case_dir/window.json" --sql-only "${flags[@]}" > "$case_dir/$mode.sql"
done
```

源码默认启用 92 个兑换 selector。两份 SQL 只相差最终的 selector 谓词。去掉 CLI 附加的一个行尾换行后，源提交的 SQL SHA-256 分别是 `2caaafc1fa57b5a226fd917d08e3adb82bd075253b7720a4a6575e2969ad07c9` 和 `faa2c5ae9fc90798b2795e935777805ea3095ac7eb243cbfc6ce11bacfec020a`。接收端若更新过编译器或 SQL 实现，可直接用下一节的结果集合判定等价。自定义上架配置时，生成 SQL 的进程要加载与 live 相同的 Family 开关。此时按实际启用名单从全量集合取子集比对。

## 2. 核对 edge 完备性

固定窗口和启用名单后，对 SQL 实际导出的全量、过滤结果分别计算完整集合的摘要。独立发现 CLI 输出 `edges.json` 和 `manifest.json`。

| 指标 | 全量 | 开启过滤 |
| --- | ---: | ---: |
| 四项去重后的边 | 861,031 | 307,622 |
| 表内不同 selector | 13,302 | 77 |
| 重复键 | 0 | 0 |
| 排序后的完整键集合 SHA-256 | `f1d1cf9d45eaa66c41c11a7ad3a044885b417f6923c277be541c782ce2e33dd1` | `ce32feb370c590143d63d8cb315c038219b4fdd2736cb69ba98cd7079a5f455d` |

键是 **selector、池身份、tokenIn、tokenOut**。为便于跨语言校验，池身份展开为地址和完整 poolId 两列。以下命令对一行一条的 JSON 导出计算五列 TSV，空 poolId 用空字符串。使用小写十六进制、字节序排序、每行以 LF 结尾。保留重复行，方便查出生产端重复。

```bash
# INPUT 指向接收端本次导出的 .jsonl.gz，两个模式分别执行
gzip -dc "$INPUT" |
  jq -r '[.selector,.poolAddress,(.poolId // ""),.tokenIn,.tokenOut] | @tsv' |
  LC_ALL=C sort > "$case_dir/keys.tsv"
wc -l < "$case_dir/keys.tsv"
uniq -d "$case_dir/keys.tsv" | wc -l
shasum -a 256 "$case_dir/keys.tsv"
```

对 CLI 的 JSON 数组，可把前两行替换为 `jq -r '.[] | [.selector,.poolAddress,(.poolId // ""),.tokenIn,.tokenOut] | @tsv' "$INPUT"`。两个工作区若条数相同但摘要不同，用 `LC_ALL=C comm -3` 比较两份排序文件即可定位具体差异。

还要核对证据语义。独立发现只从成功调用及其回执建立候选，不并入旧 SQL 或 Ready。独立池按地址、共享池按 manager／vault 和完整 poolId。V4 将 PoolKey 哈希与 Swap 事件核对。原生 ETH 与 WETH 分账。同一地址的多次动作按调用各自归属，唯一预付只用一次，金额差额需要调用、成交事件和实际收支绑定。发现行保留 `observedTargetSelector=true`、`verified=false`，模拟准入属于后续阶段。

已核对的功能对照如下。

- 区块 `26309467` 的交易 `0x8d7d57966956639225a1e260c16837d67286665301c54b103d801a158a964690` 应同时得到 wstETH unwrap 的 `0xde0e9a3e` 和 wrap 的 `0xea598cb0`，各自的 token 方向相反。
- 在全量模式，已有报价且区间内确认成交的 1,740 个目标方向命中 **1,626**，已知缺口 **114**。18 个历史负对照命中 **0**。这里“齐平”指复现这份覆盖。若接收端新增或少了方向，请交付差集与对应交易证据。
- `a8652fd0` 与 `5a2b3fb3` 的已归档全区间逐笔比较覆盖 56,390,529 笔，输出不同的交易为 0。接收端改动 UDF 且需要验证证据也等价时，对同批输入比较每笔的调用路径、原始金额、池身份、receiptIndices 和证据类型。四项键摘要只证明集合等价。

## 3. 核对 OpenChain

独立入口是 `scripts/audit-trace-edge-selectors.mjs`。本地有定义就使用本地签名。对全量表中本地未知的 selector，显式开启 `--openchain` 后按最多 25 个一批调用 Sourcify 的签名查询端点。用 Keccak 回算前四字节，保留全部匹配签名。结果是候选函数签名，不能据此确定合约的完整 ABI、上架状态或可执行性。

```bash
cat > "$case_dir/selector-sample.json" <<'JSON'
[{"selector":"0x022c0d9f"},{"selector":"0x34fcd5be"},{"selector":"0x42966c68"},{"selector":"0x47ee97ff"},{"selector":"0x34fcd5be"}]
JSON
node scripts/audit-trace-edge-selectors.mjs --edges "$case_dir/selector-sample.json" \
  --openchain --out "$case_dir/labels.json"
```

本次实查 `0x022c0d9f` 走本地，`0x34fcd5be` 的两行合并计数为 2 并命中 `executeBatch((address,uint256,bytes)[])`。`0x42966c68` 同时保留 `burn(uint256)` 与 `collate_propagate_storage(bytes16)`。`0x47ee97ff` 当天返回 `unresolved`。服务不可用应记录 `unavailable`。签名库可能增补，比较时逐条验哈希。审计只写 labels，开启或关闭它时原 edge 集合摘要应一致。输入为 JSON 数组。已有压缩逐行导出时，可先从全量表抽取待查 selector 做小样。

全窗口的 13,302 个 selector 中，102 个出现在当时完整本地目录，13,200 个本地未知。历史实查的是按边数排序的未知前 25 个，其中 20 个返回匹配签名、5 个未解析。77 是启用后实际有边的兑换 selector 数，和本地目录匹配数各有口径。

## 4. 接收端回执

请给出接收提交、区间及块哈希、实际启用的兑换 selector 数、专项回归结果、两个 SQL 输出的边数／重复数／键摘要，以及 OpenChain 样本结果。启用名单有变动时，按本次实际名单从全量表取子集核对。

同机可复用来源工作区 `/Users/eunice/.codex/worktrees/impl-sql-20261119/MEV` 下的本地证据。全量导出在 `logs/ready20-caller-full-20261120/edges.jsonl.gz`，目标方向样本统计在同目录 `comparison.json`，历史签名抽查在 `logs/ready20-redundancy-20261120/unknown-top25-results.json`。这些运行产物未随 Git 分发。仓库本身可以独立运行专项回归、生成两种 SQL 并执行签名查询。
