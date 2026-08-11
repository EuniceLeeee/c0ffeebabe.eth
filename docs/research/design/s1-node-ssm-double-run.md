# S1 节点 SSM 双跑运行手册（dry-run 证据，非部署）

> 本窗口是 S1 落地（impl）的节点部署主导窗口。本手册只描述把同一
> manifest 在节点双侧 worktree 各跑一遍、生成并核验 `sealed-capture`
> parity receipt 的 dry-run 步骤。**不包含任何 live、签名或广播**；
> 节点部署/默认 authority 切换必须另行获得人工授权并遵守
> `docs/live-safety-envelope.md`。

## 1. 固定输入（以 impl HEAD 为准，提交前先核对 remote-tracking tip）

- impl branch：`codex/s1-unified-adapter-architecture-impl`
  - 本地 worktree：`/private/tmp/mev-s1-impl`
  - 节点 worktree：`/opt/MEV-impl-capture`
- baseline branch：`codex/parity-capture-baseline`
  - 本地 worktree：`/private/tmp/mev-parity-baseline`
  - 节点 worktree：`/opt/MEV-baseline-capture`
- manifest（已提交证据）：
  `docs/research/design/evidence/s1-parity-22family-manifest.json`
- 期望 receipt（已提交证据）：
  `docs/research/design/evidence/s1-parity-22family-receipt.json`
  （block `25729060`，aggregate=pass、22/22 pass、commonGraph=true、
  heldOutNegativeVerdicts=[]）
- 期望双侧 capture：
  `s1-parity-22family-baseline-side.json` /
  `s1-parity-22family-challenger-side.json`

## 2. 节点前置核验（只读，先做，禁止跳过）

1. `git -C /opt/MEV-impl-capture status --porcelain` 必须为空；
   `git -C /opt/MEV-baseline-capture status --porcelain` 必须为空。
2. `git -C /opt/MEV-impl-capture rev-parse HEAD` 必须等于
   impl remote-tracking tip；baseline 同理。
3. 核对 searcher 运行 PID / runtime commit / 锁文件：
   - 记录 `pgrep -af searcher` 输出与
     `SEARCHER_RUNTIME_COMMIT`；
   - 确认不存在未提交改动或占用 worktree 的进程（守护检查不得自行
     kill/停进程/清锁）。
4. 若节点上存在旧 manifest/receipt 输出，先移出输出目录，避免与本次
   证据混淆（`mv`，不删除）。

## 3. 节点双跑

```bash
set -euo pipefail
MANIFEST=/opt/MEV-impl-capture/docs/research/design/evidence/s1-parity-22family-manifest.json
OUT=/opt/MEV-s1-parity-22family-node
python3 /opt/MEV-impl-capture/scripts/run-migration-parity-multi.py \
  --manifest "$MANIFEST" \
  --baseline-dir /opt/MEV-baseline-capture \
  --impl-dir /opt/MEV-impl-capture \
  --out "$OUT"
```

## 4. 与已提交证据比对（必须全部一致）

```bash
diff -u /opt/MEV-impl-capture/docs/research/design/evidence/s1-parity-22family-receipt.json \
        "$OUT/parity-receipt.json"
diff -u /opt/MEV-impl-capture/docs/research/design/evidence/s1-parity-22family-baseline-side.json \
        "$OUT/baseline-side.json"
diff -u /opt/MEV-impl-capture/docs/research/design/evidence/s1-parity-22family-challenger-side.json \
        "$OUT/challenger-side.json"
```

也可以直接跑仓库内 verifier：

```bash
scripts/verify-s1-parity-receipt.sh \
  /opt/MEV-baseline-capture /opt/MEV-impl-capture "$OUT"
```

## 5. 证据记录与回写

- 记录 SSM run id、节点时间、两个 worktree HEAD、receipt SHA-256、
  `aggregate`、`nonPassFamilyIds`、`assembledCommonGraphParity`、
  `heldOutNegativeVerdicts`。
- 在 canonical 文档追加“节点机器证据 checkpoint”，引用 run id 与
  receipt hash；若与本地 receipt 不一致，先停下调查，不把节点输出
  覆盖为已提交证据。

## 6. 安全门

- 本手册只产出 dry-run 证据；不创建 live 部署、不签名、不广播。
- 默认 authority 切换必须同时满足
  `evaluateS1CutoverReadiness` 的 ready 条件，并取得新的人工授权。
- 任何 `ab/*` 之外的 stop/清理、进程重启、锁文件处理都必须先人工确认。
