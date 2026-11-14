# 云服务器 RDP 断连后的「会话保活」方案（设计稿）

> 状态：**可行性已验证，设计待评审**。本文只讨论"让桌面会话保持活动"这一类方案（C 类），
> 不包含往微信进程注入内存的做法（账号风险，已排除）。
> 适用环境：阿里云 Windows Server 2022 + 微信 4.2 + 本项目 4.0.8。

---

## 1. 问题

用户通过 RDP 连接云服务器使用时，鲸鲸（含文字与表情包）发送正常；**断开 RDP 桌面后**，
文字仍能发（零焦点通道），但**表情包发不出去**，日志报：

```
表情包前台模式：微信未进入前台，本次未发送
UIA 发送未成功（第 1 次，1.6s），准备重试
键盘通道：抢不到前台，放弃这次
发送最终失败，请把微信窗口保持在桌面、别最小化
```

用户侧观察：断开时并没有最小化微信，重连后微信窗口也原样都在，但发送就是失败。

## 2. 根因（已实测）

RDP 断开会话后，Windows 把该会话的窗口统一标成"最小化"，并且**整台会话没有前台窗口**。

断开状态（23:57）实测：

| 观测项 | 值 |
|---|---|
| `qwinsta` 会话 3 | `Disc`（已断开） |
| `IsIconic(微信主窗)` | `True` |
| `GetWindowRect` | `(-32000, -32000, -31840, -31972)`（最小化的哨兵坐标） |
| `GetForegroundWindow()` | `0`（**没有前台窗口**） |

而发送链路里凡是 `require_foreground=True` 的分支都要求
`GetForegroundWindow() == 微信主窗`，在断连会话里这个条件**恒不成立**，于是：

- 表情包发送（`send_sticker` 强制前台）必然失败；
- UIA 发送的重试路径、键盘兜底通道也全部失败；
- 文字之所以还能发，是因为零焦点通道走 `WM_CHAR` + 控件坐标，不需要前台。

**结论：这不是微信的问题，也不是代码 bug，而是"会话处于 Disconnected 状态"导致桌面没有前台。**

## 3. 可行性验证（本次实测）

### 3.1 关键实验：`tscon <会话号> /dest:console`

把断连的 RDP 会话转移到 console（控制台），会话状态从 `Disc` 变成 `Active`：

```
BEFORE : session 3 = Disc          iconic=True   foreground=0
tscon 3 /dest:console   → exit 0
AFTER  : session 3 = console Active  iconic=True  foreground=0x6046c   ← 前台回来了
         进程存活：node(1520) / python(3088) / WhaleLauncher(3436)
```

### 3.2 会话 Active 之后，窗口可以被正常恢复

```
ShowWindow(hwnd, SW_RESTORE)  → iconic=False, rect=(76,69,940,521)
SetForegroundWindow(hwnd)     → fg=0xC0312, match=True
桥接心跳 window 状态          → 可见
```

**这是本方案成立的核心证据**：只要会话保持 Active，
`SW_RESTORE` 与 `SetForegroundWindow` 都能成功，
现有代码里的 `normalize_window()` / `force_foreground()` / 表情包前台路径即可正常工作，
**不需要修改 bridge 的发送逻辑**。

### 3.3 触发点可用

`Microsoft-Windows-TerminalServices-LocalSessionManager/Operational` 日志里，
事件序列稳定可依赖：

| 事件 ID | 含义 | 本次实例 |
|---|---|---|
| 24 | 会话已断开连接 | 23:58:06、23:40:02、23:06:59 |
| 25 | 会话重新连接成功 | 23:50:12、23:35:19、22:59:30 |
| 40 | 会话断开原因码 | 2147500036（断连）/ 5（重连接管） |
| 261 / 1149 | RDP 收到连接 / 身份验证成功 | 同上时段 |

⇒ 可以用"事件 24 触发计划任务"的方式自动执行 `tscon`。

---

## 4. 方案空间（C 类）

