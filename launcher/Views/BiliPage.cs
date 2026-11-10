using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace WhaleLauncher.Views;

/// <summary>
/// B 站（只读）：开关 + 扫码登录 + 登录状态。
///
/// 扫码登录完全走内核 HTTP（/api/bili/login/*）：二维码由内核生成并返回 base64 PNG，
/// 这里只负责显示和每 2 秒轮询一次。cookie 不出内核，界面也看不到。
/// 关掉开关 = 不读视频链接、不登录、不写日记（后续 P1 的作息也跟这个开关）。
/// </summary>
public sealed class BiliPage : UserControl, IRefreshable
{
    readonly RuntimeSupervisor _sup;
    readonly CheckBox enabled = new() { Content = "启用 B 站（只读）" };
    readonly StackPanel panel = new();
    readonly TextBlock loginState = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBlock detail = new() { TextWrapping = TextWrapping.Wrap };
    readonly Image qrImage = new() { Width = 240, Height = 240, Stretch = Stretch.Uniform, Visibility = Visibility.Collapsed };
    readonly Border qrBox = new() { Visibility = Visibility.Collapsed, HorizontalAlignment = HorizontalAlignment.Left, Padding = new Thickness(8) };
    readonly TextBlock qrHint = new() { TextWrapping = TextWrapping.Wrap, Visibility = Visibility.Collapsed };
    readonly DispatcherTimer timer = new() { Interval = TimeSpan.FromSeconds(2) };
    readonly Button qrButton;
    readonly TextBlock statusText = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBlock runResult = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBlock styleText = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBox windowsBox = new() { Text = "20:00-24:00", Width = 260 };
    readonly TextBox skipBox = new() { Text = "0.3", Width = 70 };
    readonly TextBox wakesBox = new() { Text = "1", Width = 70 };
    readonly TextBox jitterBox = new() { Text = "20", Width = 70 };
    readonly TextBox readHourBox = new() { Text = "120", Width = 70 };
    readonly TextBox readDayBox = new() { Text = "400", Width = 70 };
    readonly TextBox shareDailyBox = new() { Text = "3", Width = 70 };
    readonly TextBox gapBox = new() { Text = "120", Width = 70 };
    readonly TextBox chatsBox = new() { Height = 64, AcceptsReturn = true, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Width = 420 };
    readonly CheckBox shareOn = new() { Content = "主动分享到微信" };
    readonly ComboBox dayBox = new() { Width = 360, HorizontalAlignment = HorizontalAlignment.Left };
    readonly TextBlock diaryText = new() { TextWrapping = TextWrapping.Wrap, LineHeight = 20 };
    readonly List<JsonElement> diaryDays = new();
    // 页面每 2 秒被刷新一次：日记列表只在内容变化时重建，并记住用户选的是哪一天，
    // 否则「切到 11.08 马上被拉回 11.09」。
    string diarySignature = "";
    string selectedDiaryDate = "";
    bool rebuildingDiary;
    DateTime nextDiaryFetch = DateTime.MinValue;
    bool editorsLoaded;
    string pendingSince = "";

    public BiliPage(RuntimeSupervisor sup)
    {
        _sup = sup;
        SetResourceReference(ForegroundProperty, "Text");
        UseLayoutRounding = true;

        // 和其它页同一套骨架：固定页头 + 整页一个滚动条
        var page = new Grid { Margin = new Thickness(28, 24, 32, 20) };
        page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        page.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var header = new DockPanel { LastChildFill = false, Margin = new Thickness(0, 0, 0, 10) };
        var title = new TextBlock { Text = "B 站", VerticalAlignment = VerticalAlignment.Center };
        title.SetResourceReference(StyleProperty, "H1");
        DockPanel.SetDock(title, Dock.Left);
        header.Children.Add(title);
        var actions = new StackPanel { Orientation = Orientation.Horizontal };
        DockPanel.SetDock(actions, Dock.Right);
        header.Children.Add(actions);
        var reload = new Button { Content = "⟳ 刷新" };
        reload.SetResourceReference(StyleProperty, "Ghost");
        reload.Click += (_, _) => _ = RefreshAsync();
        actions.Children.Add(reload);
        Grid.SetRow(header, 0);
        page.Children.Add(header);

        var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled, FocusVisualStyle = null };
        Grid.SetRow(scroll, 1);
        page.Children.Add(scroll);
        var body = new StackPanel { Margin = new Thickness(0, 0, 8, 0) };
        scroll.Content = body;
        Content = page;

        // ── 开关 ──
        var gate = Card();
        body.Children.Add(gate);
        enabled.SetResourceReference(StyleProperty, "DarkCheck");
        enabled.Margin = new Thickness(0, 0, 0, 2);
        ((StackPanel)gate.Child).Children.Add(enabled);
        ((StackPanel)gate.Child).Children.Add(Note("关掉后：主人发 B 站链接只按普通链接处理，不会去读视频资料；已登录的 cookie 保留但不使用。"));
        enabled.Click += async (_, _) => await ToggleFeatureAsync();

