# 双跑分支规范(可选参考,不是每问必走的仪式)

## 默认:不开分支
- **分析类问题**(为什么trace不一致/架构风险/方案评估)不产生代码改动,
  不需要分支。jsonl归档 + TEMPLATE记录已经足够复查。你的双跑大部分是这类。

## Opus要改代码:开一条
```bash
git checkout -b trial/0704-q01
# Opus作答+改代码,commit
# Fable审查:同分支直接看diff,给意见或追加commit(git log天然区分谁改的)
# 收尾:胜出则merge回main,否则删分支(想留历史先打tag)
```

## 仅当"两边从零各写一版完整实现"才开两条
(少见场景,遇到再用)
```bash
git checkout main
git checkout -b trial/0704-q01-opus    # Opus写它的版本
git checkout main
git checkout -b trial/0704-q01-fable   # Fable写它的版本
git diff trial/0704-q01-opus trial/0704-q01-fable   # 代码层对比
```

## 纪律(仅在开了分支时适用)
- trial分支不过夜,收尾纳入每日压缩检查
- 不在trial分支做与本问无关的改动
- main只进被验证过的方案
