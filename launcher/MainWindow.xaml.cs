using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Data;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Runtime.InteropServices;
using System.Windows.Interop;
using System.Windows.Input;
using System.Windows.Threading;
using WhaleLauncher.Views;

namespace WhaleLauncher
{
    public sealed class NavEntry
    {
        public string Key { get; set; }
        public string Label { get; set; }
        /// <summary>左侧导航的分组名（日常 / 连接 / 系统）。分组由 CollectionView 提供，条目本身仍是扁平的。</summary>
        public string Group { get; set; }
        public Geometry Icon { get; set; }
        public override string ToString() => Label ?? Key ?? "";
    }

    public partial class MainWindow : Window
    {
        private readonly RuntimeSupervisor _sup;
        private readonly DispatcherTimer _timer;
        private readonly Dictionary<string, UserControl> _pages = new Dictionary<string, UserControl>();
        private bool _busy;
        private bool _refreshing;
        private bool _memoryNoticeChecked;

        // 彩蛋：连点顶栏标识 5 次说一句台词。只在底栏停 3 秒，不弹窗、不写日志、不进任何统计。
        // 两秒一次的 RefreshAsync 会覆盖 StatusLine，所以用 _easterUntil 抢一下优先级。
        private static readonly string[] BrandLines =
        {
            "……你戳我干嘛",
            "再戳就把你拉黑（骗你的）",
            "水下的信号不太好，等我一下",
            "今天的鱼很好吃",
            "好了好了，我在呢",
        };
        private int _brandClicks;
        private int _brandLineIndex;
        private DateTime _brandFirstClick = DateTime.MinValue;
        private string _easterLine = "";
        private DateTime _easterUntil = DateTime.MinValue;

        // 11 项平铺时找东西只能靠记忆，所以按「日常 / 连接 / 系统」分组。
        // 顺序即显示顺序；分组只影响呈现，Key 仍是页面工厂的唯一标识。
        // 图标：24 网格 / 1.6 描边 / 圆头。只重画语义最弱的三枚（状态、表情包、语音），
        // 齿轮、铃铛、折线这类语义已经很强的保持原样——全换会让人短期找不到入口。
        private static readonly NavEntry[] NavKeys =
        {
            // 日常
            new NavEntry { Key = "状态", Label = "状态", Group = "日常", Icon = Geometry.Parse("M3 8c2.6-2.2 5.4-2.2 8 0s5.4 2.2 8 0 M3 14c2.6-2.2 5.4-2.2 8 0s5.4 2.2 8 0 M3 20c2.6-2.2 5.4-2.2 8 0s5.4 2.2 8 0") },
            new NavEntry { Key = "人设", Label = "人设", Group = "日常", Icon = Geometry.Parse("M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7") },
            new NavEntry { Key = "表情包", Label = "表情包", Group = "日常", Icon = Geometry.Parse("M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M8.5 10h.01 M15.5 10h.01 M8.5 14c1 1.6 2.2 2.4 3.5 2.4s2.5-.8 3.5-2.4") },
            // 连接
            new NavEntry { Key = "微信桥接", Label = "微信桥接", Group = "连接", Icon = Geometry.Parse("M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-4-.9L3 21l1.9-3.5a8.4 8.4 0 1 1 16.1-6Z M8 10h8 M8 13h5") },
            new NavEntry { Key = "语音发送", Label = "语音发送", Group = "连接", Icon = Geometry.Parse("M8 9v6 M12 6v12 M16 9v6") },
            new NavEntry { Key = "B 站", Label = "B 站", Group = "连接", Icon = Geometry.Parse("M3 7h18v12H3z M8 7l-2-3 M16 7l2-3 M10 11l5 2.5-5 2.5z") },
            // 系统
            new NavEntry { Key = "能力", Label = "能力", Group = "系统", Icon = Geometry.Parse("M13 2 4 14h6l-1 8 9-12h-6z") },
            new NavEntry { Key = "主动与提醒", Label = "主动与提醒", Group = "系统", Icon = Geometry.Parse("M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8 M10.5 20a2 2 0 0 0 3 0") },
            new NavEntry { Key = "诊断", Label = "诊断", Group = "系统", Icon = Geometry.Parse("M3 12h4l2-5 4 10 2-5h6") },
            new NavEntry { Key = "设置", Label = "设置", Group = "系统", Icon = Geometry.Parse("M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.4.5.86 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z") },
        };

