# 🐋 鲸鲸 Whale Girl · dreaming-whale（中文）

> DeepSeek 微信聊天机器人：自动回私聊/群聊，会逛 B 站、写日记、发表情包、发语音，带 WPF 启动器。
> 内核 CommonJS、**零 npm 运行时依赖**，兼容任意 OpenAI 格式模型。

[English / 完整说明](README.md) · [变更记录](CHANGELOG.md) · [许可证](LICENSE)

---

## ⚠️ 仓库来源与版本

| 项 | 值 |
|---|---|
| **本仓库** | https://github.com/M-INGJing/dreaming-whale |
| **上游项目** | https://github.com/Banan1cee/whale_girl（原作者） |
| **当前版本** | **4.0.8** |
| **基于** | 上游 `Banan1cee/whale_girl` **4.0.8** 的模块化重构版 |
| **上游最新** | 4.1.6.1 / 4.2.0，**仅作参考，本 fork 尚未合并** |
| **发布 / Issue / PR** | 全部在本 fork；**不向上游推送、不提 PR** |

本 fork 额外包含：B 站养鱼增强（日记 / 分享卡片 / 高分视频抽帧看画面）、能力系统（`[[cap:id]]` 自主调用）、表情包收藏、语音回复等。
**本仓库不发布官方安装包**；安装包与最新发布请看上游：<https://github.com/Banan1cee/whale_girl>。

**搜索关键词**：鲸鲸、Whale Girl、DeepSeek 微信机器人、微信自动回复、微信群机器人、B站养鱼、B站机器人、表情包机器人、微信语音、WPF 启动器、WeChat bot、DeepSeek chatbot、Bilibili bot、AGPL-3.0。

---

## 功能

- 💬 微信私聊 / 群聊自动回复（@、连续消息合并、引用、情绪与记忆）
- 🐟 B 站养鱼：刷推荐、读视频资料、写当天日记、每周小结、ffmpeg 抽帧 + 视觉模型“看画面”
- 📤 B 站分享：主人私聊 / 白名单群，先发封面卡片再发短链接
- 🧠 能力系统：逛 B 站 / 刷视频并分享 / 写日记，聊天里由她判断是否触发
- 🖼️ 表情包收藏与按语气发送；🎙️ 可选 TTS 语音回复
- 🐚 WPF 启动器：状态、人设、模型 Key、B 站、能力、表情包、语音、诊断
- 📕 小红书技能（实验，需本机 `xiaohongshu-mcp`）
- 🔌 DeepSeek / 智谱 GLM / Qwen / Kimi / Ollama 等

---

## 快速开始（源码）

环境：Windows 10/11、Node.js ≥ 18、Python 3.12（桥接）；构建启动器才需要 .NET 10 SDK。

```powershell
git clone https://github.com/M-INGJing/dreaming-whale.git
cd dreaming-whale

node server.js --doctor     # 环境自检
node server.js              # 内核（127.0.0.1:8787）
python examples/wechatauto_bridge.py   # 微信桥接
```

也可以双击根目录 `WhaleLauncher.exe`，点右上角「启动」，启动器会一起拉起内核和桥接。

改了 `launcher/` 后重新发布 EXE：

```powershell
dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher/publish `
  -p:PublishSingleFile=true -p:SelfContained=false
Copy-Item launcher/publish/WhaleLauncher.exe .\WhaleLauncher.exe -Force
```

详见 [构建启动器EXE](docs/构建启动器EXE.md)。

---

## 文档

[接入微信](docs/接入微信.md) · [后台发送原理](docs/微信消息后台发送.md) · [B站养鱼计划](docs/B站养鱼计划.md) · [能力扩展规范](docs/能力扩展规范.md) · [表情包收藏](docs/表情包收藏计划.md) · [架构总览](docs/架构总览.md) · [CHANGELOG](CHANGELOG.md)

## 许可证

AGPL-3.0-only，见 [LICENSE](LICENSE)。原始项目与版权归上游作者及贡献者；本 fork 修改由 M-INGJing 维护。

## 免责声明

微信自动化可能违反微信服务条款，存在账号受限/封禁风险；请仅用于个人学习与自用。项目按“现状”提供，不对账号或数据损失负责。