        // ── 登录 ──
        panel.Children.Add(Note("鲸鲸只做只读：看视频页信息、字幕、热评；不会点赞、评论、私信。扫码只用 B 站官方登录接口，cookie 只保存在本机 data/bili/。"));
        var loginCard = Card("B 站登录");
        panel.Children.Add(loginCard);
        var loginInner = (StackPanel)loginCard.Child;
        loginState.Margin = new Thickness(0, 2, 0, 0);
        loginState.SetResourceReference(StyleProperty, "Small");
        loginInner.Children.Add(loginState);
        detail.SetResourceReference(StyleProperty, "Small");
        detail.Margin = new Thickness(0, 4, 0, 0);
        loginInner.Children.Add(detail);

        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        qrButton = new Button { Content = "扫码登录", MinHeight = 34 };
        qrButton.SetResourceReference(StyleProperty, "Primary");
        qrButton.Click += async (_, _) => await StartQrAsync();
        row.Children.Add(qrButton);
        var logout = new Button { Content = "退出登录", MinHeight = 34, Margin = new Thickness(8, 0, 0, 0) };
        logout.SetResourceReference(StyleProperty, "Ghost");
        logout.Click += async (_, _) => await LogoutAsync();
        row.Children.Add(logout);
        loginInner.Children.Add(row);

        qrBox.SetResourceReference(StyleProperty, "Card");
        qrBox.Child = qrImage;
        loginInner.Children.Add(qrBox);
        qrHint.Margin = new Thickness(0, 8, 0, 0);
        qrHint.SetResourceReference(StyleProperty, "Small");
        loginInner.Children.Add(qrHint);

        body.Children.Add(panel);

        // ── 运行状态 ──
        var statusCard = Card("运行状态");
        panel.Children.Add(statusCard);
        statusText.SetResourceReference(StyleProperty, "Small");
        ((StackPanel)statusCard.Child).Children.Add(statusText);

        // ── 日记与看过的视频 ──
        var diaryCard = Card("日记与看过的视频", "按天回看：她看了什么、两本日记写了什么。点下拉框切日期。");
        panel.Children.Add(diaryCard);
        var diaryInner = (StackPanel)diaryCard.Child;
        dayBox.Margin = new Thickness(0, 6, 0, 0);
        dayBox.SelectionChanged += (_, _) => OnDiaryDaySelected();
        diaryInner.Children.Add(dayBox);
        var diaryRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        var diaryReload = new Button { Content = "刷新", MinHeight = 30 };
        diaryReload.SetResourceReference(StyleProperty, "Ghost");
        diaryReload.Click += async (_, _) => await LoadDiaryAsync(true);
        diaryRow.Children.Add(diaryReload);
        diaryInner.Children.Add(diaryRow);
        diaryText.SetResourceReference(StyleProperty, "Small");
        diaryText.Margin = new Thickness(0, 8, 0, 0);
        diaryInner.Children.Add(diaryText);

        // ── 手动跑一轮 ──
        var runCard = Card("手动跑一轮", "「只看会选什么」不联网读视频、不写日记、不记账；「现在跑一轮」就是它自己醒一次会做的事。");
        panel.Children.Add(runCard);
        var runInner = (StackPanel)runCard.Child;
        var runRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        var dryBtn = new Button { Content = "只看会选什么", MinHeight = 32 };
        dryBtn.SetResourceReference(StyleProperty, "Ghost");
        dryBtn.Click += async (_, _) => await RunAsync(true);
        runRow.Children.Add(dryBtn);
        var runBtn = new Button { Content = "现在跑一轮", MinHeight = 32, Margin = new Thickness(8, 0, 0, 0) };
        runBtn.SetResourceReference(StyleProperty, "Primary");
        runBtn.Click += async (_, _) => await RunAsync(false);
        runRow.Children.Add(runBtn);
        runInner.Children.Add(runRow);
        runResult.SetResourceReference(StyleProperty, "Small");
        runResult.Margin = new Thickness(0, 8, 0, 0);
        runInner.Children.Add(runResult);

        // ── 作息与预算 ──
        var cfgCard = Card("作息与预算", "改完点保存立刻生效（内核热加载 config.json），不用重启。窗口写法：20:00-24:00，多个用逗号隔开。");
        panel.Children.Add(cfgCard);
        var cfgInner = (StackPanel)cfgCard.Child;
        AddRow(cfgInner, "作息窗口", windowsBox);

