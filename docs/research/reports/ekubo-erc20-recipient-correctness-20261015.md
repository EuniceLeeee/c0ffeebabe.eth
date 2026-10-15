# Ekubo ERC20 指定收款正确性

实际无扩展 USDC/0xd9fcd… 池的两方向、自收／外收适配正确性完成。新 direct 分支补齐正额完整扣款、Router双int128返回值、实际收款、旧库存与原生币保护，临时授权精确为请求量并清零。无协议相关中央分支；原生币、默认及quoted路径保留。

N25943731 的4个输入共8次正执行、8次严格声明拒绝。非作者独立核对16个完整请求金额、64个实际余额差与Transfer、Core打包有符号事件及授权清零。报价等于实际到账，交易内构造Exact/quoted/RPC均为0，无quoted fallback。原raw2/effective0保留，手工与其他图来源仅借输入金额。

真实BotVM配合合成Router/token，本地4个EVM测试函数通过：12个正组合、52个故障、4个零额和4个原程序无输入；验证全部状态回滚。历史拒绝为strict声明Revert，不冒称历史独立storage diff。旧4组quoted/default程序与原执行相同；native36个程序逐字节相同并通过3个本地EVM回归，复用旧native历史8正8拒绝，未重复跑历史。

Core回调仅到Router，不能让调用方续接付款；quote-output与deferred-input保持不支持。没有真实实例的额外extension不作新增必补缺口。自然估值、原交易机会、Adapter Replay和4A/4B性能另列，均不由本批升级。未部署、启动live、签名或广播。