| 编号 | 方案 | 原理 | 优点 | 缺点 / 风险 | 结论 |
|---|---|---|---|---|---|
| **C1** | **断连即 `tscon` 到 console** | 会话转 console → Active → 前台恢复 | 实测有效；不改 bridge；成本低 | 需要计划任务；重连后需再次触发；`tscon` 会断开 RDP 连接（本来就是断的） | **推荐** |
| C2 | 用户改用 `mstsc /admin` 连 console 会话 | 让用户始终操作 console 会话 | 无脚本 | 用户习惯要改；`/admin` 连接在断开后是否仍转 Disc 需验证；不能自动化 | 备选 |
| C3 | 外部常连 RDP 客户端保活 | 另有一台机器长期挂着 RDP 连接 | 对服务器零改动；最贴近"真人一直在" | 需要额外机器/进程；断线重连要自己写；安全面变大 | 备选（C1 失效时） |
| C4 | 虚拟显示器驱动（IddSampleDriver / usbmmidd） | 给会话挂虚拟显示器 | 解决"无显示器时 console 无桌面" | 本机已有"Microsoft 基本显示适配器"，console 有桌面；驱动需签名/安装，收益不明确 | 暂不需要 |
| C5 | 修改 `send_sticker` 不再强制前台，断连时降级 | 代码层改 | 不依赖会话状态 | **不解决根因**：断连时 UIA/键盘/坐标点击本来就不可用，表情包仍需真实前台 | 与 C1 互补，不单独用 |

> C2 与 C3 都是"让会话保持 Active"的变体，与本方案目标一致；
> C4 只是解决显示渲染，不解决会话断连；C5 是代码层的防御性改造。

---

## 5. 推荐方案 C1 详细设计

### 5.1 组成

```
事件 24（LocalSessionManager：会话已断开）
   └─> 计划任务 WhaleKeepAlive-Tscon（SYSTEM / 最高权限，事件触发 + 3 秒延迟）
         └─> keepalive.ps1
               ├─ 用 WTSQuerySessionInformation 取「鲸鲸所在会话」状态（4=Disconnected）
               ├─ 不是断开状态 → 直接退出（不干扰正在使用的用户）
               ├─ 去抖：等 3 秒后复查，若已重连则退出
               ├─ tscon <sessionId> /dest:console
               └─ 结果写 C:\ProgramData\WhaleKeepAlive\keepalive.log
```

**纯事件驱动，不做定时轮询。** 漏触发由任务自身的「失败重试」（1 分钟 × 3 次）兜住；
极端情况下可用 `Start-ScheduledTask` 手动补一次。

### 5.2 触发条件（事件查询）

```xml
<QueryList>
  <Query Id="0" Path="Microsoft-Windows-TerminalServices-LocalSessionManager/Operational">
    <Select Path="Microsoft-Windows-TerminalServices-LocalSessionManager/Operational">
      *[System[(EventID=24)]]
    </Select>
  </Query>
</QueryList>
```

任务计划程序里建议再加一层过滤：`EventData/SessionID` 等于鲸鲸所在会话
（本机是 3；脚本里已改为**动态取启动器进程的 SessionId**，不写死）。

> 实测注意：`qwinsta /FO CSV` 在本机报「Invalid parameter(s)」，不能用它解析会话状态；
> 改用 `WTSQuerySessionInformationW(WTSConnectState)`（0=Active，4=Disconnected），
> 既可靠又不受系统语言/输出格式影响。

### 5.3 `keepalive.ps1` 实际逻辑（已产出，可直接运行）

```powershell
# 1) 以启动器进程为准，动态取「鲸鲸所在会话」（不写死会话号）
$proc = Get-Process WhaleLauncher -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Log 'WhaleLauncher 没在跑，跳过'; exit 0 }
$sessionId = $proc.SessionId

# 2) 会话不是 Disconnected（4）就什么都不做 —— 避免误踢正在使用的用户
if ((Get-WtsState $sessionId) -ne 4) { Log "会话 $sessionId 状态=..." ; exit 0 }

# 3) 去抖：事件触发时可能刚好赶上用户重连
Start-Sleep -Seconds 3
if ((Get-WtsState $sessionId) -ne 4) { Log '已恢复，跳过'; exit 0 }

# 4) 转移到 console
& tscon.exe $sessionId /dest:console
```

