# 鲸鲸养鱼计划：把「刷 B 站 / 看视频 / 写日记」接进 whale_girl

> 状态：**P0 已完成（适配层 + 聊天接入），扫码登录与作息/日记待做**。参考项目：[`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale) 0.4.6（已 clone 到 `D:\workspace\whale\dsh-bili-whale`）。
> 已完成（2026-11-08）：
> - `src/adapters/bili/wbi.js` WBI 签名（官方测试向量 `ea1db124…` 对齐）
> - `src/adapters/bili/api.js` 客户端（cookie/Referer、全局限速、nav 密钥 10 分钟缓存、网络重试、`code!=0` 统一错误；未登录 `-101` 也能拿匿名签名密钥）
> - `src/adapters/bili/endpoints.js` 视频元信息 / 字幕 / 热评 / 一次取齐材料
> - `src/services/biliWatch.js` 视频资料 → 提示词片段（≤1200 字；无字幕时明确「没看画面」）
> - `features.bili` 开关（默认关）+ `chat.js` 接入：主人发 B 站链接 → 读资料再回复，读不到退回普通链接阅读
> - `src/infra/biliCookie.js` cookie 读写（只落 `data/bili/`、写 `.tmp` 再 rename、权限 600 尽力而为、永不打印）
> - `scripts/bili.js`：`view <BV|链接> [--json]`、`whoami`
> - `tests/bili-wbi.test.js`(7) + `tests/bili-api.test.js`(12) + `tests/bili-watch.test.js`(10) 全离线通过；实网用 `BV1GJ411x7h7` 验证过（213 字摘要、无字幕降级、热评 2 条）
> 下一步：P0.5 扫码登录（QR）→ P1 作息与日记。
> 本文只描述「怎么做、分几步、每步验收什么」，不含实现细节代码。

---

## 1. 目标与边界

### 1.1 要长成什么样

参考项目 VISION 的一句话：**「她带着你给她的视角去理解这个世界，然后回来站到你的身边。」** 落到鲸鲸身上：

- 有**作息**：只在自己醒着的时间窗里刷 B 站，一天醒一两次，不是 7×24 轮询；
- 有**偏好**：看什么由配置里的「喜欢/不喜欢」决定，权重最高的那一项就是主人的口味；
- 有**克制**：一天最多 @ 主人 3 次，沉默几天会自己安静下来（沉默衰减），偶尔「今天不想看」（`skipChance`）；
- 有**两本日记**：一本写给主人看（今天看了什么、想了什么），一本写给自己（偏好校准、情绪），落在本机文件里；
- 看得懂：视频元信息 → 字幕/简介/热评 → 结论，落到日记与分享里，而不是只报标题。

### 1.2 明确不做（第一版）

- **不做**：点赞、评论、发动态、私信、直播弹幕（写操作风控高，全部进 P3 且默认关）；
- **不做**：把 B 站 cookie 上传、写日志、进 git（只落 `data/`，gitignore）；
- **不做**：网页界面（whale_girl 4.0.2 起没有 WebUI，UI 改动只落在启动器 EXE）；
- **不做**：改动现有聊天主流程的语义；B 站能力默认关，关掉等于回到现在的样子。

### 1.3 与现有能力的关系

| 现有 | 复用方式 |
|---|---|
| `src/adapters/search/hotlists.js`（B 站热搜） | 保留；新模块独立，不动它 |
| `src/adapters/links.js`（b23.tv 识别为 video） | 复用链接识别，给「主人甩链接让她看」用 |
| `src/llm/client.js` | 看视频后的总结/日记/分享文案都走它 |
| 主动搭话通道（kernel `/api/care/due` + 桥接轮询发送） | P2 分享复用同一套「服务端判定、桥接发送」的模式，但用独立的 outbox 协议（带 claim/ack，防重复） |
| 记忆系统 `data/memory/` | 日记**不进**聊天记忆（记忆是按 chatId 隔离的），只把「分享出去的那条消息」自然进入主人私聊的会话记忆 |

---

## 2. 参考项目拆解（哪些抄、哪些重写）

`dsh-bili-whale` 是 DSH 插件（ESM + cordis），鲸鲸是 CommonJS + 零 npm 依赖 + Node 18 的内核，**不能直接依赖它**，只借设计。

| 参考模块 | 作用 | 鲸鲸怎么做 |
|---|---|---|
| `lib/client.js`(47KB) | B 站 API 客户端：feed、视频信息、字幕、评论、点赞、私信 | **重写**成 `src/adapters/bili/*`（只取 feed / view / 字幕 / 热评四类读接口） |
| `tools/lib/bili-api.mjs` | WBI 签名（`nav` 取 `wbi_img` → mixinKey → md5）、缓存、30s 超时 | **移植**成 `src/adapters/bili/wbi.js` + `api.js`（纯 `node:crypto`，无依赖） |
| `lib/scheduler.js`(39KB) | 生物钟、醒一次做什么、打分选视频、配额、沉默衰减、开摆 | **重写但保留判据**：`src/core/bili/*` 纯函数 + `src/services/bili/scheduler.js` 调度 |
| `tools/commands/feed.mjs` | 拉首页 feed、打分、筛 5 条 | `src/services/bili/feed.js` |
| `tools/commands/bili-watch.mjs` / `video-content.mjs` / `subtitles.mjs` | 看视频：元信息 → 字幕 → 总结 | `src/services/bili/watch.js` |
| `tools/commands/diary.mjs` | 两本日记 + 配额账 + 事件流 | `src/services/bili/diary.js` + `src/infra/biliStore.js` |
| `tools/commands/quota.mjs` | 读写配额、冷却、闸门 | `src/core/bili/quota.js`（纯函数） |
| `lib/auth.js` / 扫码登录 | 扫码拿 cookie | **第一版不做**，先支持手填 cookie（P3 再评估扫码） |
| `cordis.patch.yml` / 设置页 27 项 | DSH 插件装配 | 鲸鲸：`config.bili` 段 + `features.bili` 开关；启动器 B 站页放 P4 |

**关键取舍**：参考项目面向「B 站账号社交」，鲸鲸内核面向「微信聊天机器人」，所以第一版**只读**（feed/视频/字幕/热评），写操作全部延后。

---

## 3. 目标结构（文件落点）

```
src/
├─ adapters/bili/
│  ├─ wbi.js          # WBI 签名：mixinKey + 参数排序 + md5（纯函数，可单测）
│  ├─ api.js          # fetch 封装：cookie、超时、重试、全局限速、UA、错误归一
│  └─ endpoints.js    # 具体接口：feed、view、subtitles、hot-replies
├─ core/bili/
│  ├─ score.js        # 偏好打分（like/dislike/时长/UP 权重）、纯函数
│  ├─ quota.js        # 读/写预算、冷却、日界（纯函数，注入 now）
│  ├─ clock.js        # 作息窗口：now → 是否该醒、醒几次、开摆判定（纯函数）
│  └─ diaryFormat.js  # 两本日记的渲染（纯函数，便于单测）
├─ services/bili/
│  ├─ feed.js         # 拉 feed → 打分 → 选 N 条（含「看过的跳过」）
│  ├─ watch.js        # 看一条：元信息 + 字幕/简介/热评 → LLM 总结
│  ├─ diary.js        # 写两本日记 + 事件流（jsonl）
│  ├─ outbox.js       # 待分享队列：enqueue → claim → ack（幂等，模式同 stickers）
│  └─ scheduler.js    # tick：到点没？该醒？跑一轮「选→看→写→也许分享」
├─ infra/
│  ├─ biliStore.js    # data/bili/ 的读写：原子写、单实例锁、清理
│  └─ biliConfig.js   # bili 段默认值 + 归一化（不进 configSchema 的部分）
└─ http/routes/bili.js # 状态/手动触发/outbox/pending/ack（本机限定）

bridge/
└─ loop_mixin.py      # 新增 bili_watch：轮询 /api/bili/pending → 发给主人 → ack

data/bili/            # 全部 gitignore
├─ cookie.json        # B 站 cookie（仅本机，权限 600 语义；日志永不打印）
├─ state.json         # 作息游标、上次醒的时间、连续沉默天数、开摆记录
├─ quota.json         # 读/写预算账（按天/小时滚动）
├─ feed/YYYY-MM-DD.jsonl   # 每轮看到的候选（打分、是否被选中）
├─ videos/<BV>.json   # 看过的视频：元信息 + 字幕摘要 + 结论（去重用）
├─ diary/
│  ├─ owner.md        # 给主人看的那本
│  └─ self.md         # 给自己看的那本（偏好校准）
├─ events.jsonl      # 结构化事件流（看/想/写/分享/失败）
└─ outbox.json       # 待分享（claim/ack 两段式）
```

---

## 4. 核心设计

### 4.1 作息（clock.js）

- 时间窗可配（默认 `20:00–24:00`，跨午夜要支持）；
- 每窗 `wakes` 次（默认 1），醒的时刻在窗口内**随机抖动**（固定抖动种子，避免同一分钟）；
- `skipChance`（默认 0.3）：今天不看了，记一条 `events.jsonl`，不生成日记正文；
- 关掉开关 / 不在窗口 / 今天已醒够 → 直接返回 `idle`。

### 4.2 一轮「醒着」做什么（scheduler.js）

```
1. 判定：开关 on？在窗口？还有 wakes？预算够？
2. 拉 feed（1 次读，限速）
3. 打分：score = w_like·喜欢命中 + w_hot·热度 + w_fresh·新鲜 − w_dislike·不喜欢命中 − w_seen·看过
4. 取前 maxVideos（默认 5），深读其中 top N（默认 2）：元信息 → 字幕/简介/热评（各 1 次读）
5. 每条写 videos/<BV>.json（含 LLM 结论）
6. 写两本日记（owner.md 追加「今天看了什么/结论」；self.md 追加「偏好校准」）
7. 若分享条件满足（分数 ≥ minScore、今天未超 3 次、不在沉默期），入 outbox
8. 记账（quota.json）+ 事件流
```

### 4.3 打分（score.js，纯函数）

字段全部来自配置，权重可调但第一版写死默认值：

| 因子 | 默认权重 | 说明 |
|---|---:|---|
| `like` 命中 | 3 / 词 | 「你给她的视角」，权重最高 |
| `dislike` 命中 | −4 / 词 | 命中就不太可能被选 |
| 热度（播放/点赞分桶） | 0~3 | 对数分桶，避免大 UP 通吃 |
| 新鲜度（发布时间） | 0~2 | 24h 内满分，3 天外 0 |
| 已看过 | −∞ | `videos/<BV>.json` 存在则跳过 |
| 时长 | −? | 超过 `maxMinutes` 降权（看不了长视频） |

### 4.4 看视频（watch.js）

- 元信息：`/x/web-interface/wbi/view?bvid=`（WBI 签名）；
- 内容：优先字幕（`/x/player/wbi/v2` 的 subtitle 列表 → 拉 json），没有字幕退简介 + 热评（各 1 请求）；
- LLM 总结：走 `src/llm/client.js`，prompt 要求「只依据给出的材料，不编造；输出：一句话结论 + 3 条要点 + 值不值得分享」；
- 失败策略：字幕取不到就只用标题+简介，仍失败就只记「看过」，不写结论（不阻塞整轮）。

### 4.5 日记（diary.js）

- `owner.md`：按天一节，人可读，**只写结论与链接**，不抄字幕正文；
- `self.md`：偏好校准（「主人点赞/回复了哪类内容」→ 调 `preferences` 的软权重），以及情绪/开摆记录；
- `events.jsonl`：`{at, kind, bvid, note}`，给程序与后续统计用；
- 两本都有单日上限（防止 token 失控），超限只写摘要行。

### 4.6 分享（outbox.js + 桥接）

沿用 stickers 的两段式，避免重复发送：

```
kernel: outbox.json  [{id, at, text, bvid, status: pending|sending|sent|failed}]
bridge: 每 30s GET /api/bili/pending → 对每条 POST /api/bili/claim → send_text(主人私聊) → POST /api/bili/ack
```

- 分享目标**只允许主人私聊**（`persona.master.wxids` 第一个；为空则不发，记事件）；
- 频率：`shareDaily` 默认 3；两次分享最小间隔 2 小时；
- 文案由 LLM 生成（带视频链接），失败回退「标题 + 一句话 + 链接」模板；
- 分享完成后写 `owner.md` 一行「已分享」，并进主人私聊的正常会话记忆（它就是一条普通消息）。

### 4.7 沉默衰减

- `state.silentDays`：连续多少天没有主人的互动（主人没回消息/没点赞日记）→ 加分阈值提高、分享频率降低；
- 3 天开始降、7 天归零分享（只写日记不打扰）——和参考项目一致；
- 主人任意一次私聊（哪怕是「在吗」）都会重置。

---

## 5. 配置与开关

`config.json` 新增（全部有默认值，旧配置不写也能跑）：

```jsonc
"bili": {
  "enabled": false,              // 总开关（同时映射 features.bili）
  "cookieFile": "data/bili/cookie.json",
  "preferences": {
    "like": ["AI 工具与插件", "猫咪", "鬼畜与怀旧剪辑", "动画/模型"],
    "dislike": ["带货", "擦边", "标题党", "纯搬运"]
  },
  "night": { "windows": [{ "start": "20:00", "end": "24:00", "wakes": 1 }],
             "skipChance": 0.3, "maxVideos": 5, "maxWakesPerDay": 1, "maxMinutes": 30 },
  "share": { "enabled": true, "minScore": 13, "daily": 3, "minGapMinutes": 120,
             "silentAfterDays": 3,
             "chats": [] },          // 群白名单：[{ "chatId": "xxx@chatroom", "daily": 1 }]，空 = 只发主人
  "risk":  { "minGapMs": 1500, "readHourly": 120, "readDaily": 400,
             "writeHourly": 0, "writeDaily": 0, "writeGapSec": 120 },
  "diary": { "enabled": true, "ownerTitle": "鲸鲸的今天", "selfTitle": "只给自己看",
             "digestTokens": 200 },  // 聊天里被问到时的摘要上限
  "write": { "enabled": false }   // 写操作（点赞）总闸，第一版恒 false
}
```

`features` 新增三个开关（走 `src/infra/features.js` 的登记表，默认关）：

| key | 默认 | 作用 |
|---|---|---|
| `bili` | false | 总开关：关掉 = 不拉 feed、不写日记、不分享 |
| `biliShare` | false | 主动分享到微信（关掉仍然写日记） |
| `biliWrite` | false | 写操作总闸（P3 预留，第一版永远 false） |

`configSchema.js` 同步登记类型/范围（int/float/bool/enum），保证启动器填错会被挡。

---

## 6. HTTP 接口（本机限定，全部只回状态/计数）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bili/status` | 开关、窗口、今天醒了几次、预算剩余、日记条数（不返回正文） |
| POST | `/api/bili/run` | 手动跑一轮（`?dry=1` 只看会选什么） |
| POST | `/api/bili/look` | 看一条指定 BV（`{bvid}`），返回结论摘要 |
| GET | `/api/bili/pending` | 桥接取待分享（最多 1 条） |
| POST | `/api/bili/claim` | 领取（置 `sending`） |
| POST | `/api/bili/ack` | 回执 `{id, status: sent|failed, error}` |
| GET | `/api/bili/diary` | 只回**计数 + 最近标题**，不回正文（与记忆一致，不展示正文） |

---

## 7. 风控、隐私、免责

| 风险 | 处理 |
|---|---|
| B 站限流/风控 | 全局限速 `minGapMs=1500`；读预算 120/时、400/天；单轮最多 ~15 次请求；失败指数退避，连续失败自动停一天 |
| 写操作封号 | 第一版**没有**写操作；P3 也要 cookie 主人显式填 + `biliWrite=false` + 每视频只做一次 + 冷却 120s |
| cookie 泄露 | 只存 `data/bili/cookie.json`（gitignore）；日志/事件/错误信息一律不打印 cookie；接口不返回 cookie |
| 隐私 | 日记只在本机；`/api/bili/diary` 只回计数；导出/备份默认脱敏 |
| 版权 | 只存「结论 + 链接」，不存字幕全文、不落视频文件 |
| 与「养宠物」的边界 | 所有主动行为有每日上限；关掉开关立刻停；不因为开摆/沉默影响聊天主流程 |

---

## 8. 分阶段实施

### P0 · 只读「看一条视频」（约 1 天）

- `src/adapters/bili/{wbi,api,endpoints}.js`；WBI 单元测试（固定向量）；
- `scripts/bili.js view <BV|链接>`：命令行先跑通「元信息 + 字幕/简介 + LLM 结论」；
- 主人私聊甩 B 站链接 → 现有链接识别 → `services/bili/watch.js` → 回复「标题 + 一句话结论 + 3 条要点」；
- 无 cookie 也能跑（公开接口），失败给明确原因；
- 验收：链接消息能回来结论；`node --test` 全绿；不动动聊天的其它行为。

### P0.5 · 扫码登录（约 1 天，主人已选）

- `scripts/bili-login.js`：终端 ASCII 二维码 + `data/bili/qr.png`，轮询 180 秒，成功写 `data/bili/cookie.json`；
- 二维码编码器 vendor 到 `vendor/qrcode/`（MIT，带 MANIFEST，与 wechatauto 同一套校验方式），PNG 用 `node:zlib` 手写，不引入 npm 依赖；
- 验收：用真号扫一次能拿到 `SESSDATA`；`nav` 显示已登录；cookie 文件权限仅当前用户；事件流只有状态没有凭证。

### P1 · 作息与日记（约 2 天）

- `core/bili/{score,quota,clock,diaryFormat}.js` + `services/bili/{feed,diary,scheduler}.js`；
- 打开 `features.bili` 后按窗口醒一次，写两本日记到 `data/bili/diary/`；
- 验收：手动 `POST /api/bili/run?dry=1` 能看到打分与候选；真实跑一轮后 `owner.md` 有当天一节；关掉开关后不产生任何请求。

### P2 · 主动分享到微信（约 1 天，可发指定群）

- `services/bili/outbox.js` + `bridge/loop_mixin.py` 的 `bili_watch` + 三个接口；
- 目标：主人私聊（默认 3 条/天）+ `bili.share.chats` 白名单里的群（每群默认 1 条/天）；**不在白名单的群永不发送**；
- 全局限：两次分享最小间隔 2h；同一视频只分享一次（BV 去重）；群内分享文案更短（≤60 字）；
- 验收：幂等（重复 ack 不重发）、主人和指定群各收到一次带链接的消息、事件流有记录、非白名单群零请求。

### P2.5 · 日记问答（约 0.5 天，主人已选）

- `GET /api/bili/digest?date=today` 返回**当天摘要**（≤200 token，不是日记全文）；
- 聊天命中「今天看了什么 / 日记 / 最近在看啥」且 `features.bili` 打开时，把摘要注入最后一轮（走现有 soft block，不塞 system）；
- 关掉开关 / 当天没内容 → 不注入、不额外消耗 token；
- 验收：问「你今天看了啥」能答出当天 1~3 条；不相关的问题 prompt 里不出现 B 站块。

### P3 · 写操作（可选，约 2 天，默认关）

- 只有 `bili.write.enabled` 打开且 cookie 里有 `bili_jct` 才可用；先只做「点赞」一种；
- 每个视频最多一次、冷却 120s、日上限 3；所有写操作写事件流并在日记里记一行；
- 不做评论、不做私信、不做动态（风控与伦理都不划算）。

### P4 · 启动器「B 站」页（约 1 天）

- 开关、窗口、预算、日记计数（**不展示正文**）、"立刻跑一轮"、"扫码登录"（显示 P0.5 生成的二维码 PNG）；
- 按 AGENTS：只改 `launcher/`，需要 `dotnet publish` 重发 EXE；本机没 SDK 时只提交源码并标注「EXE 待发布」。

---

## 9. 测试计划（全部离线，mock 网络）

| 测试文件 | 覆盖 |
|---|---|
| `tests/bili-wbi.test.js` | 固定参数/密钥 → 固定 `w_rid`（防止签名漂移）；缺 key 报错 |
| `tests/bili-score.test.js` | 喜欢/不喜欢/热度/新鲜/看过/超时长的排序；空偏好 |
| `tests/bili-quota.test.js` | 日界/小时窗/冷却；超限返回拒绝原因 |
| `tests/bili-clock.test.js` | 窗口内/跨午夜/已醒够/开摆（固定随机源） |
| `tests/bili-diary.test.js` | 两本日记格式、单日上限、超限摘要行 |
| `tests/bili-outbox.test.js` | enqueue→claim→ack 幂等；claim 两次只有一次成功 |
| `tests/bili-watch.test.js` | 字幕缺失回退简介；LLM 失败不写结论；超时不阻塞 |
| `tests/bili-api.test.js` | 限速/超时/错误归一（mock fetch，不联网） |

另：`node scripts/check-layers.js` 必须通过（adapters 不依赖 services；core 纯函数）、`node scripts/privacy-scan.js .` 不能出现 cookie/真实 B 站 id。

## 10. 回滚

- 所有行为在 `features.bili` 后面，默认关；
- 关掉 = 不请求、不写日记、不分享，已写的 `data/bili/` 保留但不读；
- 代码分层独立，删掉 `src/{adapters,core,services}/bili/` 与 `http/routes/bili.js`、桥接的 `bili_watch` 即完全回滚。

---

## 11. 决策记录（2026-11-08 主人已拍板）

| 议题 | 决定 | 对计划的影响 |
|---|---|---|
| Cookie 怎么给 | **做扫码登录** | 新增 P0.5：二维码生成 + 轮询；Cookie 落 `data/bili/cookie.json`（明文、仅本机、永不进日志/接口）。第一版不做启动器图形页，先给 `scripts/bili-login.js`（终端 ASCII 二维码 + 保存 PNG），启动器页仍在 P4 |
| 写操作（点赞/评论/私信） | **先不做**，留到 P3 且默认关 | `bili.write.enabled` 第一版恒为 false；代码里不出现任何写接口调用 |
| 分享渠道 | **允许发到指定群**（白名单），默认仍只发主人私聊 | `bili.share.chats`：`[{ chatId, daily }]` 白名单；不在白名单的群永不被选；每群独立日上限（默认 1），主人私聊默认 3 |
| 日记能否被问到 | **可以**，按需注入当天摘要 | 新增 P2.5：`/api/bili/digest` + 聊天里命中「今天看了什么/日记」时，把**当天摘要**（≤200 token）注入最后一轮，而不是全文；关掉 `features.bili` 就不注入 |

### 11.1 扫码登录的落地细节（P0.5）

- 接口：`GET https://passport.bilibili.com/x/passport-login/web/qrcode/generate` → `{url, qrcode_key}`；轮询 `GET .../qrcode/poll?qrcode_key=…`，`code=0` 时从 `Set-Cookie` 收 `SESSDATA / bili_jct / DedeUserID`；
- 二维码渲染（零 npm 依赖的前提）：
  - 方案 A（默认）：vendor 一份 MIT 的纯 JS QR 编码器到 `vendor/qrcode/`（与 `vendor/wechatauto` 同样的「原样源码 + MANIFEST」模式），生成 PNG 用纯 Node 写（无第三方 PNG 库，手写 IHDR/IDAT+zlib）；
  - 方案 B（兜底）：终端 ASCII 二维码（直接在启动器日志里就能扫），PNG 仅在有需要时生成；
- 有效期 180 秒，过期自动重新生成一次；成功/失败都写 `data/bili/events.jsonl`（只写状态，不写 cookie）；
- Cookie 刷新：`SESSDATA` 过期时（`nav` 返回未登录）提示重新扫码，不静默重试。