        // 24 小时作息条：窗口是纯文本写法，光看字符串判断不了「现在到底在不在窗口里」。
        // 每分钟重画一次，让「现在几点」那根针不会停在打开页面那一刻。
        var clock = BuildClockBar();
        cfgInner.Children.Add(clock);
        var clockTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
        clockTimer.Tick += (_, _) => PaintClock(clock);
        clockTimer.Start();
        Unloaded += (_, _) => clockTimer.Stop();
        windowsBox.TextChanged += (_, _) => PaintClock(clock);
        PaintClock(clock);
        var numRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        numRow.Children.Add(Note("开摆概率"));
        numRow.Children.Add(skipBox);
        numRow.Children.Add(Note("每天最多醒"));
        numRow.Children.Add(wakesBox);
        numRow.Children.Add(Note("进窗口后抖动(分)"));
        numRow.Children.Add(jitterBox);
        cfgInner.Children.Add(numRow);
        var quotaRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        quotaRow.Children.Add(Note("读/小时"));
        quotaRow.Children.Add(readHourBox);
        quotaRow.Children.Add(Note("读/天"));
        quotaRow.Children.Add(readDayBox);
        cfgInner.Children.Add(quotaRow);
        shareOn.SetResourceReference(StyleProperty, "DarkCheck");
        shareOn.Margin = new Thickness(0, 10, 0, 0);
        cfgInner.Children.Add(shareOn);
        var shareRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        shareRow.Children.Add(Note("每天最多分享"));
        shareRow.Children.Add(shareDailyBox);
        shareRow.Children.Add(Note("两条间隔(分)"));
        shareRow.Children.Add(gapBox);
        cfgInner.Children.Add(shareRow);
        AddRow(cfgInner, "白名单群", chatsBox);
        cfgInner.Children.Add(Note("白名单群每行一个：群ID,名字,每日上限（例如 123@chatroom,某个群,1）。群 ID 不能乱填，填错只会发不出去。"));
        var saveRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        var save = new Button { Content = "保存", MinHeight = 32 };
        save.SetResourceReference(StyleProperty, "Primary");
        save.Click += async (_, _) => await SaveConfigAsync();
        saveRow.Children.Add(save);
        cfgInner.Children.Add(saveRow);

        // ── 说话习惯 ──
        var styleCard = Card("评论区说话习惯", "只学「气口」短句（≤20 字），最多 20 条、30 天不用会衰减；聊天里最多注入 3 条。");
        panel.Children.Add(styleCard);
        var styleInner = (StackPanel)styleCard.Child;
        styleText.SetResourceReference(StyleProperty, "Small");
        styleText.Margin = new Thickness(0, 6, 0, 0);
        styleInner.Children.Add(styleText);
        var styleRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        var styleReload = new Button { Content = "刷新", MinHeight = 30 };
        styleReload.SetResourceReference(StyleProperty, "Ghost");
        styleReload.Click += async (_, _) => await LoadStyleAsync();
        styleRow.Children.Add(styleReload);
        var styleClear = new Button { Content = "清空", MinHeight = 30, Margin = new Thickness(8, 0, 0, 0) };
        styleClear.SetResourceReference(StyleProperty, "Ghost");
        styleClear.Click += async (_, _) => await ClearStyleAsync();
        styleRow.Children.Add(styleClear);
        styleInner.Children.Add(styleRow);

        var about = Card("说明");
        body.Children.Add(about);
        ((StackPanel)about.Child).Children.Add(Note("登录后可读公开视频的字幕与热评（没有字幕的视频会明确标注「没看到画面」）。第一版没有点赞/评论/私信，后续阶段见 docs/B站养鱼计划.md。"));

