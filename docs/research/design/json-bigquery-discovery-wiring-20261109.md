# JSON discovery：BigQuery 与 Ready 共用接线

实现提交：`b2b21b6fdb11ce1c7e4c2dc69aa5fec76de27a98`。本次修复查询端发现与验收登记入口；未运行历史全量扫描、重建生产 Ready、启动 live 或广播。

## 规则归属与调用顺序

SQL 仅投影交易输入、调用生成的 discovery kernel、归并候选及其见证。SQL 不定义协议名、selector、事件 ABI、池子名单或准入条件。发现结果只是提名，随后仍由当前 Ready 的反向绑定、身份及行为证明决定准入。

1. `scripts/ready-family-activation.mjs` 在导入 Catalog 前解析生产入口的 activation 声明，兼容手写属性与 JSON 生成入口的带引号属性。动态或含糊声明拒绝；不再用格式相关正则。原 BigQuery 启动器启用全部发现族的范围保持不变。
2. `scripts/ready-bigquery.mjs` 使用该公共入口和节点 RPC 身份验证。旧 REVM binary 参数明确拒绝。分页 hash 链、输入表 pin、断点恢复和已有 Ready 复用继续保留。
3. `scripts/ready-discovery-udf-build.mjs` 从 capability package 读取发现能力的根。对于 JSON 编译器，核对真实 production entry 的编译函数、根 JSON 和有序子 JSON，再实例化 discovery；不把函数本身冒充 discovery 对象。手写 TS 族仍通过相同接口接入。
4. `listener/src/searcher/venues/declarative-family-discovery.ts` 的 `assembleDeclarativeDiscovery()` 同时供生产 Family 和查询投影调用。`compileDeclarativeFamilyDiscovery()` 只装配发现所需定义、值及适用的声明模块；查询端不加载身份、报价和执行调度。
5. kernel 复用生产 Catalog 匹配、候选解码、实例 key、fingerprint 和交易资料读取函数。`scripts/ready-opaque-nominations.mjs` 由流式启动器及 kernel 共用：按声明的 emitter、起始块和 indexed bytes32 保留反查见证。错误 emitter、缺失／畸形 poolId、失败交易不能产生该提名。
6. `scripts/ready-discovery-udf.sql` 消费 kernel 输出。Family 级去重键仍保留，两个 Family 的独立提名不会互相覆盖。查询端不发链上 RPC，不授予身份。

## JSON／公共 TS 补齐的能力

V4 两份 JSON 现在显式声明已有 PoolManager 的事件 emitter、反查能力及精确交易 trace fallback。公共 TS 解释这些声明，没有增加 V4 名称分支。

反查先尝试声明的地址读取流程；失败时只读取提名携带的那一笔交易。候选必须同时匹配目标合约和完整 instance key，随后继续严格身份验证。没有交易证据或匹配失败时保留未解析结果，不扫描历史 Initialize、不猜池、不直接准入。

保留 Ready 的通用 `address` 外壳可参与当前 JSON 的实例分组；只补声明的地址字段，不补其他身份字段。该兼容不应用于候选解码或身份授权。

## BigQuery 运行资源

真实 BigQuery 首次验证发现单一 1.6 MB UDF 超过服务的单资源限制。生成器现把静态 JSON 定义拆成不超过 900,000 字节的资源，kernel 单件限制为 1 MiB；按 `build-provenance.json.resources` 的顺序加载。各资源、输入源码和提取函数均保留 hash；没有 eval 或动态协议脚本。

`scripts/ready-discovery-udf-smoke.mjs` 只执行测试目录预存的交易行，校验上传资源的回读 hash，记录实际 BigQuery job。它不查询历史表，不证明链上身份或执行。

## 样本登记门禁

`protocol-json-sample-registration.ts` 允许现有 index 条目或测试目录中的独立 fixture。单独放进 Protocol／Swap cases 目录但不登记 index，不能绕到 fixture 模式。

runner 在执行前与结束后核对输入、case／index hash；批量分类和 `--check-report` 还会重读事实证据与当前登记，核对实际进程退出码，不能仅信缓存的 pass。样本可以后来补充并重新验收；没有“永远必须在最早运行之前登记”的时间要求。登记本身不是执行通过。

## 验证结果与边界

| 验证 | 结果 |
|---|---|
| 当前云端生产 build | 通过 |
| 交付源码能力清单重新生成及 check | 通过；49 族、0 issues；27 族的 192 个能力指纹发生合法更新，未伪装成旧 hash |
| BigQuery 公共入口测试 | 33／33；49 个已提交 capability 根，471 组输入；candidate 和 opaque 逐字段与生产入口一致 |
| 登记／报告复核／实例分组专项 | 29／29 |
| 完整 `universe-rebuild-production` | 通过；包含两个实际 provider 的 fatal 排队隔离、V4 反查正反例及扫描→严格验证→Graph 接线 |
| 云端当前 dirty 基线的全量 JSON 套件 | 733 项：731 通过、1 失败、1 跳过；失败为原有未跟踪 `badger-sett-withdraw.generated.ts` 孤立类型文件，原文件保留 |
| 精确交付提交的只读归档，全量 JSON 套件 | 755 项：754 通过、0 失败、1 跳过；没有删除或改写实际工作区的他人产物 |
| 精确提交的 BigQuery 真实执行 | 11 笔已登记历史交易输入，39 条候选＋4 条 opaque，与本地相同 kernel 一致；扫描／计费字节均 0，slotMs=3906 |

PSM 测试资料已补当前 pocket／scale 以及两金额×双方向的节点模拟回执；保留 getter-only 和少到账 1 单位不能准入的负例。回执是合成测试数据，只证明接线，不作为 PSM 新的历史行为验收。

真实 BigQuery 成功 job：`mev_json_discovery_86ab2cf2385f99d5ccde10d6`。

- kernel SHA-256：`3453ebdb1e3324154b34feff1b32408ad08f3b4ead33e19cc031b78d411b99b1`
- fixture SHA-256：`4b55b5a2d6c206dd3953ab6acf61e7c66c8d2b5ededdd81a233e89d50899094a`
- 1 MiB 失败 job 保留：`mev_json_discovery_f0706b7fbf2226e83f909840`；不以成功重跑覆盖。

查询语义与资源大小已验证；11 行运行不代表全量 30 天查询的成本或时效性。49 个已提交根以外，实际 dirty 工作区另有他人未完成条目，本次不把它们算成通过，也不覆盖其 generated/catalog。

提交中的 generated 清单来自精确交付源码的生成结果；再用该新清单跑 BigQuery 33 项测试通过。实际工作区他人未提交的 generated 文件字节保留，未以交付清单覆盖。其工作区版本仍需在相应增量收尾时正常生成，不能据本次提交宣称整份 dirty 树已通过 catalog check。

## 工具复核

按 `bigquery,json,universe,rebuild,production` 查询当前工具目录，实际执行 `listener:test:bigquery-json`、`listener:searcher:universe-rebuild-production`、`listener:test:family-json`。前两者通过；第三者保留上述 dirty 基线失败。精确提交归档另行执行全量套件通过。

云端 manifest：`logs/json-bigquery-wiring-20261109/tool-selection.json`，SHA-256 `946e8d4e6e4387dc624068e2e8af86bdfbc74f16e61280a0049ea53274eab436`。本地与云端的原始输出均保留于同名 ignored 日志目录。工具缺陷及修复提交登记于相邻 reports 中的 `json-bigquery-tooling-defects-20261109.json`。
