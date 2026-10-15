# Yield Basis 与 DODO GSP 本批正确性

Yield Basis 的三个实际 WETH／cbBTC／WBTC LT 实例完成存入及普通赎回的指定收款路径，新增48次成功和48次严格声明拒绝；旧默认／quoted 的48次成功及24次拒绝通过程序、源码和执行器 artifact 认证复用。BTC 两图只借原生产输入金额，不冒称自然估值；非普通 exit 与 staking 范围不扩大。

DODO 两个注册 GSP 池的四方向完成32次指定收款成功及32次严格声明拒绝；旧16次默认／quoted执行认证复用。同历史状态反向注册关系、实际 clone 实现代码、完整输入扣款、返回值与实际到账绑定。普通 sellBase／sellQuote 不声明回调延迟付款，DSP／DVM／DPP 或 flashLoan 不由这两个 GSP 样本升级。

两族当前生产实现、独立原始余额复核和真实 BotVM 合成安全测试通过。报价／请求输入未减少，runtime 构造无链外 Exact 或报价回退；历史省略 effects 的拒绝不冒充独立存储回滚。原失败证据保留，工具 fixture 修复另绑定 LearningCase 与确切源码提交。自然集成、原交易机会、正式 Adapter Replay、4A／4B时效性继续分别记账。
