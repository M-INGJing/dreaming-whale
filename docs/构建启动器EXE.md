# 构建启动器 EXE（WhaleLauncher）

> 适用：Windows 10/11 x64。启动器是 WPF（`net10.0-windows`），只能在 Windows 上构建。
> 这份文档只讲「怎么把 `launcher/` 的源码变成可双击的 `WhaleLauncher.exe`」。
> 打包成安装包 / 签名见 `docs/打包与签名.md`。

---

## 0. 一分钟版（已经装好 .NET 10 SDK 的人）

```powershell
cd D:\workspace\whale\whale_girl

# 1) 编译检查（CI 也跑这个）
dotnet build launcher/WhaleLauncher.csproj -c Release

# 2) 发布单文件 EXE（框架依赖）
dotnet publish launcher/WhaleLauncher.csproj -c Release `
  -o launcher/publish -p:PublishSingleFile=true -p:SelfContained=false

# 3) 覆盖到用户直接运行的那份（先关启动器！）
Copy-Item launcher/publish/WhaleLauncher.exe .\WhaleLauncher.exe -Force
```

产物：

- `launcher/publish/WhaleLauncher.exe`：发布产物（仓库跟踪）；
- `WhaleLauncher.exe`（仓库根目录）：最终发给用户、双击运行的那份。

> **不要用 `dotnet publish` 默认参数**：那会把 `WhaleLauncher.dll`、`.deps.json` 等拆出来，
> 只发一个 exe 是起不来的。必须带 `-p:PublishSingleFile=true -p:SelfContained=false`。

---

## 1. 准备 .NET 10 SDK

### 方式 A：winget（推荐，装到系统）

```powershell
winget install Microsoft.DotNet.SDK.10
```

装完**重开一个终端**，确认：

```powershell
dotnet --list-sdks
# 应看到 10.0.x [C:\Program Files\dotnet\sdk]
```

### 方式 B：dotnet-install（不需要管理员，装到当前用户）

```powershell
$dir = "$env:LOCALAPPDATA\Microsoft\dotnet"
$script = "$env:TEMP\dotnet-install.ps1"

# 国内网络如果访问 dot.net 慢，可先设代理：
# $env:HTTPS_PROXY = "http://127.0.0.1:7897"

curl.exe -sL -o $script https://dot.net/v1/dotnet-install.ps1
& $script -Channel 10.0 -InstallDir $dir -NoPath

