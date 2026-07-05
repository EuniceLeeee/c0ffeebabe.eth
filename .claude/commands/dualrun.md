对比编号: $ARGUMENTS

执行双跑对比流程:
1. 先**独立**回答上述编号对应的问题(问题原文见我接下来的消息或distill记录),不要先看Opus的答案
2. 独立作答完成后,读取Opus对同一问题的回答(我会提供或指出会话位置),按 docs/distill/TEMPLATE.md 建立记录 docs/distill/<编号>.md,完整填写:推理路径、工具序列、四层diff、根因归类
3. 提炼出的可迁移规则直接写入 CLAUDE.md 或 .claude/skills/mev-review/SKILL.md 对应位置(带来源编号);绑定当前代码的结论写入 docs/decision-log.md
4. 审查纪律:只记录影响正确性或既定需求的差距,不为了产出规则而制造规则
5. 最后提醒我归档两个会话的jsonl到 docs/distill/raw/
