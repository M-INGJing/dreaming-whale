using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace WhaleLauncher.Views;

/// <summary>
/// 「能力」页：一项能力 = 一个子菜单（左侧列表）。
///
/// 约定（也写在 docs/能力扩展规范.md 里）：
///  - 能力清单来自内核 /api/capabilities，新增能力不需要改这里，左侧会自动长出一项；
///  - 每项能力都有：说明、启用开关、每日上限（空=跟随全局）、今日次数、最近一次、执行一次；
///  - 只有内核声明为 available 的能力才能启用（例如 B 站总开关关着时灰掉）。
/// </summary>
public sealed class CapabilitiesPage : UserControl, IRefreshable
{
    readonly RuntimeSupervisor _sup;
    readonly List<JsonElement> items = new();
    readonly CheckBox globalEnabled = new() { Content = "启用能力（让她在聊天里自己决定要不要做）" };
    readonly TextBox globalMax = new() { Width = 70, Text = "5" };
    readonly ListBox menu = new() { Width = 190, Margin = new Thickness(0, 0, 16, 0) };
    readonly TextBlock title = new();
    readonly TextBlock desc = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBlock stats = new() { TextWrapping = TextWrapping.Wrap };
    readonly TextBlock result = new() { TextWrapping = TextWrapping.Wrap };
    readonly CheckBox itemEnabled = new() { Content = "让她可以自己用这个能力" };
    readonly TextBox itemMax = new() { Width = 90 };
    readonly StackPanel detail = new();
    string lastSignature = "";
    DateTime nextLoad = DateTime.MinValue;
    bool loading;
    string selectedId = "";