# 之后用这个 dotnet（不写进 PATH，避免影响别的项目）
& "$dir\dotnet.exe" --list-sdks
```

下文所有 `dotnet` 命令，如果 SDK 装在用户目录，替换成 `& "$env:LOCALAPPDATA\Microsoft\dotnet\dotnet.exe"`。

### 运行环境（框架依赖发布需要）

最终用户机器需要 **.NET 10 Desktop Runtime（Windows Desktop）**。
启动器发布时是 `SelfContained=false`，不把运行时打进 exe。

---

## 2. 项目结构

| 文件 | 作用 |
|---|---|
| `launcher/WhaleLauncher.csproj` | 目标框架 `net10.0-windows`、`UseWPF`、单文件发布注释、版本号、图标、`NAudio` 依赖 |
| `launcher/App.xaml` | 全局样式 / 主题资源 |
| `launcher/MainWindow.xaml(.cs)` | 主窗口、导航、内核启停 |
| `launcher/Views/*.xaml(.cs)` | 各功能页（状态、人设、表情包、B 站、能力…） |
| `launcher/Assets/app.ico` | 窗口/任务栏/exe 图标 |
| `launcher/publish/WhaleLauncher.exe` | 发布产物（入库） |
| `WhaleLauncher.exe` | 根目录成品（入库，用户双击的就是它） |

`launcher/bin`、`launcher/obj` 是中间产物，**不要提交**（`.gitignore` 已排除，且会带入本机绝对路径）。

---

## 3. 编译（不发布）

```powershell
cd D:\workspace\whale\whale_girl
dotnet build launcher/WhaleLauncher.csproj -c Release
```

成功会输出：

```
WhaleLauncher -> ...\launcher\bin\Release\net10.0-windows\WhaleLauncher.dll
已成功生成。
```

- 只检查能不能编译时用这个就够了（CI `tests.yml` 也是 `dotnet build`）；
- 首次构建会从 NuGet 还原 `NAudio 2.2.1`，需要联网；之后有缓存可以加 `--no-restore`。

---

## 4. 发布单文件 EXE

```powershell
dotnet publish launcher/WhaleLauncher.csproj -c Release `
  -o launcher/publish `
  -p:PublishSingleFile=true `
  -p:SelfContained=false
```

说明：

- `-o launcher/publish`：输出到仓库跟踪的发布目录；
- `-p:PublishSingleFile=true`：把依赖打进一个 exe；
- `-p:SelfContained=false`：不打包 .NET 运行时（体积小，要求用户装 Desktop Runtime）。

发布完成应只有一个 `launcher/publish/WhaleLauncher.exe`（可能还有少量原生依赖，按项目当前配置应只有一个 exe）。

---

## 5. 覆盖根目录成品（最容易漏）

根目录的 `WhaleLauncher.exe` 才是用户双击的文件；**只更新 `launcher/publish` 不够**：

```powershell
Copy-Item launcher/publish/WhaleLauncher.exe .\WhaleLauncher.exe -Force
```

如果报「文件正由另一进程使用」：

1. 完全退出启动器（窗口 + 托盘）；
2. 再执行 `Copy-Item`；
3. 或者先把新 exe 放成 `WhaleLauncher.new.exe`，关掉启动器后：

```powershell
Move-Item .\WhaleLauncher.new.exe .\WhaleLauncher.exe -Force
```

---

## 6. 验证

1. 双击 `WhaleLauncher.exe`，确认窗口打开、版本号正常、页面能切换；
2. 对比文件哈希，确认根目录和发布目录一致：

```powershell
(Get-FileHash .\WhaleLauncher.exe -Algorithm SHA256).Hash
(Get-FileHash .\launcher\publish\WhaleLauncher.exe -Algorithm SHA256).Hash
```

3. 跑仓库检查（提交前必须）：

```powershell
node scripts/check-layers.js
node scripts/release-check.js
node scripts/privacy-scan.js .
```

---

## 7. 常见错误

| 现象 | 原因 / 处理 |
|---|---|
| `No .NET SDKs were found` / `dotnet --version` 报 SDK 未找到 | 只装了 Runtime，没装 SDK；按第 1 节安装，或改用 `%LOCALAPPDATA%\Microsoft\dotnet\dotnet.exe` |
| `NU1900` / `无法加载源 https://api.nuget.org/...` | 网络/代理问题；`NuGet` 还原失败但已缓存时构建仍可能成功。需要联网时设 `$env:HTTPS_PROXY` |
| 复制根 EXE 报「文件正由另一进程使用」 | 启动器在运行；先退出（含托盘），或用 `WhaleLauncher.new.exe` 中转 |
| 发布后只有一个 exe，双击提示缺少 runtime | 框架依赖发布，需要用户安装 .NET 10 Desktop Runtime；要免安装就改 `SelfContained=true`（体积大很多，未在本项目采用） |
| 发布目录里没有 exe / 只有 dll | 命令没带 `-p:PublishSingleFile=true`，用了默认发布 |
| 在 macOS/Linux 上构建失败 | WPF 只能在 Windows 构建 |
| exe 里带本机路径 / 隐私扫描报错 | `csproj` 已有 `DebugType=none`、`DebugSymbols=false`；不要提交 `bin/obj` |
| 改了 XAML 但界面没变 | 只 `build` 没 `publish`，或发布后没覆盖根目录 exe；按第 4、5 节重做 |

---

## 8. 版本号

在 `launcher/WhaleLauncher.csproj`：

```xml
<Version>4.0.8</Version>
<FileVersion>4.0.8.0</FileVersion>
<ProductVersion>$(Version)</ProductVersion>
```

发版时同步改这里（以及根目录 `package.json` 的 `version`，如项目要求）。

---

## 9. 提交约定

- 改了 `launcher/` 源码，**同时提交**：
  - `launcher/` 下的源码；
  - `launcher/publish/WhaleLauncher.exe`；
  - 根目录 `WhaleLauncher.exe`；
- `CHANGELOG.md` 补一段用户可见的变化；
- 不提交 `launcher/bin/`、`launcher/obj/`、`data/`、日志；
- 不直接 push `main`，走分支 + PR。

---

## 10. CI

- `.github/workflows/tests.yml` 会 `dotnet build` 校验启动器能编译；
- `installer.yml` 在 `test/**` 分支构建安装包（不含正式发布）；
- 正式发布 / 签名流程见 `docs/打包与签名.md`、`CONTRIBUTING.md` 第四节。
