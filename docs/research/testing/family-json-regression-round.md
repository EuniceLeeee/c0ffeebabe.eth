# JSON Family 共用测试变更后的全族回归

共用测试或测试工具变更后，必须重新执行所有**实际接入 JSON 生产入口**的 Family。清单从当前生成器的 check 模式读取，包括默认关闭的已迁移族；不使用 live 启用名单，不把未切换的 JSON 草稿算作迁移完成，也不把相同族数当作同一名单。

## 固定流程

1. 固定当前源码、测试和样本。`family-json-regression.ts` 自动枚举生产入口、根/子变体和已收录历史样本。
2. 跑完整共用离线套件，并逐个导入每个 JSON 生产入口。它们只证明框架回归和定义可加载，不代表逐族实际执行通过。
3. 按完整清单串行运行现有 `protocol-json-acceptance.ts`，涵盖所有已收录可运行 case。由原入口校验同历史状态、Ready 指纹、指定金额 quote、quoted/runtime 和结算事实。批量层不复制数学、搜索、调度或验收逻辑。
4. 每族记录可运行样本数、已执行数、方向/变体、缺样本、未运行、失败及原始结果。单个实例缺方向导致的 `incomplete-or-failed` 保持不完整，不改成通过；Credit 暂无历史批量入口时明确保留缺项。
5. 新测试指纹使**全族旧回归报告失效**。报告检查同时比对生产源码、清单和样本指纹；运行前后源码必须一致。各轮独立目录，失败不覆盖，进程中断后 running/not-run 不算完成。
6. 只有离线套件、所有入口检查和全部已收录 case 通过且没有已知样本缺项，才能写“本轮提供的样本全部通过”。这仍不等于全变体验收、结算评审或时效性通过。

单改测试不会改变生产准入规则，不因此重建 Ready。每个历史 case 的 Ready 仍须通过原入口的当前生产指纹和 source 校验；不兼容时保留失败，再走现有必要更新流程。批量测试不自动发现候选、不修改 Ready、不启动 live、不签名广播。

## 一个统一入口

从仓库的 `listener` 目录执行；输出目录必须不存在，父目录由操作者预先建立。

```sh
# 只列出全族待跑清单；不发 RPC，不算验收。
node --import tsx src/searcher/test/family-json-regression.ts \
  --out ../logs/family-json-round-plan

# 完整共用套件 + 全族入口检查 + 现有历史 case 串行执行。
node --import tsx src/searcher/test/family-json-regression.ts \
  --run --bindings ../logs/family-json-bindings.json \
  --out ../logs/family-json-round-001

# 改了测试/源码/样本后，旧报告不能继续充当新版本通过证据。
node --import tsx src/searcher/test/family-json-regression.ts \
  --check-report ../logs/family-json-round-001/report.json
```

`bindings` 只提供原验收入口需要的本机文件位置，key 使用计划中的完整 case ID；不是 Family 白名单，没有条目的 case 保留未运行。RPC 凭据不写进样本、报告或 Git。

```json
{
  "version": 1,
  "cases": {
    "src/searcher/test/fixtures/protocol-json/cases/wsteth--wrap-original-input.json": {
      "ready": "/absolute/path/to/source-matched-ready.json",
      "rpcFile": "/absolute/path/to/existing-rpc-config",
      "revmBin": "/absolute/path/to/revm-sim"
    }
  }
}
```

没有 bindings 也可以执行全量离线与入口检查；历史样本均显示未运行，整轮退出码非零。该结果用于交接缺项，不能写成全族通过。报告保留每个 case 的原验收产物和日志，历史失败不会被后续成功覆盖。

## 负例必须证明是安全门拒绝

`runtime-program-testkit.ts` 的 `assertRuntimeGuardRejects` 识别具名 VM guard 和稳定 code。目前分类仅覆盖 `equality`、`uint256-range`；异常文案保持兼容。Fixture 错误、缺少 nativeBalance、ABI 解析错误或测试末尾余额断言不能作为 VM 拒绝证据，不提供虚构的默认余额或调用结果。

`declarative-execution-assets.test.ts` 的执行负例使用该 helper；正例仍独立核对实际扣款、到账和旧库存。`declarative-runtime-rejections.test.ts` 包含漏掉 equality 后旧 assert.throws 假通过、新 helper 必须失败的对照。其他拒绝类型没有被这次改动自动认证。

旧族测试可以更换入口、地址表示和内部对象布局，但要保留独立期望值和原有负例。不能只断言“生成字符串”“任意异常”或把 JSON 自己的输出同时作为被测值与预期值。
