using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace WhaleLauncher
{
    /// <summary>
    /// 启动器自己的外观设置：深浅色 + 背景图。
    /// 只写到 data/launcher-ui.json，不碰 config.json，也不影响内核和桥接。
    /// </summary>
    public static class Appearance
    {
        private static readonly string SettingsPath =
            Path.Combine(AppContext.BaseDirectory, "data", "launcher-ui.json");

        public static string Theme { get; private set; } = "dark";
        public static string Backdrop { get; private set; } = "";
        public static bool IsDark => !string.Equals(Theme, "light", StringComparison.OrdinalIgnoreCase);

        public static event Action Changed;

        // 浅色「晨雾」：白是带蓝的雾白，强调色压深到能在白底上做正文（Accent 4.56:1）
        private static readonly Dictionary<string, string> Light = new Dictionary<string, string>
        {
            ["Bg"] = "#FFF3F6FA",
            ["BgDeep"] = "#FFE9EFF6",
            ["BgNav"] = "#E6F5F8FB",
            ["BgTop"] = "#F2FFFFFF",
            ["CardBg"] = "#FFFFFFFF",
            ["CardBorder"] = "#FFDCE5EF",
            ["Line"] = "#FFE7EDF4",
            ["LineSoft"] = "#FFEFF3F8",
            ["Text"] = "#FF0F1926",
            ["Text2"] = "#FF3D4B5B",
            ["Muted"] = "#FF5A6878",
            // 11px 辅助文字也要 4.5:1：原 #6E7C8C 压在 Bg #F3F6FA 上只有 3.93:1
            ["Dim"] = "#FF616F80",
            ["Accent"] = "#FF0E7FA6",
            // 选中项文字/图标：Accent 落在 AccentSoft 上只有 3.9:1，必须换深一档（此处 5.4:1）
            ["AccentText"] = "#FF0A6884",
            ["AccentDim"] = "#FFE4F1F6",
            ["AccentSoft"] = "#FFE1F0F7",
            ["Ok"] = "#FF0F8A5F",
            ["Warn"] = "#FF9A5B10",
            ["Bad"] = "#FFBF3A31",
            ["Idle"] = "#FFA9B6C6",
            ["PrimaryBg"] = "#FF0E7FA6",
            ["PrimaryFg"] = "#FFFFFFFF",
            ["PrimaryHover"] = "#FF0A6884",
            ["GhostBg"] = "#FFFFFFFF",
            ["GhostHover"] = "#FFEFF5F9",
            ["Hover"] = "#FFEFF5F9",
            ["FieldBg"] = "#FFF7FAFC",
            ["FieldBorder"] = "#FFCEDAE5",
            ["PopupBg"] = "#FFFFFFFF",
            ["ChipBg"] = "#FFFBFDFE",
            ["Surface3"] = "#FFEFF4F9",
            ["TopBtnHover"] = "#FFEFF4F9",
            ["ScrollThumb"] = "#FFC3D0DE",
            ["BackdropTint"] = "#F2F3F6FA",
            ["Gold"] = "#FFB5822A",
        };

        // 深色「夜航」：底色偏靛蓝而不是中性黑，全屏只有一个高饱和色（水光青）
        private static readonly Dictionary<string, string> Dark = new Dictionary<string, string>
        {
            ["Bg"] = "#FF070B13",
            ["BgDeep"] = "#FF04070D",
            ["BgNav"] = "#E60A0F19",
            ["BgTop"] = "#F20B111B",
            ["CardBg"] = "#FF0E1520",
            ["CardBorder"] = "#FF1D2937",
            ["Line"] = "#FF16202C",
            ["LineSoft"] = "#FF111A24",
            ["Text"] = "#FFEDF2F8",
            ["Text2"] = "#FFB9C6D6",
            ["Muted"] = "#FF8494A8",
            // 原 #6A7A8E 在 CardBg 上只有 4.18:1，11px 辅助文字读不清，提亮到 4.99:1
            ["Dim"] = "#FF77879B",
            ["Accent"] = "#FF55C9E6",
            ["AccentText"] = "#FF7FD8EC",
            ["AccentDim"] = "#FF0F2430",
            ["AccentSoft"] = "#FF102A38",
            ["Ok"] = "#FF45D6A0",
            ["Warn"] = "#FFF0BE72",
            ["Bad"] = "#FFF07E86",
            ["Idle"] = "#FF4A5A6E",
            ["PrimaryBg"] = "#FF6FD3EA",
            ["PrimaryFg"] = "#FF04202B",
            ["PrimaryHover"] = "#FF8ADFF1",
            ["GhostBg"] = "#FF101927",
            ["GhostHover"] = "#FF16222F",
            ["Hover"] = "#FF16212E",
            ["FieldBg"] = "#FF0B131E",
            ["FieldBorder"] = "#FF21303F",
            ["PopupBg"] = "#FF0F1826",
            ["ChipBg"] = "#FF0C1521",
            ["Surface3"] = "#FF16212E",
            ["TopBtnHover"] = "#FF16212E",
            ["ScrollThumb"] = "#FF2B3C50",
            ["BackdropTint"] = "#C0070B13",
            ["Gold"] = "#FFF2C56B",
        };

        public static void Load()
        {
            try
            {
                if (!File.Exists(SettingsPath)) return;
                using var doc = JsonDocument.Parse(File.ReadAllText(SettingsPath));
                var root = doc.RootElement;
                if (root.TryGetProperty("theme", out var t) && t.ValueKind == JsonValueKind.String)
                {
                    var v = (t.GetString() ?? "").Trim().ToLowerInvariant();
                    if (v == "light" || v == "dark") Theme = v;
                }
                if (root.TryGetProperty("backdrop", out var b) && b.ValueKind == JsonValueKind.String)
                    Backdrop = b.GetString() ?? "";
            }
            catch
            {
                // 设置文件坏了就用默认深色，不要让启动器起不来
            }
        }

        public static void Save()
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(SettingsPath) ?? AppContext.BaseDirectory);
                var json = JsonSerializer.Serialize(new { theme = Theme, backdrop = Backdrop },
                    new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(SettingsPath, json);
            }
            catch { }
        }

        public static bool SetTheme(string theme)
        {
            var next = string.Equals(theme, "light", StringComparison.OrdinalIgnoreCase) ? "light" : "dark";
            if (next == Theme) return false;
            Theme = next;
            ApplyTheme();
            Save();
            Changed?.Invoke();
            return true;
        }

        /// <summary>把当前主题写进 App.xaml 里的画刷。画刷是共享实例，改 Color 就能让所有引用一起变。</summary>
        public static void ApplyTheme()
        {
            if (Application.Current == null) return;
            var map = IsDark ? Dark : Light;
            foreach (var kv in map)
            {
                var color = (Color)ColorConverter.ConvertFromString(kv.Value);
                // 不能原地改：WPF 会把 Application.Resources 里的画刷冻结。
                // 直接换新实例，所有 DynamicResource 引用会跟着刷新。
                Application.Current.Resources[kv.Key] = new SolidColorBrush(color);
            }
        }

        public static bool TrySetBackdrop(string path, out string error)
        {
            error = "";
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                error = "找不到这张图片。";
                return false;
            }
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(path, UriKind.Absolute);
                bmp.DecodePixelWidth = 1920;
                bmp.EndInit();
                bmp.Freeze();
            }
            catch (Exception ex)
            {
                error = "这张图片读不了：" + ex.Message;
                return false;
            }

            Backdrop = path;
            Save();
            Changed?.Invoke();
            return true;
        }

        public static void ClearBackdrop()
        {
            if (string.IsNullOrEmpty(Backdrop)) return;
            Backdrop = "";
            Save();
            Changed?.Invoke();
        }

        public static BitmapImage LoadBackdrop()
        {
            if (string.IsNullOrWhiteSpace(Backdrop) || !File.Exists(Backdrop)) return null;
            try
            {
                var bmp = new BitmapImage();
                bmp.BeginInit();
                bmp.CacheOption = BitmapCacheOption.OnLoad;
                bmp.CreateOptions = BitmapCreateOptions.IgnoreImageCache;
                bmp.UriSource = new Uri(Backdrop, UriKind.Absolute);
                bmp.DecodePixelWidth = 1920;
                bmp.EndInit();
                bmp.Freeze();
                return bmp;
            }
            catch
            {
                return null;
            }
        }
    }
}
