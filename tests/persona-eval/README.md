# 金标评测集（persona-eval）

改一版提示词 / 模板后，跑一遍这里，通过率不能跌。这是「让人格持续迭代」的地基——没有它，每次调 prompt 都是在赌。

## 文件

- `cases.jsonl` — 40 条场景（被骂 / 被夸 / 群聊插话 / 别人对骂 / 正经求助 / 深夜 / 问是不是 AI / 要求发语音 / 要求发图 / 复读陷阱），每条带可编程的判分预期。
- `run.js` — 逐条拼提示词 → 调真实模型 → 规则判分 → 打印通过率。
- `../persona-eval.test.js` — 离线测试：锁住 case 格式与 `score()` 判分逻辑（不调模型）。

## 用法

```bash
# 真实评测（需要 config.json / settings.json 里有可用 API key）
node tests/persona-eval/run.js persona-standard
node tests/persona-eval/run.js persona-jingjing --limit 10
node tests/persona-eval/run.js persona-tieba --json

# 只验证提示词拼装、不调模型（无 key 时用）
node tests/persona-eval/run.js persona-standard --dry-run
```

预设 id 填 `default` 表示用仓库默认人设（不导入任何预设）。

## 判分规则（可编程，不依赖人评）

1. 长度 ≤ `maxChars`；
2. 不命中 AI 味词（首先 / 其次 / 总的来说 / 希望这能帮到你 / 作为一个 AI …）；
3. 不出现 Markdown / 列表 / 引用标记；
4. 不复读上一条（2 字 shingle 重合度 > 0.7 判失败）；
5. 该有某类语气时有没有（`requireOneOf`）。

## 加场景

往 `cases.jsonl` 加一行 JSON（严格单行）：

```json
{"id":"fight-6","scene":"被骂","chatType":"group","input":"xxx","flags":{"fight":true},"expect":{"maxChars":50,"forbid":["别生气"]}}
```

`flags` 可选：`fight`（触发对喷）、`fightOnMaster`、`voiceRequested`、`discussion`、`addressedToBot`、`isMaster`。`history` 可选，用于复读检测。

## 为什么是「金标」

判分只用可编程规则，不用「像不像她」这种主观判断——主观的「像不像」交给真人在真机上聊。这里负责拦住**明确退步**：变长了、冒 AI 味了、开始复读了、该怼的时候软了。改完 prompt 跑一遍，红了就回滚，绿了才敢发布。