        timer.Tick += async (_, _) => await PollAsync();
        Unloaded += (_, _) => timer.Stop();
        Loaded += async (_, _) => await RefreshAsync();
    }

    Border Card(string heading = null, string hint = null)
    {
        var card = new Border { Padding = new Thickness(16, 12, 16, 12), Margin = new Thickness(0, 0, 0, 12) };
        card.SetResourceReference(StyleProperty, "Card");
        var inner = new StackPanel();
        card.Child = inner;
        if (heading != null)
        {
            var title = new TextBlock { Text = heading, Margin = new Thickness(0, 0, 0, 2) };
            title.SetResourceReference(StyleProperty, "H2");
            inner.Children.Add(title);
        }
        if (hint != null) inner.Children.Add(Note(hint));
        return card;
    }

    static TextBlock Note(string text)
    {
        var note = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, LineHeight = 19, Margin = new Thickness(0, 6, 0, 2) };
        note.SetResourceReference(StyleProperty, "Small");
        return note;
    }

    static void AddRow(Panel target, string label, Control control)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        var caption = new TextBlock { Text = label, Width = 96, VerticalAlignment = VerticalAlignment.Center };
        caption.SetResourceReference(StyleProperty, "Small");
        row.Children.Add(caption);
        control.SetResourceReference(StyleProperty, control.GetType());
        row.Children.Add(control);
        target.Children.Add(row);
    }

    static long Num(JsonElement root, string name, string prop)
    {
        var obj = root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var v) ? v : default;
        if (obj.ValueKind != JsonValueKind.Object || !obj.TryGetProperty(prop, out var p)) return 0;
        return p.ValueKind == JsonValueKind.Number && p.TryGetInt64(out var n) ? n : 0;
    }

    async Task RunAsync(bool dry)
    {
        if (!_sup.NodeRunning) { runResult.Text = "内核没在运行。"; return; }
        runResult.Text = dry ? "正在看会选什么…" : "正在跑一轮（要读视频，约 10~30 秒）…";
        var res = await Api.Post(_sup.Url, "/api/bili/run", dry ? "{\"dry\":true}" : "{}");
        if (!res.Ok)
        {
            runResult.Text = "失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        if (dry)
        {
            var lines = new List<string>();
            var picked = res.Prop("picked");
            if (picked.ValueKind == JsonValueKind.Array)
            {
                var i = 0;
                foreach (var row in picked.EnumerateArray())
                {
                    i++;
                    var title = row.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : "";
                    var score = row.TryGetProperty("score", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt64() : 0;
                    lines.Add(i + ". [" + score + "分] " + title);
                    if (i >= 5) break;
                }
            }
            runResult.Text = lines.Count > 0 ? ("会选：\n" + string.Join("\n", lines)) : "没有可选的候选（可能是推荐流为空或被去重了）。";
            return;
        }
        var watched = res.Prop("watched");
        var count = watched.ValueKind == JsonValueKind.Array ? watched.GetArrayLength() : 0;
        var ownerChars = Num(res.Root, "diary", "ownerChars");
        var selfChars = Num(res.Root, "diary", "selfChars");
        var shareCount = res.Prop("share");
        var shares = shareCount.ValueKind == JsonValueKind.Array ? shareCount.GetArrayLength() : 0;
        runResult.Text = "跑完了：读了 " + count + " 条，日记 " + ownerChars + "/" + selfChars + " 字，分享入队 " + shares + " 条。";
        await LoadDiaryAsync(true);
        await LoadStyleAsync();
        await RefreshAsync();
    }

    async Task SaveConfigAsync()
    {
        double skip = 0.3; double.TryParse(skipBox.Text.Trim(), out skip);
        var patch = new Dictionary<string, object>
        {
            ["bili"] = new Dictionary<string, object>
            {
                ["night"] = new Dictionary<string, object>
                {
                    ["windows"] = ParseWindows(windowsBox.Text),
                    ["skipChance"] = skip,
                    ["maxWakesPerDay"] = ParseInt(wakesBox.Text, 1),
                    ["jitterMinutes"] = ParseInt(jitterBox.Text, 20),
                },
                ["risk"] = new Dictionary<string, object>
                {
                    ["readHourly"] = ParseInt(readHourBox.Text, 120),
                    ["readDaily"] = ParseInt(readDayBox.Text, 400),
                },
                ["share"] = new Dictionary<string, object>
                {
                    ["enabled"] = shareOn.IsChecked == true,
                    ["daily"] = ParseInt(shareDailyBox.Text, 3),
                    ["minGapMinutes"] = ParseInt(gapBox.Text, 120),
                    ["chats"] = ParseChats(chatsBox.Text),
                },
            },
        };
        var body = "{\"patch\":" + JsonSerializer.Serialize(patch) + "}";
        var res = await Api.Post(_sup.Url, "/api/config", body);
        if (!res.Ok)
        {
            runResult.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        editorsLoaded = false;
        await RefreshAsync();
        runResult.Text = "已保存（内核已热加载）。";
    }

    static int ParseInt(string text, int fallback)
        => int.TryParse((text ?? "").Trim(), out var n) ? n : fallback;

    /// <summary>24 小时条：96 格（每格 15 分钟），作息窗口按时间填色，最后一根针是「现在」。</summary>
    Grid BuildClockBar()
    {
        var wrap = new Grid { Margin = new Thickness(0, 8, 0, 0) };
        wrap.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        wrap.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });

        var bar = new Grid { Height = 12 };
        for (var i = 0; i < 96; i++)
            bar.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        wrap.Tag = bar;
        wrap.Children.Add(bar);

        var labels = new Grid { Margin = new Thickness(0, 3, 0, 0) };
        labels.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        labels.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        labels.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        labels.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        labels.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        AddClockLabel(labels, "00:00", 0, HorizontalAlignment.Left);
        AddClockLabel(labels, "12:00", 2, HorizontalAlignment.Center);
        AddClockLabel(labels, "24:00", 4, HorizontalAlignment.Right);
        Grid.SetRow(labels, 1);
        wrap.Children.Add(labels);
        return wrap;
    }

    static void AddClockLabel(Grid host, string text, int column, HorizontalAlignment align)
    {
        var t = new TextBlock { Text = text, HorizontalAlignment = align };
        t.SetResourceReference(StyleProperty, "Small");
        Grid.SetColumn(t, column);
        host.Children.Add(t);
    }

    void PaintClock(Grid wrap)
    {
        if (wrap.Tag is not Grid bar) return;
        bar.Children.Clear();

        var track = new Border { CornerRadius = new CornerRadius(6) };
        track.SetResourceReference(Border.BackgroundProperty, "LineSoft");
        Grid.SetColumnSpan(track, 96);
        bar.Children.Add(track);

        foreach (var w in ParseWindows(windowsBox.Text))
        {
            var s = ClockMinutes(w["start"] as string);
            var e = ClockMinutes(w["end"] as string);
            if (s < 0 || e < 0 || e <= s) continue;
            var from = Math.Clamp(s / 15, 0, 95);
            var to = Math.Clamp((e + 14) / 15, from + 1, 96);
            var seg = new Border { CornerRadius = new CornerRadius(6) };
            seg.SetResourceReference(Border.BackgroundProperty, "Accent");
            Grid.SetColumn(seg, from);
            Grid.SetColumnSpan(seg, to - from);
            bar.Children.Add(seg);
        }

        var now = DateTime.Now;
        var mark = new Border { Width = 2, CornerRadius = new CornerRadius(1), HorizontalAlignment = HorizontalAlignment.Center };
        mark.SetResourceReference(Border.BackgroundProperty, "Text");
        Grid.SetColumn(mark, Math.Clamp((now.Hour * 60 + now.Minute) / 15, 0, 95));
        bar.Children.Add(mark);

        bar.ToolTip = DescribeWindows();
    }

    /// <summary>画不出合法窗口时要说清楚「她不会自己醒」，别让人以为条子空着是加载中。</summary>
    string DescribeWindows()
    {
        var parts = new List<string>();
        foreach (var w in ParseWindows(windowsBox.Text))
        {
            var s = ClockMinutes(w["start"] as string);
            var e = ClockMinutes(w["end"] as string);
            if (s < 0 || e < 0 || e <= s) continue;
            parts.Add(ClockText(s) + "-" + ClockText(e));
        }
        return parts.Count == 0 ? "没有有效作息窗口：她不会自己醒" : "作息：" + string.Join("，", parts);
    }

    static string ClockText(int minutes) => (minutes / 60).ToString("00") + ":" + (minutes % 60).ToString("00");

    static int ClockMinutes(string raw)
    {
        var bits = (raw ?? "").Trim().Replace('：', ':').Split(':');
        if (bits.Length != 2) return -1;
        if (!int.TryParse(bits[0], out var h) || !int.TryParse(bits[1], out var m)) return -1;
        if (h < 0 || h > 24 || m < 0 || m > 59) return -1;
        return h * 60 + m;
    }

    static List<Dictionary<string, object>> ParseWindows(string text)    {
        var list = new List<Dictionary<string, object>>();
        foreach (var part in (text ?? "").Split(new[] { ',', '，', ';', '；' }, StringSplitOptions.RemoveEmptyEntries))
        {
            var bits = part.Trim().Split(new[] { '-', '—', '~' }, StringSplitOptions.RemoveEmptyEntries);
            if (bits.Length < 2) continue;
            list.Add(new Dictionary<string, object>
            {
                ["start"] = bits[0].Trim(),
                ["end"] = bits[1].Trim(),
                ["wakes"] = bits.Length > 2 && int.TryParse(bits[2].Trim(), out var w) ? w : 1,
            });
        }
        return list;
    }

    static List<Dictionary<string, object>> ParseChats(string text)
    {
        var list = new List<Dictionary<string, object>>();
        foreach (var line in (text ?? "").Split('\n'))
        {
            var parts = line.Trim().Split(',', '，');
            if (parts.Length < 1 || parts[0].Trim().Length == 0) continue;
            list.Add(new Dictionary<string, object>
            {
                ["chatId"] = parts[0].Trim(),
                ["name"] = parts.Length > 1 ? parts[1].Trim() : "",
                ["daily"] = parts.Length > 2 && int.TryParse(parts[2].Trim(), out var d) ? d : 1,
            });
        }
        return list;
    }

    async Task LoadDiaryAsync(bool force = false)
    {
        if (!_sup.NodeRunning) return;
        // 页面每 2 秒刷新：加一个 8 秒的取数节流，避免一直重查
        if (!force && DateTime.UtcNow < nextDiaryFetch) return;
        nextDiaryFetch = DateTime.UtcNow.AddSeconds(8);
        var res = await Api.Get(_sup.Url, "/api/bili/diary?days=60");
        if (!res.Ok)
        {
            diaryText.Text = "读取日记失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        var days = res.Prop("days");
        var signature = DiarySignature(days);
        if (!force && signature == diarySignature) return; // 没变化：保留当前选中项，不重建
        diarySignature = signature;

        var wantDate = selectedDiaryDate;
        rebuildingDiary = true;
        try
        {
            diaryDays.Clear();
            dayBox.Items.Clear();
            if (days.ValueKind == JsonValueKind.Array)
            {
                foreach (var d in days.EnumerateArray())
                {
                    diaryDays.Add(d);
                    var date = Text(d, "date");
                    var watched = d.TryGetProperty("watched", out var w) && w.ValueKind == JsonValueKind.Array ? w.GetArrayLength() : 0;
                    dayBox.Items.Add(date + "（看了 " + watched + " 条）");
                }
            }
            if (diaryDays.Count == 0)
            {
                diaryText.Text = "还没有日记。跑一轮之后这里就会出现「看了哪些视频 + 两本日记」。";
                return;
            }
            // 优先恢复用户之前选的那一天；那天没了才回到最新的
            var index = 0;
            if (wantDate.Length > 0)
            {
                for (var i = 0; i < diaryDays.Count; i += 1)
                {
                    if (Text(diaryDays[i], "date") == wantDate) { index = i; break; }
                }
            }
            dayBox.SelectedIndex = index;
            selectedDiaryDate = Text(diaryDays[index], "date");
            RenderDay(index);
        }
        finally
        {
            rebuildingDiary = false;
        }
    }

    static string DiarySignature(JsonElement days)
    {
        if (days.ValueKind != JsonValueKind.Array) return "none";
        var sb = new System.Text.StringBuilder();
        foreach (var d in days.EnumerateArray())
        {
            var watched = d.TryGetProperty("watched", out var w) && w.ValueKind == JsonValueKind.Array ? w.GetArrayLength() : 0;
            var ownerLen = Text(d, "owner").Length;
            var selfLen = Text(d, "self").Length;
            var shares = d.TryGetProperty("shares", out var sh) && sh.ValueKind == JsonValueKind.Number ? sh.GetInt64() : 0;
            sb.Append(Text(d, "date")).Append('|').Append(watched).Append('|').Append(ownerLen)
              .Append('|').Append(selfLen).Append('|').Append(shares).Append(';');
        }
        return sb.ToString();
    }

    void OnDiaryDaySelected()
    {
        if (rebuildingDiary) return;
        var index = dayBox.SelectedIndex;
        if (index < 0 || index >= diaryDays.Count) return;
        selectedDiaryDate = Text(diaryDays[index], "date");
        RenderDay(index);
    }

    void RenderDay(int index)
    {
        if (index < 0 || index >= diaryDays.Count) return;
        var d = diaryDays[index];
        var date = Text(d, "date");
        var parts = new List<string> { date };
        var watched = d.TryGetProperty("watched", out var w) && w.ValueKind == JsonValueKind.Array ? w : default;
        var shares = d.TryGetProperty("shares", out var sh) && sh.ValueKind == JsonValueKind.Number ? sh.GetInt64() : 0;
        var lines = new List<string>();
        if (watched.ValueKind == JsonValueKind.Array && watched.GetArrayLength() > 0)
        {
            var i = 0;
            foreach (var row in watched.EnumerateArray())
            {
                i++;
                var title = Text(row, "title");
                var bvid = Text(row, "bvid");
                var score = row.TryGetProperty("score", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt64() : 0;
                var head = title.Length > 0 ? "《" + title + "》" : "（标题暂缺）" + bvid;
                lines.Add(i + ". " + head + (score > 0 ? "（评分 " + score + "）" : "") + "\n   https://www.bilibili.com/video/" + bvid + "/");
            }
        }
        else
        {
            lines.Add("（这天没有记录到看过的视频）");
        }
        var owner = Text(d, "owner");
        var self = Text(d, "self");
        var text = string.Join(" ｜ ", parts) + " ｜ 分享 " + shares + " 条\n\n【看过的视频】\n" + string.Join("\n", lines);
        if (owner.Length > 0) text += "\n\n【写给主人】\n" + owner;
        if (self.Length > 0) text += "\n\n【只给自己】\n" + self;
        diaryText.Text = text;
    }

    static string Text(JsonElement obj, string name)
        => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? (v.GetString() ?? "") : "";

    async Task LoadStyleAsync()
    {
        if (!_sup.NodeRunning) return;
        var res = await Api.Get(_sup.Url, "/api/bili/style");
        if (!res.Ok) { styleText.Text = "读取失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res)); return; }
        var items = res.Prop("items");
        if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() == 0)
        {
            styleText.Text = "还没学到（跑一轮、看到有热评的视频后会开始积累）。";
            return;
        }
        var lines = new List<string>();
        var i = 0;
        foreach (var row in items.EnumerateArray())
        {
            i++;
            var text = row.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : "";
            var mentions = row.TryGetProperty("mentions", out var m) && m.ValueKind == JsonValueKind.Number ? m.GetInt64() : 1;
            lines.Add("「" + text + "」×" + mentions);
            if (i >= 12) break;
        }
        styleText.Text = "共 " + items.GetArrayLength() + " 条，最近常见：" + string.Join("、", lines);
    }

    async Task ClearStyleAsync()
    {
        if (!_sup.NodeRunning) return;
        var res = await Api.Post(_sup.Url, "/api/bili/style/clear", "{}");
        styleText.Text = res.Ok ? "已清空说话习惯。" : ("清空失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res)));
        if (res.Ok) await LoadStyleAsync();
    }

    public async Task RefreshAsync()
    {
        if (!_sup.NodeRunning)
        {
            loginState.Text = "内核没在运行：先点顶栏「启动」，再回来刷新。";
            enabled.IsEnabled = false;
            return;
        }
        enabled.IsEnabled = true;
        var res = await Api.Get(_sup.Url, "/api/bili/status");
        if (!res.Ok)
        {
            loginState.Text = "读取状态失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        var on = res.Bool("enabled");
        enabled.IsChecked = on;
        var cookie = res.Prop("cookie");
        var present = cookie.ValueKind == JsonValueKind.Object && cookie.TryGetProperty("present", out var p) && p.ValueKind == JsonValueKind.True;
        var source = cookie.ValueKind == JsonValueKind.Object && cookie.TryGetProperty("source", out var sr) && sr.ValueKind == JsonValueKind.String ? sr.GetString() ?? "" : "";
        var loggedIn = res.Bool("loggedIn");
        if (!present) loginState.Text = "未登录。点「扫码登录」，用手机 B 站 App 扫码确认。";
        else if (loggedIn) loginState.Text = "已登录（cookie 有效，来源：" + (source == "config" ? "config.json（重启/换机不用重扫）" : "data/bili/cookie.json") + "）。";
        else loginState.Text = "已保存 cookie，但 B 站未确认登录（可能过期了）。重新扫一次即可。";
        var pending = res.Prop("pending");
        if (pending.ValueKind == JsonValueKind.Object && pending.TryGetProperty("issuedAt", out var issued))
        {
            pendingSince = issued.ValueKind == JsonValueKind.Number ? issued.GetInt64().ToString() : "";
            qrHint.Text = "正在等待扫码…（每 2 秒检查一次，二维码 180 秒内有效）";
            qrHint.Visibility = Visibility.Visible;
            timer.Start();
        }
        else if (!timer.IsEnabled)
        {
            pendingSince = "";
            qrHint.Visibility = Visibility.Collapsed;
        }
        detail.Text = on ? "开关：已开启（发 B 站链接会先读视频资料）" : "开关：已关闭（按普通链接处理）";
        detail.SetResourceReference(StyleProperty, "Small");
        statusText.Text = BuildStatus(res);
        if (!editorsLoaded) { FillEditors(res); editorsLoaded = true; }
        await LoadDiaryAsync();
        await LoadStyleAsync();
    }

    static string BuildStatus(ApiResult res)
    {
        var wakes = Num(res.Root, "today", "wakes");
        var skipped = res.Prop("today") is { ValueKind: JsonValueKind.Object } t && t.TryGetProperty("skipped", out var sk) && sk.ValueKind == JsonValueKind.True;
        var readHour = Num(res.Root, "quota", "readHour");
        var readDay = Num(res.Root, "quota", "readDay");
        var ownerDays = Num(res.Root, "diary", "ownerDays");
        var selfDays = Num(res.Root, "diary", "selfDays");
        var todayChars = Num(res.Root, "diary", "todayOwnerChars");
        var shareCount = Num(res.Root, "share", "dayCount");
        var styleCount = Num(res.Root, "style", "items");
        var next = res.Prop("nextWakeMinutes");
        var nextText = next.ValueKind == JsonValueKind.Number ? FormatMinutes(next.GetInt32()) : "—";
        return "今天已醒 " + wakes + " 次" + (skipped ? "（今天开摆了）" : "")
            + "；读取 本小时 " + readHour + " / 今天 " + readDay
            + "；日记 " + ownerDays + " 天 / 自己 " + selfDays + " 天（今天 " + todayChars + " 字）"
            + "；今日分享 " + shareCount + " 条；说话习惯 " + styleCount + " 条；距下次窗口 " + nextText + "。";
    }

    static string FormatMinutes(int minutes)
    {
        if (minutes <= 0) return "现在";
        var h = minutes / 60;
        var m = minutes % 60;
        return (h > 0 ? h + " 小时 " : "") + (m > 0 || h == 0 ? m + " 分钟" : "");
    }

    void FillEditors(ApiResult res)
    {
        var wins = res.Prop("windows");
        if (wins.ValueKind == JsonValueKind.Array && wins.GetArrayLength() > 0)
        {
            var parts = new List<string>();
            foreach (var w in wins.EnumerateArray())
            {
                long start = w.TryGetProperty("start", out var s) && s.ValueKind == JsonValueKind.Number ? s.GetInt64() : 0;
                long end = w.TryGetProperty("end", out var e) && e.ValueKind == JsonValueKind.Number ? e.GetInt64() : 0;
                parts.Add(ClockText(start) + "-" + ClockText(end == 1440 ? 1440 : end));
            }
            windowsBox.Text = string.Join(", ", parts);
        }
        var night = res.Prop("night");
        if (night.ValueKind == JsonValueKind.Object)
        {
            skipBox.Text = Str(night, "skipChance", skipBox.Text);
            wakesBox.Text = Str(night, "maxWakesPerDay", wakesBox.Text);
            jitterBox.Text = Str(night, "jitterMinutes", jitterBox.Text);
        }
        var risk = res.Prop("risk");
        if (risk.ValueKind == JsonValueKind.Object)
        {
            readHourBox.Text = Str(risk, "readHourly", readHourBox.Text);
            readDayBox.Text = Str(risk, "readDaily", readDayBox.Text);
        }
        var share = res.Prop("shareCfg");
        if (share.ValueKind == JsonValueKind.Object)
        {
            shareOn.IsChecked = !(share.TryGetProperty("enabled", out var se) && se.ValueKind == JsonValueKind.False);
            shareDailyBox.Text = Str(share, "daily", shareDailyBox.Text);
            gapBox.Text = Str(share, "minGapMinutes", gapBox.Text);
            if (share.TryGetProperty("chats", out var chats) && chats.ValueKind == JsonValueKind.Array)
            {
                var lines = new List<string>();
                foreach (var c in chats.EnumerateArray())
                {
                    var id = c.TryGetProperty("chatId", out var ci) && ci.ValueKind == JsonValueKind.String ? ci.GetString() : "";
                    var name = c.TryGetProperty("name", out var cn) && cn.ValueKind == JsonValueKind.String ? cn.GetString() : "";
                    var daily = c.TryGetProperty("daily", out var cd) && cd.ValueKind == JsonValueKind.Number ? cd.GetInt64() : 1;
                    if (!string.IsNullOrWhiteSpace(id)) lines.Add(id + "," + name + "," + daily);
                }
                chatsBox.Text = string.Join("\n", lines);
            }
        }
    }

    static string Str(JsonElement obj, string name, string fallback)
        => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number
            ? (v.TryGetInt64(out var n) ? n.ToString() : v.GetDouble().ToString("0.##")) : fallback;

    static string ClockText(long minutes)
    {
        var m = (int)(minutes % (24 * 60));
        return (m / 60).ToString("00") + ":" + (m % 60).ToString("00");
    }

    async Task ToggleFeatureAsync()
    {
        var want = enabled.IsChecked == true;
        enabled.IsEnabled = false;
        try
        {
            var body = "{\"key\":\"bili\",\"value\":" + (want ? "true" : "false") + "}";
            var res = await Api.Post(_sup.Url, "/api/features", body);
            if (!res.Ok)
            {
                enabled.IsChecked = !want;
                await Dialog("开关保存失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res)));
                return;
            }
            await Dialog(want ? "已开启 B 站（只读）。" : "已关闭 B 站（只读）。");
        }
        finally { enabled.IsEnabled = true; }
    }

    async Task StartQrAsync()
    {
        Log("点扫码登录：NodeRunning=" + _sup.NodeRunning + " url=" + _sup.Url);
        if (!_sup.NodeRunning) { await Dialog("内核没在运行，先启动内核。"); return; }
        qrButton.IsEnabled = false;
        qrButton.Content = "生成中…";
        try
        {
            var res = await Api.Post(_sup.Url, "/api/bili/login/qr", "{}");
            Log("QR 响应：HTTP=" + res.StatusCode + " ok=" + res.Ok + " raw=" + (res.Raw ?? "").Length
                + " err=" + res.Error + " pngLen=" + res.Str("png").Length);
            if (!res.Ok)
            {
                await Dialog("生成二维码失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res)));
                return;
            }
            var b64 = res.Str("png");
            if (b64.Length == 0) { await Dialog("内核没返回二维码图片。"); return; }
            qrImage.Source = Decode(b64);
            // 图片控件自己也必须是 Visible：之前只把外层 qrBox 打开，Image 仍是 Collapsed，
            // 表现就是「日志说显示成功、界面一片空白」。
            qrImage.Visibility = Visibility.Visible;
            qrBox.Visibility = Visibility.Visible;
            qrHint.Text = "用手机 B 站 App 扫码，并在手机上点确认（180 秒内有效）。";
            qrHint.Visibility = Visibility.Visible;
            timer.Start();
            await Dispatcher.Yield(DispatcherPriority.Loaded);
            Log("二维码已显示：source=" + (qrImage.Source != null) + " imgVis=" + qrImage.Visibility
                + " boxVis=" + qrBox.Visibility + " imgSize=" + qrImage.ActualWidth + "x" + qrImage.ActualHeight);
        }
        catch (Exception ex)
        {
            Log("显示二维码异常：" + ex.GetType().Name + ": " + ex.Message);
            await Dialog("显示二维码失败：" + ex.Message);
        }
        finally
        {
            qrButton.IsEnabled = true;
            qrButton.Content = "扫码登录";
        }
    }

    void Log(string text)
    {
        try { _sup.Say("[bili] " + text); } catch { /* 诊断不许影响界面 */ }
    }

    async Task PollAsync()
    {
        var res = await Api.Post(_sup.Url, "/api/bili/login/poll", "{}");
        if (res.StatusCode == 409)
        {
            timer.Stop();
            qrHint.Visibility = Visibility.Collapsed;
            qrBox.Visibility = Visibility.Collapsed;
            return;
        }
        if (!res.Ok)
        {
            qrHint.Text = "轮询失败，稍后自动重试…";
            return;
        }
        var state = res.Str("state");
        switch (state)
        {
            case "waiting":
                qrHint.Text = "等待扫码…";
                break;
            case "scanned":
                qrHint.Text = "已扫码，请在手机上点「确认登录」。";
                break;
            case "ok":
                timer.Stop();
                qrBox.Visibility = Visibility.Collapsed;
                qrHint.Text = "登录成功。";
                await RefreshAsync();
                break;
            case "expired":
                timer.Stop();
                qrBox.Visibility = Visibility.Collapsed;
                qrHint.Text = "二维码过期了，点「扫码登录」重新生成。";
                break;
            case "error":
                timer.Stop();
                qrBox.Visibility = Visibility.Collapsed;
                qrHint.Text = "登录接口报错：" + res.Str("error") + "，稍后重试。";
                break;
        }
    }

    async Task LogoutAsync()
    {
        var res = await Api.Post(_sup.Url, "/api/bili/logout", "{}");
        if (!res.Ok) { await Dialog("退出登录失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res))); return; }
        timer.Stop();
        qrBox.Visibility = Visibility.Collapsed;
        qrHint.Visibility = Visibility.Collapsed;
        await RefreshAsync();
        await Dialog("已退出登录（cookie 已删除）。");
    }

    static BitmapImage Decode(string base64)
    {
        var bytes = Convert.FromBase64String(base64);
        var image = new BitmapImage();
        using var stream = new MemoryStream(bytes);
        image.BeginInit();
        image.CacheOption = BitmapCacheOption.OnLoad;
        image.StreamSource = stream;
        image.EndInit();
        image.Freeze();
        return image;
    }

    Task Dialog(string message)
    {
        detail.Text = message;
        return Task.CompletedTask;
    }
}
