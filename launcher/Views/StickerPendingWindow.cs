using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace WhaleLauncher.Views;

/// <summary>
/// 「收藏待定」审核窗：别人发的表情包先收进 data/stickers/待定，这里人工归类或删除。
///
/// 归类走 POST /api/stickers/collect/resolve（内核负责移文件 + 改索引）；
/// 缩略图直接用本机路径加载（启动器和内核同机），不额外占 HTTP 带宽。
/// </summary>
public sealed class StickerPendingWindow : Window
{
    readonly RuntimeSupervisor _sup;
    readonly StackPanel list = new();
    readonly TextBlock hint = new() { TextWrapping = TextWrapping.Wrap };
    readonly List<ComboBox> boxes = new();
    List<string> categories = new();

    public StickerPendingWindow(RuntimeSupervisor sup)
    {
        _sup = sup;
        Title = "收藏的表情包 · 待定";
        Width = 620;
        Height = 640;
        WindowStartupLocation = WindowStartupLocation.CenterOwner;
        SetResourceReference(BackgroundProperty, "Bg");

        var root = new DockPanel { Margin = new Thickness(18) };
        Content = root;

        var header = new DockPanel { LastChildFill = false, Margin = new Thickness(0, 0, 0, 10) };
        var title = new TextBlock { Text = "别人发的表情包（先去重，再等归类）", VerticalAlignment = VerticalAlignment.Center };
        title.SetResourceReference(StyleProperty, "H2");
        header.Children.Add(title);
        var reload = new Button { Content = "⟳ 刷新", Style = (Style)FindResource("Ghost") };
        reload.Click += async (_, _) => await LoadAsync();
        DockPanel.SetDock(reload, Dock.Right);
        header.Children.Add(reload);
        DockPanel.SetDock(header, Dock.Top);
        root.Children.Add(header);

        hint.SetResourceReference(StyleProperty, "Small");
        hint.Margin = new Thickness(0, 0, 0, 8);
        DockPanel.SetDock(hint, Dock.Top);
        root.Children.Add(hint);

        var scroll = new ScrollViewer { VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        scroll.Content = list;
        root.Children.Add(scroll);

        Loaded += async (_, _) => await LoadAsync();
    }

    async Task LoadAsync()
    {
        list.Children.Clear();
        boxes.Clear();
        if (!_sup.NodeRunning) { hint.Text = "内核没在运行，先启动内核。"; return; }
        var res = await Api.Get(_sup.Url, "/api/stickers/collect/pending");
        if (!res.Ok)
        {
            hint.Text = "读取失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res)) + "（表情包总开关关着时也会这样）";
            return;
        }
        categories = new List<string>();
        var cats = res.Prop("categories");
        if (cats.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in cats.EnumerateArray())
            {
                if (c.TryGetProperty("label", out var l) && l.ValueKind == JsonValueKind.String)
                {
                    var label = l.GetString() ?? "";
                    if (label.Length > 0 && !categories.Contains(label)) categories.Add(label);
                }
            }
        }
        var items = res.Prop("items");
        if (items.ValueKind != JsonValueKind.Array || items.GetArrayLength() == 0)
        {
            hint.Text = "还没有待定的表情包。别人发一个，这里就会出现。";
            return;
        }
        hint.Text = "共 " + items.GetArrayLength() + " 张待定。选个分类点「归档」，或直接删掉。";
        foreach (var item in items.EnumerateArray()) list.Children.Add(BuildRow(item));
    }

    FrameworkElement BuildRow(JsonElement item)
    {
        var sha = Str(item, "sha");
        var file = Str(item, "path");
        var desc = Str(item, "description");
        var sender = Str(item, "sender");
        var chatType = Str(item, "chatType");

        var card = new Border { Padding = new Thickness(12, 10, 12, 10), Margin = new Thickness(0, 0, 0, 10) };
        card.SetResourceReference(StyleProperty, "Card");
        var row = new DockPanel { LastChildFill = true };
        card.Child = row;

        var img = new Image { Width = 72, Height = 72, Stretch = Stretch.Uniform, Margin = new Thickness(0, 0, 12, 0) };
        try
        {
            var bmp = new BitmapImage();
            bmp.BeginInit();
            bmp.CacheOption = BitmapCacheOption.OnLoad;
            bmp.UriSource = new Uri(file, UriKind.Absolute);
            bmp.EndInit();
            bmp.Freeze();
            img.Source = bmp;
        }
        catch { /* 图坏了就只显示文字 */ }
        DockPanel.SetDock(img, Dock.Left);
        row.Children.Add(img);

        var body = new StackPanel();
        row.Children.Add(body);

        var text = new TextBlock
        {
            Text = (desc.Length > 0 ? desc : "（还没描述）") + "\n" + (chatType == "group" ? "群聊" : "私聊") + (sender.Length > 0 ? " · " + sender : ""),
            TextWrapping = TextWrapping.Wrap,
        };
        text.SetResourceReference(StyleProperty, "Small");
        body.Children.Add(text);

        var actions = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
        var box = new ComboBox { Width = 130, IsEditable = true };
        foreach (var c in categories) box.Items.Add(c);
        if (box.Items.Count > 0) box.SelectedIndex = 0;
        boxes.Add(box);
        actions.Children.Add(box);

        var keep = new Button { Content = "归档", Margin = new Thickness(8, 0, 0, 0), MinHeight = 28 };
        keep.SetResourceReference(StyleProperty, "Primary");
        keep.Click += async (_, _) => await ResolveAsync(sha, box.Text, false, card);
        actions.Children.Add(keep);

        var del = new Button { Content = "删除", Margin = new Thickness(8, 0, 0, 0), MinHeight = 28 };
        del.SetResourceReference(StyleProperty, "Ghost");
        del.Click += async (_, _) => await ResolveAsync(sha, "", true, card);
        actions.Children.Add(del);

        body.Children.Add(actions);
        return card;
    }

    async Task ResolveAsync(string sha, string category, bool delete, FrameworkElement row)
    {
        if (!delete && string.IsNullOrWhiteSpace(category)) { hint.Text = "先选一个分类。"; return; }
        var body = delete
            ? "{\"sha\":\"" + Api.Esc(sha) + "\",\"action\":\"delete\"}"
            : "{\"sha\":\"" + Api.Esc(sha) + "\",\"category\":\"" + Api.Esc(category.Trim()) + "\"}";
        var res = await Api.Post(_sup.Url, "/api/stickers/collect/resolve", body);
        if (!res.Ok)
        {
            hint.Text = "操作失败：" + (res.Error.Length > 0 ? res.Error : Api.Detail(res));
            return;
        }
        list.Children.Remove(row);
        hint.Text = delete ? "已删除。" : "已归档到「" + category.Trim() + "」。";
    }

    static string Str(JsonElement obj, string name)
        => obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? (v.GetString() ?? "") : "";
}