> ⚠️ 落地时踩到两个坑，已修：
> 1. `.ps1` 必须存成 **UTF-8 with BOM**，否则 PowerShell 5.1 的 `-File` 会按 ANSI/GBK 读，
>    中文注释被打乱后代码结构错位（表现为「脚本能跑但逻辑不对」）。
> 2. 不要手写 Task XML 再用 `Register-ScheduledTask -Xml`：本机 schema 对
>    `Description`/`URI` 顺序和 `DisallowStartOnRemoteAppSession` 等节点挑剔，
>    改用 `New-ScheduledTask*` + `MSFT_TaskEventTrigger` 构造最稳。


### 5.4 计划任务配置

| 项 | 值 |
|---|---|
| 名称 / 路径 | `WhaleKeepAlive-Tscon` @ `\Whale\` |
| 运行身份 | `SYSTEM`（`tscon` 需要 `SeTcbPrivilege`，SYSTEM 天然具备）+ `Highest` |
| 触发器 | **仅** 事件 24（见 5.2），`Delay=PT3S` 去抖；**无定时触发器** |
| 动作 | `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\ProgramData\WhaleKeepAlive\keepalive.ps1` |
| 条件 | 允许按需运行；不因电池/空闲停止 |
| 设置 | 失败后 1 分钟重试 3 次；多实例并行=忽略新实例（避免并发 tscon）；执行超时 2 分钟 |

### 5.4.1 已产出的落地文件

| 文件 | 说明 |
|---|---|
| `C:\ProgramData\WhaleKeepAlive\keepalive.ps1` | 保活脚本（UTF-8 **with BOM**） |
| `C:\ProgramData\WhaleKeepAlive\whale-keepalive.task.xml` | 任务定义（备份/审阅用；注册建议用 cmdlet） |
| `C:\ProgramData\WhaleKeepAlive\keepalive.log` | 运行日志（触发时间、会话状态、tscon 结果） |

启用 / 停用 / 回滚：

```powershell
# 启用（注册时是禁用状态，确认后再开）
Enable-ScheduledTask  -TaskName "WhaleKeepAlive-Tscon" -TaskPath "\Whale\"
# 停用（回滚）
Disable-ScheduledTask -TaskName "WhaleKeepAlive-Tscon" -TaskPath "\Whale\"
# 彻底删除
Unregister-ScheduledTask -TaskName "WhaleKeepAlive-Tscon" -TaskPath "\Whale\" -Confirm:$false
# 手动补触发一次
Start-ScheduledTask -TaskName "WhaleKeepAlive-Tscon" -TaskPath "\Whale\"
```


### 5.5 与现有代码的关系

**C1 不需要改 bridge**：

- 文字：零焦点通道本来就能在断连下发；
- 表情包：`send_sticker()` 发送前会 `force_foreground()`，会话 Active 后它能成功；
- 发送前的 `normalize_window()` 会 `SW_RESTORE`，我们已经验证会话 Active 后该调用有效。

**两处配套代码问题（已修复，2026-11-15）**：

1. ~~`features.stickers=true` 时 `STICKER_TEST_ON` 会把**所有**消息塞进 `require_foreground=True`
   分支，并跳过零焦点通道~~ → 已解耦：
   - `send_text` 不再看表情包开关，零焦点通道永远先试；
   - `with_window_on_top` 不再按开关强制前台；
   - 表情包仍由 `send_sticker` 自己抢前台；
   - 回归测试：`tests/test_send_channels.py`（AST 断言，防止开关被接回去）。
2. ~~心跳把断连会话报成"已最小化"~~ → 已修：
   - 新增 `window_state.describe_window(iconic, visible, disconnected)`；
   - 断连时显示 `已断连（RDP，会话无前台）`，真最小化/托盘才显示对应文案；
   - 单测：`tests/test_window_state.py`。


### 5.6 用户侧行为

- 断开：约 3~5 秒后会话转 console，鲸鲸恢复"能发图"状态；
- 重连：直接 `mstsc` 连回同一用户会话即可（`fSingleSessionPerUser=1`）；
  重连期间会话回到 RDP 模式，**再次断开时会重新触发**；
- 如果习惯连 console 会话，也可以用 `mstsc /admin`。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 误踢正在使用的用户 | 用户 RDP 被断开 | 只在会话状态=Disconnected 时动作；3 秒延迟 + 复查；任务多实例=忽略 |
| console 被占用 | `tscon` 失败 | 失败记日志；任务级失败重试（1 分钟 × 3 次）；必要时手动 `Start-ScheduledTask` |
| 事件漏触发 | 表情包再次发不出 | 失败重试兜住；日志可查；无轮询设计下不追求 100% 自愈 |
| 会话被超时终止 | 进程被杀 | 检查 `MaxDisconnectionTime` / `MaxIdleTime`（本机为空=不限制），并在文档中固化 |
| SYSTEM 任务权限过大 | 安全面 | 脚本固定路径、只调用 `tscon`/WTS API，不接收外部参数 |
| 微信本身被系统挂起 | UIA 仍不可用 | 保活后若仍失败，按 `bridge.log` 排查；可手动 `Start-ScheduledTask` 重试 |
| 表情包开关打开时全局强制前台 | 断连下所有消息都失败 | 见 5.5 第 1 条，代码层单独修 |

---

## 7. 验证计划

| 阶段 | 内容 | 通过标准 |
|---|---|---|
| P0（已完成） | 手动 `tscon` + `SW_RESTORE` + `SetForegroundWindow` | 会话 Active、前台=微信、心跳"可见" |
| P1（待做） | 启用任务 → 重连 → 断开 RDP 一次 | `keepalive.log` 出现「tscon N -> console exit=0」；会话 5 秒内变 Active |
| P2（待做） | 保持断连；从手机给鲸鲸发一条表情包指令 | 微信收到表情包，DB 回查到图片消息；日志无「未进入前台」 |
| P3 | 24 小时浸泡：每 30 分钟断/重连一次 | 无一次发送失败；无残留最小化窗口 |
| P4 | 回滚演练 | 禁用任务后行为恢复原状 |

**验收标准**：RDP 断开状态下，`/api/status` 的 `bridge.window` 不再长期为"已最小化"，
表情包消息能发到微信，且用户重连后桌面行为无异常。

---

## 8. 附：本次实测命令与输出（节选）

```text
# 断开状态
> qwinsta
  console                1  Conn