    public CapabilitiesPage(RuntimeSupervisor sup)
    {
        _sup = sup;
        SetResourceReference(ForegroundProperty, "Text");
        UseLayoutRounding = true;

        var page = new Grid { Margin = new Thickness(28, 24, 32, 20) };
        page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        page.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        page.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });

        var header = new DockPanel { LastChildFill = false, Margin = new Thickness(0, 0, 0, 10) };
        var h = new TextBlock { Text = "能力", VerticalAlignment = VerticalAlignment.Center };
        h.SetResourceReference(StyleProperty, "H1");
        DockPanel.SetDock(h, Dock.Left);
        header.Children.Add(h);
        var reload = new Button { Content = "⟳ 刷新" };
        reload.SetResourceReference(StyleProperty, "Ghost");
        reload.Click += async (_, _) => await LoadAsync(true);
        DockPanel.SetDock(reload, Dock.Right);
        header.Children.Add(reload);
        Grid.SetRow(header, 0);
        page.Children.Add(header);

        var gate = new Border { Padding = new Thickness(16, 12, 16, 12), Margin = new Thickness(0, 0, 0, 12) };
        gate.SetResourceReference(StyleProperty, "Card");
        var gateBody = new StackPanel();
        gate.Child = gateBody;
        globalEnabled.SetResourceReference(StyleProperty, "DarkCheck");
        gateBody.Children.Add(globalEnabled);
        var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        row.Children.Add(new TextBlock { Text = "每天每个能力最多", VerticalAlignment = VerticalAlignment.Center });
        row.Children.Add(globalMax);
        row.Children.Add(new TextBlock { Text = "次（0 = 不限）", VerticalAlignment = VerticalAlignment.Center });
        var saveGlobal = new Button { Content = "保存", MinHeight = 30, Margin = new Thickness(10, 0, 0, 0) };
        saveGlobal.SetResourceReference(StyleProperty, "Primary");
        saveGlobal.Click += async (_, _) => await SaveGlobalAsync();
        row.Children.Add(saveGlobal);
        gateBody.Children.Add(row);
        gateBody.Children.Add(Note("这些是「她可以自己做」的事：聊天里由她判断要不要做，回复里只留一行内部标记，系统在后台执行，回复优先。"));
        Grid.SetRow(gate, 1);
        page.Children.Add(gate);

        var body = new Grid { Margin = new Thickness(0, 0, 0, 0) };
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        body.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        var left = new Border { Padding = new Thickness(12, 12, 12, 12), Margin = new Thickness(0, 0, 0, 0) };
        left.SetResourceReference(StyleProperty, "Card");
        left.Child = menu;
        menu.SelectionChanged += (_, _) => RenderSelected();
        body.Children.Add(left);
        var right = new Border { Padding = new Thickness(16, 12, 16, 12), Margin = new Thickness(12, 0, 0, 0) };
        right.SetResourceReference(StyleProperty, "Card");
        detail.Children.Add(title);
        detail.Children.Add(desc);
        detail.Children.Add(stats);
        detail.Children.Add(result);
        detail.Children.Add(new Separator { Margin = new Thickness(0, 8, 0, 8) });
        itemEnabled.SetResourceReference(StyleProperty, "DarkCheck");
        detail.Children.Add(itemEnabled);
        var maxRow = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 0) };
        maxRow.Children.Add(new TextBlock { Text = "每日上限（留空 = 跟随全局）", VerticalAlignment = VerticalAlignment.Center });
        maxRow.Children.Add(itemMax);
        detail.Children.Add(maxRow);
        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
        var saveItem = new Button { Content = "保存这项", MinHeight = 30 };
        saveItem.SetResourceReference(StyleProperty, "Primary");
        saveItem.Click += async (_, _) => await SaveItemAsync();
        actions.Children.Add(saveItem);
        var runNow = new Button { Content = "现在执行一次", MinHeight = 30, Margin = new Thickness(8, 0, 0, 0) };
        runNow.SetResourceReference(StyleProperty, "Ghost");
        runNow.Click += async (_, _) => await RunNowAsync();
        actions.Children.Add(runNow);
        detail.Children.Add(actions);
        detail.Children.Add(Note("这项能力做什么、会不会有副作用（比如发消息），看上面的说明；「执行一次」和她在聊天里触发走同一套逻辑。"));
        right.Child = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Content = detail };
        body.Children.Add(right);
        Grid.SetColumn(left, 0);
        Grid.SetColumn(right, 1);
        Grid.SetRow(body, 2);
        page.Children.Add(body);

        Content = page;
        Loaded += async (_, _) => await LoadAsync(true);
    }

    static TextBlock Note(string text)
    {
        var note = new TextBlock { Text = text, TextWrapping = TextWrapping.Wrap, LineHeight = 19, Margin = new Thickness(0, 6, 0, 0) };
        note.SetResourceReference(StyleProperty, "Small");
        return note;
    }

    public async Task RefreshAsync()
    {
        if (!_sup.NodeRunning) { result.Text = "内核没在运行。"; return; }
        await LoadAsync(false);
    }

    async Task LoadAsync(bool force)
    {
        if (loading) return;
        if (!_sup.NodeRunning) return;
        if (!force && DateTime.UtcNow < nextLoad) return;
        nextLoad = DateTime.UtcNow.AddSeconds(5);
        loading = true;
        try
        {
            var res = await Api.Get(_sup.Url, "/api/capabilities");
            if (!res.Ok)
            {
                result.Text = "读取失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
                return;
            }
            var payload = res.Prop("items");
            var signature = BuildSignature(res, payload);
            globalEnabled.IsChecked = res.Bool("enabled");
            globalMax.Text = res.Long("maxPerDay").ToString();
            if (!force && signature == lastSignature) return;
            lastSignature = signature;
            items.Clear();
            menu.Items.Clear();
            if (payload.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in payload.EnumerateArray())
                {
                    items.Add(item);
                    menu.Items.Add(new ListBoxItem { Content = Text(item, "label"), Tag = Text(item, "id") });
                }
            }
            var index = 0;
            for (var i = 0; i < items.Count; i += 1)
            {
                if (Text(items[i], "id") == selectedId) { index = i; break; }
            }
            if (items.Count > 0)
            {
                menu.SelectedIndex = index;
                RenderSelected();
            }
            else
            {
                title.Text = "还没有能力";
                desc.Text = "往 src/services/capabilities.js 的 REGISTRY 加一条，这里会自动出现。";
            }
        }
        finally
        {
            loading = false;
        }
    }

    static string BuildSignature(ApiResult res, JsonElement payload)
    {
        var sb = new System.Text.StringBuilder();
        sb.Append(res.Bool("enabled")).Append('|').Append(res.Long("maxPerDay")).Append(';');
        if (payload.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in payload.EnumerateArray())
            {
                sb.Append(Text(item, "id")).Append('|')
                  .Append(item.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True)
                  .Append('|')
                  .Append(item.TryGetProperty("today", out var td) && td.ValueKind == JsonValueKind.Number ? td.GetInt64() : 0)
                  .Append(';');
            }
        }
        return sb.ToString();
    }

    void RenderSelected()
    {
        var index = menu.SelectedIndex;
        if (index < 0 || index >= items.Count) return;
        var item = items[index];
        selectedId = Text(item, "id");
        title.Text = Text(item, "label");
        title.SetResourceReference(StyleProperty, "H2");
        desc.Text = Text(item, "desc");
        desc.SetResourceReference(StyleProperty, "Small");
        var available = item.TryGetProperty("available", out var av) && av.ValueKind == JsonValueKind.True;
        var enabled = item.TryGetProperty("enabled", out var en) && en.ValueKind == JsonValueKind.True;
        itemEnabled.IsChecked = enabled;
        itemEnabled.IsEnabled = available;
        itemMax.Text = item.TryGetProperty("maxPerDay", out var mx) && mx.ValueKind == JsonValueKind.Number ? mx.GetInt64().ToString() : "";
        var today = item.TryGetProperty("today", out var td) && td.ValueKind == JsonValueKind.Number ? td.GetInt64() : 0;
        var lastText = "还没有";
        if (item.TryGetProperty("last", out var last) && last.ValueKind == JsonValueKind.Object)
        {
            var at = last.TryGetProperty("at", out var atv) && atv.ValueKind == JsonValueKind.Number ? atv.GetInt64() : 0;
            var summary = last.TryGetProperty("summary", out var sm) && sm.ValueKind == JsonValueKind.String ? sm.GetString() : "";
            var ok = last.TryGetProperty("ok", out var okv) && okv.ValueKind == JsonValueKind.True;
            lastText = DateTimeOffset.FromUnixTimeMilliseconds(at).ToLocalTime().ToString("MM-dd HH:mm")
                + " " + (ok ? "成功：" : "失败：") + (summary ?? "");
        }
        stats.Text = "今日已做 " + today + " 次；最近一次：" + lastText
            + (available ? "" : "\n（这个能力依赖的功能现在关着，所以暂时不可用）");
        stats.SetResourceReference(StyleProperty, "Small");
        result.Text = "";
    }

    async Task SaveGlobalAsync()
    {
        var body = "{\"globalEnabled\":" + (globalEnabled.IsChecked == true ? "true" : "false")
            + ",\"globalMaxPerDay\":" + Num(globalMax.Text, 5) + "}";
        await PostAsync("/api/capabilities/set", body, "全局设置已保存。");
    }

    async Task SaveItemAsync()
    {
        if (selectedId.Length == 0) return;
        var max = itemMax.Text.Trim();
        var body = "{\"id\":\"" + Api.Esc(selectedId) + "\",\"enabled\":" + (itemEnabled.IsChecked == true ? "true" : "false")
            + (max.Length > 0 ? ",\"maxPerDay\":" + Num(max, 0) : "") + "}";
        await PostAsync("/api/capabilities/set", body, "这项能力已保存。");
    }

    async Task RunNowAsync()
    {
        if (selectedId.Length == 0) return;
        result.Text = "正在执行…";
        var res = await Api.Post(_sup.Url, "/api/capabilities/run", "{\"id\":\"" + Api.Esc(selectedId) + "\"}");
        if (!res.Ok)
        {
            result.Text = "执行失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        var r = res.Prop("result");
        var ok = r.ValueKind == JsonValueKind.Object && r.TryGetProperty("ok", out var okv) && okv.ValueKind == JsonValueKind.True;
        var summary = r.ValueKind == JsonValueKind.Object && r.TryGetProperty("summary", out var sm) && sm.ValueKind == JsonValueKind.String ? sm.GetString() : "";
        result.Text = (ok ? "完成：" : "没做成：") + summary;
        await LoadAsync(true);
    }

    async Task PostAsync(string path, string body, string okText)
    {
        var res = await Api.Post(_sup.Url, path, body);
        if (!res.Ok)
        {
            result.Text = "保存失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        result.Text = okText;
        await LoadAsync(true);
    }

    static long Num(string text, long fallback)
        => long.TryParse((text ?? "").Trim(), out var n) ? Math.Max(0, n) : fallback;

    static string Text(JsonElement obj, string name)
        => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? (v.GetString() ?? "") : "";
}