        public MainWindow()
        {
            InitializeComponent();

            var dir = AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
            _sup = new RuntimeSupervisor(dir);

            // 分组视图：ListBox 仍是单级选择，组头只做归类，不参与命中与选中，
            // 键盘上下键只会落在真实条目上（所以 GoTo / SelectedIndex 的逻辑不用改）。
            var navView = new ListCollectionView(NavKeys);
            navView.GroupDescriptions.Add(new PropertyGroupDescription("Group"));
            Nav.ItemsSource = navView;
            Nav.SelectedIndex = 0;

            _sup.Say("启动器就绪 · " + dir);

            Appearance.Changed += OnAppearanceChanged;
            ApplyAppearance();

            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
            _timer.Tick += async (_, __) =>
            {
                await RefreshAsync();
            };
            _timer.Start();

            Loaded += async (_, __) =>
            {
                Nav.SelectedIndex = 0;
                await RefreshAsync();
            };
            Closed += (_, __) =>
            {
                Appearance.Changed -= OnAppearanceChanged;
                _timer.Stop();
                _sup.Dispose();
            };
        }

        /// <summary>
        /// 内核启动时如果自动迁移了 3.x 旧记忆，弹一次「已导入并转换格式」。
        /// 服务端在 data\memory\import-report.json 记报告，这里看完就 ack，之后重启不再弹。
        /// </summary>
        private async Task CheckMemoryImportNoticeAsync()
        {
            try
            {
                var res = await Api.Get(_sup.Url, "/api/memory/import/notice");
                if (!res.Ok) return;
                var notice = res.Prop("notice");
                if (notice.ValueKind != JsonValueKind.Object) return;

                var imported = NestedLong(notice, "imported");
                var merged = NestedLong(notice, "merged");
                var messages = NestedLong(notice, "messages");
                var notes = NestedLong(notice, "notes");
                var skipped = NestedLong(notice, "skipped");

                var text = "检测到旧版本（3.x）记忆，已自动导入并转换格式：\n\n";
                if (imported > 0) text += "· 新增 " + imported + " 个聊天\n";
                if (merged > 0) text += "· 合并 " + merged + " 个已有聊天\n";
                text += "· 补进 " + messages + " 条消息 / " + notes + " 条偏好\n";
                if (skipped > 0) text += "· " + skipped + " 个聊天转换失败，详见 data\\whale.log\n";
                text += "\n原文件保留在 data\\memory\\legacy\\，不会删除。\n"
                      + "以后可以在「设置 → 高级 → 旧版记忆」里手动再识别。";

                MessageBox.Show(this, text, "记忆已导入", MessageBoxButton.OK, MessageBoxImage.Information);
                await Api.Post(_sup.Url, "/api/memory/import/ack", "{}");
            }
            catch
            {
                // 提示失败不影响启动，下次启动会再试
            }
        }

        private static long NestedLong(JsonElement el, string name)
        {
            if (el.ValueKind == JsonValueKind.Object && el.TryGetProperty(name, out var v)
                && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n)) return n;
            return 0;
        }

        // ── 彩蛋 ────────────────────────────────────────────────
        private void OnBrandClick(object sender, MouseButtonEventArgs e)
        {
            var now = DateTime.Now;
            // 3 秒内没连上就重新数，避免一天里零散点五下也算
            if ((now - _brandFirstClick).TotalSeconds > 3)
            {
                _brandClicks = 0;
                _brandFirstClick = now;
            }
            if (++_brandClicks < 5) return;

            _brandClicks = 0;
            _easterLine = BrandLines[_brandLineIndex++ % BrandLines.Length];
            _easterUntil = now.AddSeconds(3);
            StatusLine.Text = _easterLine;
        }