> Administrator          3  Disc

> python -c "win32gui.IsIconic(0xC0312)"  → True
> python -c "win32gui.GetWindowRect(...)"  → (-32000, -32000, -31840, -31972)
> python -c "win32gui.GetForegroundWindow()" → 0

# 转移会话
> tscon 3 /dest:console   → exit 0
> qwinsta
>console  Administrator  3  Active

> python -c "win32gui.GetForegroundWindow()" → 0x6046c

# 恢复窗口
> ShowWindow(0xC0312, SW_RESTORE) → iconic=False rect=(76,69,940,521)
> SetForegroundWindow(0xC0312)    → fg=0xC0312 match=True
> /api/status → bridge.online=True, uia=True, window=可见
```

---

## 9. 待决问题（评审时需要拍板）

1. 计划任务用 `SYSTEM` 还是"该用户 + 最高权限"？前者权限足够且无需密码，但审计面更大。
2. 任务当前是**禁用**状态，何时启用并做 P1/P2 实测？
3. 是否顺带做 5.5 的两处代码修正，还是先只上 C1 观察。
4. 是否需要在 `keepalive` 成功后主动通知桥接（当前不需要，发送前会自动恢复窗口）。

## 10. 变更记录

| 时间 | 变更 |
|---|---|
| 2026-11-15 00:10 | 按评审意见改为**纯事件驱动**（去掉每分钟轮询兜底，改用任务级失败重试）；补 5.3 实测落地逻辑、5.4.1 落地文件与启用/回滚命令、两个 PowerShell 落地坑。 |
| 2026-11-15 00:00 | 初稿：问题、根因、`tscon` 可行性实测、方案对比、C1 设计、风险、验证计划。 |

## 11. 实施记录（2026-11-15 00:52 ~ 01:05）

### 11.1 任务已启用

| 项 | 值 |
|---|---|
| 任务 | `\Whale\WhaleKeepAlive-Tscon`，State=**Ready** |
| 触发器 | 1 个 `MSFT_TaskEventTrigger`（EventID=24，Delay=PT3S） |
| 身份 | SYSTEM / Highest |
| 脚本 | `C:\ProgramData\WhaleKeepAlive\keepalive.ps1` |

### 11.2 P1：断连自动触发 —— 通过

用户于 `00:56:13` 断开 RDP（事件 24）。任务自动执行：

```
keepalive.log:
00:56:21 [pid 7784] tscon 2 -> console
00:56:25 [pid 7784] tscon exit=0

