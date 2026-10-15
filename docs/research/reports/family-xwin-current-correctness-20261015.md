# xWin 当前执行器正确性

N26075823实际Allocations部署、proxy实现和runtime已绑定；原Ready经当前入口重验。4组明确输入覆盖deposit/withdraw，两组库存和quoted/runtime共16正执行、8真实无输入嵌套调用拒绝。独立复核32条余额原始槽、完整输入与输出、协议调用、原生币、授权0/A/0及当前执行器metadata/source；runtime构造Exact/quoted/RPC均0。所选动作向调用者付款，无任意外部receiver或输出先给后的偿债callback，未新增不存在的能力。

当前缺口来自历史验收工具强制在Anvil懒加载fork上读取完整V3窗口：相同失败WETH请求同块在生产上游正常返回。最小工具改动提供显式fork/upstream只读传输枚举，默认fork不变；quote使用当前生产issuer/Family和固定N/hash，所有真实执行／资金／trace仍隔离同N fork。不改定价、窗口、请求金额、超时或生产价格表。原参数名被工具安全入口拒绝后只改公开枚举命名，并增加旧名／任意URL拒绝回归，安全检查保持不变。

原105配置失败、106读取超时、110入口拒绝均保留，未以成功覆盖。原16/8历史成果和paused正确拒绝保留；本次输入借用不称自然估值，N块末输出不冒称原TX输出。工具修复及独立复核绑定实际提交；原机会、正式Adapter Replay、4A／4B均未升级。