        // ── 外观：主题 / 背景图 / 标题栏 ────────────────────────
        private void ApplyAppearance()
        {
            var dark = Appearance.IsDark;
            if (IconMoon != null)
            {
                IconMoon.Visibility = dark ? Visibility.Visible : Visibility.Collapsed;
                IconSun.Visibility = dark ? Visibility.Collapsed : Visibility.Visible;
            }

            var bmp = Appearance.LoadBackdrop();
            if (BackdropImage != null)
            {
                BackdropImage.Source = bmp;
                BackdropLayer.Visibility = bmp == null ? Visibility.Collapsed : Visibility.Visible;
            }

            ApplyTitleBar();
        }

        private void OnAppearanceChanged() => ApplyAppearance();

        private void OnToggleTheme(object sender, RoutedEventArgs e)
        {
            Appearance.SetTheme(Appearance.IsDark ? "light" : "dark");
        }

        private void ApplyTitleBar()
        {
            var hwnd = new WindowInteropHelper(this).Handle;
            if (hwnd == IntPtr.Zero) return;
            int dark = Appearance.IsDark ? 1 : 0;
            // 20 = DWMWA_USE_IMMERSIVE_DARK_MODE（Win10 2004+），老系统用 19
            if (DwmSetWindowAttribute(hwnd, 20, ref dark, sizeof(int)) != 0)
                DwmSetWindowAttribute(hwnd, 19, ref dark, sizeof(int));

            // Win11：把系统标题栏也染成主题色，避免深色界面顶着一根白条
            var bg = Appearance.IsDark ? Color.FromRgb(0x0C, 0x12, 0x1A) : Color.FromRgb(0xF4, 0xF6, 0xF9);
            var fg = Appearance.IsDark ? Color.FromRgb(0xF4, 0xF7, 0xFA) : Color.FromRgb(0x12, 0x17, 0x22);
            var line = Appearance.IsDark ? Color.FromRgb(0x24, 0x31, 0x40) : Color.FromRgb(0xE5, 0xE9, 0xF0);
            int caption = ToColorRef(bg), text = ToColorRef(fg), border = ToColorRef(line);
            DwmSetWindowAttribute(hwnd, 35, ref caption, sizeof(int)); // DWMWA_CAPTION_COLOR
            DwmSetWindowAttribute(hwnd, 36, ref text, sizeof(int));    // DWMWA_TEXT_COLOR
            DwmSetWindowAttribute(hwnd, 34, ref border, sizeof(int));  // DWMWA_BORDER_COLOR
        }

        private static int ToColorRef(Color c) => c.R | (c.G << 8) | (c.B << 16);

