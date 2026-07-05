# raw/ — 完整源数据归档(永不删除,永不进Opus上下文)

## 这里放什么
每次双跑的**完整会话记录**(jsonl),不是摘要。TEMPLATE记录是索引层,本目录是矿。

## 为什么全留
1. **反推:** 某条规则日后看起来可疑时,回到原始会话看当时的完整上下文,而不是信摘要
2. **重蒸馏:** 未来出现更强的模型/更好的方法时,拿raw重新提炼,不受当前TEMPLATE字段设计的限制
3. **7号后Fable不可随时在场,** 它留下的完整输出就是最高保真的参考物

## 怎么归档(Claude Code)
Claude Code自动把每个会话存成jsonl,位置:
```
~/.claude/projects/<按项目路径编码的目录>/<session-id>.jsonl
```
每次双跑结束后,把两个会话的jsonl拷进来并按编号重命名:

```bash
# 找到最近两个会话(按修改时间)
ls -t ~/.claude/projects/*/*.jsonl | head -2

# 归档(替换实际路径和编号)
cp <opus会话>.jsonl docs/distill/raw/0704-q01-opus.jsonl
cp <fable会话>.jsonl docs/distill/raw/0704-q01-fable.jsonl
```

建议做成shell alias或小脚本,双跑一结束就跑一下。

## 已知限制
Fable的原始思考链API不返回(只给摘要),jsonl里是它的可见输出+工具调用序列。
这已经是能拿到的最高保真度;工具序列和中间输出本身就承载了大部分推理路径。

## 命名规范
`MMDD-qNN-{opus|fable}.jsonl` — 与TEMPLATE记录编号一一对应
补充材料(trace输出、cast命令结果等)放 `MMDD-qNN-evidence/` 子目录
