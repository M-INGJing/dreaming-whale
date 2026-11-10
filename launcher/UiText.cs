using System;

namespace WhaleLauncher;

/// <summary>
/// 页面级「保存成功 / 失败」的统一说法与统一的错误取值顺序。
///
/// 以前每个页面各写各的：成功有「已保存」「✔ 已保存」「已保存 19:23:45」三种写法，
/// 失败则每处都复制一遍「res.Error 为空就退回 Api.Detail(res)」这段顺序。
/// 好处不只是同一句话——错误原因的兜底顺序只有一处，就不会有的页面显示空字符串。
/// </summary>
public static class UiText
{
    /// <summary>用她的口吻说一句：「记下了」。</summary>
    public static string Saved(string what = null)
        => string.IsNullOrWhiteSpace(what) ? "记下了" : "记下了：" + what;

    /// <summary>带时间戳的成功提示（同一页会反复保存时，用来区分「又存了一次」）。</summary>
    public static string SavedAt(string what = null)
        => Saved(what) + " · " + DateTime.Now.ToString("HH:mm:ss");

    /// <summary>失败固定为「&lt;做什么&gt;失败：&lt;原因&gt;」，原因优先业务错误、其次原始响应。</summary>
    public static string Failed(string what, ApiResult res)
        => what + "失败：" + Why(res);

    /// <summary>只有一句人话（异常 message、本地校验不通过）时用这个。</summary>
    public static string Failed(string what, string reason)
        => what + "失败：" + (string.IsNullOrWhiteSpace(reason) ? "没有返回原因" : reason.Trim());

    static string Why(ApiResult res)
    {
        var text = (res?.Error ?? "").Trim();
        if (text.Length == 0) text = (Api.Detail(res) ?? "").Trim();
        return text.Length == 0 ? "没有返回原因" : text;
    }
}