        protected override void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);
            var hwnd = new WindowInteropHelper(this).Handle;

            // 常态提权后，非管理员资源管理器的拖拽会被 UIPI 拦掉；放行这三条消息即可
            const uint MSGFLT_ALLOW = 1;
            ChangeWindowMessageFilterEx(hwnd, 0x0233 /* WM_DROPFILES */, MSGFLT_ALLOW, IntPtr.Zero);
            ChangeWindowMessageFilterEx(hwnd, 0x0049 /* WM_COPYGLOBALDATA */, MSGFLT_ALLOW, IntPtr.Zero);
            ChangeWindowMessageFilterEx(hwnd, 0x004A /* WM_COPYDATA */, MSGFLT_ALLOW, IntPtr.Zero);

            ApplyTitleBar();
        }

        [DllImport("dwmapi.dll", PreserveSig = true)]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool ChangeWindowMessageFilterEx(IntPtr hwnd, uint msg, uint action, IntPtr changeInfo);

        // ── 导航 ────────────────────────────────────────────────
        private void OnNavChanged(object sender, SelectionChangedEventArgs e)
        {
            var key = (Nav.SelectedItem as NavEntry)?.Key;
            if (string.IsNullOrEmpty(key)) return;

            if (!_pages.TryGetValue(key, out var page))
            {
                try
                {
                    page = CreatePage(key);
                }
                catch (Exception ex)
                {
                    _sup.SayError("页面创建失败（" + key + "）：" + ex.Message);
                    page = new PlaceholderPage(key, "这一页创建失败了：" + ex.Message);
                }
                _pages[key] = page;
            }
            Host.Content = page;
            if (page is IRefreshable r) _ = r.RefreshAsync();
        }

        private UserControl CreatePage(string key)
        {
            switch (key)
            {
                case "状态": return new StatusPage(_sup);
                case "人设": return new PersonaPage(_sup);
                case "表情包": return new StickerPage(_sup);
                case "语音发送": return new VoiceSendPage(_sup);
                case "B 站": return new BiliPage(_sup);
                case "能力": return new CapabilitiesPage(_sup);
                case "主动与提醒": return new ReminderPage(_sup);
                case "微信桥接": return new BridgePage(_sup);
                case "诊断": return new DiagPage(_sup);
                case "设置": return new SettingsPage(_sup);
                default:
                    return new PlaceholderPage(key, "这一页还没做。");
            }
        }

        private void GoTo(string key)
        {
            var item = Nav.Items.OfType<NavEntry>().FirstOrDefault(x => x.Key == key);
            if (item == null) return;
            Nav.SelectedItem = item;
            Nav.ScrollIntoView(item);
        }

        /// <summary>给页面用的跳转入口（状态页的「进入诊断」）：GoTo 是私有的，页面拿不到。</summary>
        public void NavigateTo(string key) => GoTo(key);

        private void OnSettings(object sender, RoutedEventArgs e) => GoTo("设置");

        // ── 顶栏动作 ────────────────────────────────────────────
        private bool AnythingRunning => _sup.NodeRunning || _sup.BridgeRunning;

        private async void OnToggle(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            _busy = true;
            try
            {
                if (AnythingRunning)
                {
                    BtnToggle.IsEnabled = false;
                    _sup.Say("— 停止中 —");
                    await Task.Run(() => _sup.StopAll());
                    await Task.Delay(200);
                }
                else
                {
                    BtnToggle.IsEnabled = false;
                    _sup.Say("— 启动中 —");
                    await _sup.StartAllAsync(clearRestartHistory: false);
                }
            }
            finally
            {
                BtnToggle.IsEnabled = true;
                _busy = false;
                await RefreshAsync();
            }
        }

        private async void OnRestart(object sender, RoutedEventArgs e)
        {
            if (_busy) return;
            _busy = true;
            try
            {
                BtnRestart.IsEnabled = false;
                _sup.Say("— 重启中 —");
                await Task.Run(() => _sup.StopAll());
                await Task.Delay(600);
                await _sup.StartAllAsync(clearRestartHistory: false);
            }
            finally
            {
                BtnRestart.IsEnabled = true;
                _busy = false;
                await RefreshAsync();
            }
        }

        public void OpenDataDir()
        {
            try
            {
                Directory.CreateDirectory(_sup.DataDir);
                Process.Start(new ProcessStartInfo(_sup.DataDir) { UseShellExecute = true });
            }
            catch (Exception ex)
            {
                _sup.SayWarn("打开数据目录失败：" + ex.Message);
            }
        }

        // ── 刷新 ────────────────────────────────────────────────
        private async Task RefreshAsync()
        {
            if (_refreshing) return;
            _refreshing = true;
            try
            {
                var s = await _sup.ProbeAsync();

                // 内核每次就绪后查一次：启动时自动迁移了旧记忆就弹一次提示（ack 后不再弹）
                if (!s.NodeReady) _memoryNoticeChecked = false;
                else if (!_memoryNoticeChecked)
                {
                    _memoryNoticeChecked = true;
                    _ = CheckMemoryImportNoticeAsync();
                }

                DotNode.Fill = s.NodeReady ? (Brush)FindResource("Ok") : (Brush)FindResource(s.NodeUp ? "Warn" : "Idle");
                DotBridge.Fill = s.BrOnline ? (Brush)FindResource("Ok")
                    : (s.NodeUp ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));
                DotWechat.Fill = s.BrOnline && s.BrAccountOk ? (Brush)FindResource("Ok")
                    : (s.BrOnline ? (Brush)FindResource("Warn") : (Brush)FindResource("Idle"));

                var who = string.IsNullOrEmpty(s.BrAccountNick) ? s.BrAccount : s.BrAccountNick;
                var nodeText = s.NodeUp ? "端口 " + s.Port : "未启动";
                var bridgeText = s.BrOnline ? "在线" : (s.NodeUp ? "连接中" : "未启动");
                var wechatText = s.BrAccountOk ? "已登录" : (s.BrOnline ? "待确认" : "未登录");

                // 顶栏只说结论：用户真正想知道的是「她现在能不能回消息」。
                // 三个字段的明细放进 ToolTip，不再并排占掉三个胶囊的宽度。
                StateSummary.Text = !s.NodeUp ? "她睡着了"
                    : (!s.BrOnline ? "正在醒"
                    : (s.BrAccountOk ? "在想事情" : "还没连上微信"));
                var detail = "内核：" + nodeText + "\n桥接：" + bridgeText + "\n微信：" + wechatText
                             + (string.IsNullOrEmpty(who) ? "" : "（" + who + "）");
                StatusStrip.ToolTip = detail;
                StateSummary.ToolTip = detail;
                BtnToggleText.Text = AnythingRunning ? "停止" : "启动";

                // 底栏右：本次运行的收发量（/api/status 的 status 段，进程重启即归零，不是「今日」）
                FootStats.Text = s.StReceived > 0 || s.StReplied > 0
                    ? "本次 收到 " + s.StReceived + " · 回复 " + s.StReplied
                    : "";

                // 内核与端口已经并进顶栏的内核胶囊；这里只说桥接和需要处理的状态
                var parts = new List<string>();
                if (s.NodeUp)
                {
                    if (s.BrOnline) parts.Add(s.BrLastSeenSec >= 0 ? $"桥接 {s.BrLastSeenSec} 秒前心跳" : "桥接在线");
                    else parts.Add("桥接离线");
                }
                if (s.NodeUp && s.NeedsKey && !s.HasKey) parts.Add("还没填 Key");
                if (s.StFailed > 0) parts.Add($"发送失败 {s.StFailed}");

                // 彩蛋：深夜（23:00–05:00）且夜航主题时，状态条后面多一枚小月亮
                var hour = DateTime.Now.Hour;
                IconNight.Visibility = Appearance.IsDark && (hour >= 23 || hour < 5)
                    ? Visibility.Visible : Visibility.Collapsed;

                // 彩蛋台词优先 3 秒，其余时候显示「她在不在」这句结论
                if (_easterUntil > DateTime.Now)
                {
                    StatusLine.Text = _easterLine;
                }
                else
                {
                    // 都正常的时候别只写「就绪」：她到底在不在，是这行唯一有用的信息
                    var idle = AnythingRunning ? "她在后台陪着" : "她在等你按启动";
                    StatusLine.Text = parts.Count > 0 ? string.Join(" · ", parts) : idle;
                }

                if (Host.Content is IRefreshable r) await r.RefreshAsync();
            }
            catch (Exception ex)
            {
                StatusLine.Text = "刷新状态出错：" + ex.Message;
            }
            finally { _refreshing = false; }
        }

    }
}