qwinsta:  >console  Administrator  2  Active      ← 由 Disc 变 Active
任务信息: LastResult=0
```

无需人工介入，约 8 秒内会话恢复 Active。

### 11.3 P2：断连状态下发图片 —— 通过（但有一个确认陷阱）

- `POST /api/stickers/test {"emotion":"happy","chat":"文件传输助手"}` 入队；
- 桥接发送后任务状态为 **`unconfirmed`**（"no new outgoing media message confirmed"），
  数据库回读也看不到新消息；
- 但 UIA 消息列表里明确出现 `01:01 / 图片` —— **图片确实已经发出**。

**原因**：日志持续出现 `WAL 合并失败（微信持续写入），改用仅主库快照（可能缺少最近消息）`，
数据库快照看不到最新写入，于是「回读校验」误判为未确认。
项目对此的策略是 **unconfirmed 不重试**（可能已发出，重试会重复发），所以这是**假阴性**，不是发送失败。

> 结论：在这台机器上（微信持续写入），**不能用数据库回读判断表情包是否发出**；
> 需要以 UIA 消息列表或对方客户端为准。

### 11.4 P1/P2 过程中发现的三个细节

1. **`tscon` 后聊天视图不会自动物化**
   实测 `read_ui` 节点数只有 76（正常 160+），输入框/当前会话读不到；
   **点一下会话行后立刻恢复到 146 节点**。
   - 文字回复：`send_text` 本身会 `open_chat`，所以会自动物化，**不受影响**；
   - 表情包：`send_sticker` 是「无导航」路径，要求目标会话**已打开**；
     若直接入队一个贴纸任务，会报 `exact target is not open in the pinned window`。
   - 实操含义：真实对话里「先发文字再发贴纸」没问题；单独测贴纸前需先让目标会话处于打开状态。

2. **运行副本必须是非工作区目录**
   期间发现误从工作区副本启动（Low 完整性 → `热激活 UIA 失败：未找到 Weixin.dll`）。
   已切回 `C:\dev\dreaming-whale`（High 完整性），并合并了期间产生的记忆（6 会话 / 624 条）。

3. **窗口最小化不会自动恢复**
   `tscon` 只恢复会话，不恢复窗口；桥接在发送前会 `normalize_window()`（`SW_RESTORE`），
   我们手工验证过：断连会话 Active 后 `SW_RESTORE` 与 `SetForegroundWindow` 都能成功。

### 11.5 P3：重连验证 —— 通过

用户 `01:06` 用普通 `mstsc` 重连，结果：**会话被接管，bot 未受影响**。

| 检查项 | 结果 |
|---|---|
| 会话 | `rdp-tcp#0 / Administrator / 2 / Active` —— 仍然是 **2 号会话** |
| 进程 | launcher `9136` / node `6560` / python `4612`，**PID 与创建时间均未变**（00:53 启动） |
| 服务 | `kernel=True / bridge=True / uia=True / window=可见`，uptime 连续，记忆 624 条 |
| 任务 | `01:06:34` 触发后**正确跳过**（`会话 2 状态=0（不是断开）`） |

结论：

- **重连不会顶掉 bot**（console 会话被 RDP 接管，进程原地存活）；
- 重连瞬间触发的 Event 24 被脚本的状态判定拦下，**不会误执行 tscon**；
- 因此不需要「登录自动启动」兜底，也不需要约定 `mstsc /admin`，普通 mstsc 即可。

### 11.6 最终验收

| 阶段 | 结果 |
|---|---|
| P0 手动 tscon + 前台恢复 | ✅ |
| P1 断连自动触发 | ✅ 8 秒内会话 Active，任务结果 0 |
| P2 断连发图片 | ✅ 消息列表出现「01:01 / 图片」（DB 回读为假阴性） |
| P3 重连存活 | ✅ 同会话接管，PID 不变，任务正确空跑 |
| P4 回滚 | 命令见 §5.4.1（`Disable-ScheduledTask` / `Unregister-ScheduledTask`） |
