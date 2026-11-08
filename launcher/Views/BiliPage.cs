using System;
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

        var about = Card("说明");
        body.Children.Add(about);
        ((StackPanel)about.Child).Children.Add(Note("登录后可读公开视频的字幕与热评（没有字幕的视频会明确标注「没看到画面」）。第一版没有点赞/评论/私信，后续阶段见 docs/B站养鱼计划.md。"));

        timer.Tick += async (_, _) => await PollAsync();
        Unloaded += (_, _) => timer.Stop();
        Loaded += async (_, _) => await RefreshAsync();
    }

    Border Card(string heading = null)
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
        return card;
    }

    static TextBlock Note(string text)
    {
        var note = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, LineHeight = 19, Margin = new Thickness(0, 6, 0, 2) };
        note.SetResourceReference(StyleProperty, "Small");
        return note;
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
        var loggedIn = res.Bool("loggedIn");
        if (!present) loginState.Text = "未登录。点「扫码登录」，用手机 B 站 App 扫码确认。";
        else if (loggedIn) loginState.Text = "已登录（cookie 有效）。";
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
