# 🐋 鲸鲸 Whale Girl · dreaming-whale

> **DeepSeek 微信聊天机器人 / WeChat AI companion bot**：能自动回微信私聊和群聊，会逛 B 站、写日记、发表情包、发语音，还带一个 WPF 启动器。
> 内核 **CommonJS、零 npm 运行时依赖**，支持任意 OpenAI 兼容模型（DeepSeek / 智谱 GLM / Qwen / 本地 Ollama…）。

[![Version](https://img.shields.io/badge/version-4.0.8-blue)](package.json)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![GitHub](https://img.shields.io/badge/GitHub-M--INGJing%2Fdreaming--whale-181717)](https://github.com/M-INGJing/dreaming-whale)

---

## ⚠️ 仓库来源与版本（重要）

| 项 | 值 |
|---|---|
| **本仓库** | https://github.com/M-INGJing/dreaming-whale （下称“本 fork”） |
| **上游项目** | https://github.com/Banan1cee/whale_girl （原作者仓库） |
| **当前版本** | **4.0.8**（见 `package.json` / `CHANGELOG.md`） |
| **基于** | 上游 `Banan1cee/whale_girl` **4.0.8** 的模块化重构版 |
| **上游最新** | 上游已到 `4.1.6.1` / `4.2.0`，**仅作为参考，本 fork 尚未合并** |
| **发布/Issue/PR** | 全部走 **本 fork**；上游只读参考，不向其推送、不提 PR |

> 本 fork 在上游 4.0.8 的基础上加入了 B 站养鱼增强（日记 / 分享卡片 / 抽帧看画面）、能力系统、表情包收藏、语音回复等改动。
> 如果你要找原作者版本、安装包或最新发布，请访问上游：<https://github.com/Banan1cee/whale_girl>。
> **本仓库不发布官方安装包**，以源码运行 / 自行构建为主。

**搜索关键词**：鲸鲸、Whale Girl、DeepSeek 微信机器人、微信自动回复、微信群机器人、微信 AI 伴侣、B 站养鱼、B站机器人、表情包机器人、微信语音回复、WPF 启动器、Node.js 微信机器人、WeChat bot、WeChat AI companion、DeepSeek chatbot、Bilibili bot、zero dependencies、AGPL-3.0。

---

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 💬 **微信聊天** | 私聊 / 群聊自动回复，支持 @、连续消息合并、引用、防复读、情绪与关系记忆 |
| 🐟 **B 站养鱼** | 定时“醒着”刷推荐、读视频资料（标题/简介/字幕/热评）、写当天日记、每周小结；对高分视频用 ffmpeg 抽九宫格 + 视觉模型“看画面” |
| 📤 **B 站分享** | 把值得看的视频分享到主人私聊 / 白名单群；分享前先发“封面卡片 + 短链接” |
| 🧠 **能力系统** | 她能在聊天里自己判断要不要“逛 B 站 / 刷视频并分享 / 写日记”，用 `[[cap:id]]` 触发后台执行 |
| 🖼️ **表情包** | 收藏群友表情包（去重、自动分类、人工确认），按语气自动发表情 |
| 🎙️ **语音回复** | 可选 MiniMax / 硅基流动 / BreezeBlue 等 TTS，语音前自动清洗颜文字和 emoji |
| 🐚 **启动器** | WPF 启动器：状态、人设、模型 Key、B 站、能力、表情包、语音、诊断；不提供网页 UI |
| 📕 **小红书技能（实验）** | 命中“搜小红书 / 看第 N 条 / 发小红书”时调用本机 `xiaohongshu-mcp`，发布走“草稿 → 确认 → 发送” |
| 🔌 **多模型** | DeepSeek、智谱 GLM、Qwen、Kimi、Ollama 等 OpenAI 兼容接口，零 npm 依赖 |

---

## 🚀 快速开始（源码）

**环境**：Windows 10/11、Node.js ≥ 18、Python 3.12（桥接）、.NET 10 SDK 仅构建启动器时需要。

```powershell
git clone https://github.com/M-INGJing/dreaming-whale.git
cd dreaming-whale

# 1) 环境自检
node server.js --doctor

# 2) 启动内核（HTTP API：127.0.0.1:8787）
node server.js
```

微信收发需要桥接：

```powershell
python examples/wechatauto_bridge.py
```

或直接双击仓库根目录的 `WhaleLauncher.exe`，点右上角「启动」，启动器会一起拉起内核和桥接。首次使用建议先在演示模式跑通，再扫码/登录微信。

构建启动器 EXE（改了 `launcher/` 后必须重发）：

```powershell
dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher/publish `
  -p:PublishSingleFile=true -p:SelfContained=false
Copy-Item launcher/publish/WhaleLauncher.exe .\WhaleLauncher.exe -Force
```

详细步骤（装 SDK、常见错误）见 [docs/构建启动器EXE.md](docs/构建启动器EXE.md)。

---

## Project structure / 目录结构

```
.
├─ .gitattributes
├─ .gitignore
├─ .github
├─ AGENTS.md
├─ BUGS.md
├─ CHANGELOG.md
├─ CONTRIBUTING.md
├─ LICENSE
├─ README.md
├─ WhaleLauncher.exe
├─ config.example.json
├─ package.json
├─ requirements.txt
├─ server.js
├─ assets
├─ bridge
├─ docs
├─ examples
├─ installer
├─ launcher
├─ scripts
├─ src
├─ tests
└─ vendor
```

> `src/` 内核、`bridge/` Python 微信桥接、`launcher/` WPF 启动器、`docs/` 文档、`scripts/` 自检 / 发布 / 打包、`tests/` 回归测试、`vendor/` 本地依赖。运行时数据（聊天记忆、日记、表情包等）在 `data/`，不入库。

---

## 📚 文档

- [接入微信](docs/接入微信.md)
- [微信消息后台发送（UIA / PostMessage / WM_CHAR）](docs/微信消息后台发送.md)
- [B 站养鱼计划（含抽帧看画面）](docs/B站养鱼计划.md)
- [能力扩展规范](docs/能力扩展规范.md)
- [表情包收藏计划](docs/表情包收藏计划.md)
- [记忆系统](docs/记忆系统.md) · [架构总览](docs/架构总览.md)
- [构建启动器 EXE](docs/构建启动器EXE.md) · [打包与签名](docs/打包与签名.md)
- [变更记录](CHANGELOG.md) · [协作规范](docs/协作规范.md)

---

## ✅ 测试与检查

```powershell
node server.js --doctor
node scripts/check-layers.js
node scripts/privacy-scan.js .
node tests/bot.test.js            # 单文件跑；完整清单见 tests/
```

---

## 📄 许可证与来源

- 本项目沿用上游 **AGPL-3.0-only**，见 [LICENSE](LICENSE)。
- 原始项目：**鲸鲸 / Whale Girl**，作者与贡献者见上游仓库 <https://github.com/Banan1cee/whale_girl>。
- 本 fork 的修改与维护：<https://github.com/M-INGJing/dreaming-whale>。
- 二次分发请保留本文件、`LICENSE` 与上游版权声明；AGPL 要求修改后的网络服务也提供源码。

## Code signing policy

> 当前构建尚未签名（not signed yet）。签名策略、角色分工与验证方法见 [CODE_SIGNING_POLICY.md](docs/CODE_SIGNING_POLICY.md)。

## Download

> 本仓库不发布官方安装包，以源码运行 / 自行构建为主；下载、校验与安装说明见 [DOWNLOAD.md](docs/DOWNLOAD.md)。隐私声明见 [PRIVACY.md](PRIVACY.md)。

## ⚠️ 免责声明

微信自动化可能违反微信服务条款，存在账号被限制/封禁的风险；请仅用于个人学习与自用，不要用于骚扰、营销或批量操作。项目按“现状”提供，不对账号、数据或第三方服务损失负责。

---

## English summary

**Whale Girl (dreaming-whale fork)** is a DeepSeek-powered WeChat companion bot: automatic private/group replies, Bilibili “feeding” (watch videos, daily diary, weekly recap, frame extraction + vision), link-card style shares, sticker collection, voice replies, a WPF launcher, and an extensible capability system. Kernel is CommonJS with **zero npm runtime dependencies** and works with any OpenAI-compatible model. Version **4.0.8**, forked from <https://github.com/Banan1cee/whale_girl> (reference only; upstream has newer 4.1.x/4.2.x releases). This fork is maintained at <https://github.com/M-INGJing/dreaming-whale>. License: AGPL-3.0-only. Windows 10/11, Node.js ≥ 18, Python 3.12 for the bridge.
