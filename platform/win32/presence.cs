// 在场探测采样器（编译成 bin/presence.exe，由 bridge 拉起后常驻）。
//
// 为什么单独编个 exe：bridge 是纯 node，没有 ffi，拿不到 Win32；
// PowerShell 冷启动 400ms+ 且每次都要现场编译 C#，不能放进秒级采样。
// 常驻进程每秒采一次，写 data/presence.json，hook 只读这个文件（0 开销）。
//
// 判定"人在不在电脑前"只依赖两块 Win32：
//   GetLastInputInfo     系统级空闲时长（键盘+鼠标）
//   OpenInputDesktop     当前是否在锁屏/UAC 这种非输入桌面上
// 再加一张可见顶层窗口表，供调用方判断"那个窗口是不是在前台、有没有最小化"。
//
// 用法：
//   presence.exe --loop <输出文件> [间隔毫秒=1000]   常驻采样（bridge 用）
//   presence.exe --once                              采一次打到 stdout（排障用）
//
// 采样本身约 30μs + 一次窗口枚举 0.4ms，CPU 占用可忽略。

using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Management;

public class Presence
{
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool CloseDesktop(IntPtr hDesktop);
    const uint DESKTOP_SWITCHDESKTOP = 0x0100;

    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);

    // 非 ASCII 一律转 \uXXXX：这个文件会被 node / PowerShell / 记事本各读一遍，
    // 只要字节流是纯 ASCII 就不会在某一环被当成 GBK 解出乱码或者截断 JSON。
    static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 16);
        foreach (char c in s)
        {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c == '\r' || c == '\n' || c == '\t') sb.Append(' ');
            else if (c < 0x20) sb.Append(' ');
            else if (c < 0x7F) sb.Append(c);
            else sb.Append("\\u").Append(((int)c).ToString("x4"));
        }
        return sb.ToString();
    }

    static string Title(IntPtr h)
    {
        var sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // pid -> 进程名。只解析没见过的 pid：WT 的多个窗口共用一个 pid，steady state 几乎零成本。
    static Dictionary<uint, string> procCache = new Dictionary<uint, string>();
    static string ProcName(uint pid)
    {
        if (pid == 0) return "";
        string v;
        if (procCache.TryGetValue(pid, out v)) return v;
        try { v = Process.GetProcessById((int)pid).ProcessName; } catch { v = ""; }
        procCache[pid] = v;
        return v;
    }

    // 空闲秒数。GetLastInputInfo 的 dwTime 是 tick 回绕值，微软明说不保证单调，
    // 所以用无符号差值；算出超过 30 天的当异常（-1），调用方按"不在场"处理。
    static long IdleSeconds()
    {
        var li = new LASTINPUTINFO();
        li.cbSize = (uint)Marshal.SizeOf(li);
        if (!GetLastInputInfo(ref li)) return -1;
        uint diff = (uint)Environment.TickCount - li.dwTime;
        long sec = diff / 1000;
        if (sec > 30L * 24 * 3600) return -1;
        return sec;
    }

    // 锁屏（或 UAC 安全桌面）。
    // 主判据用前台窗口：锁屏时前台是 `LockApp`，UAC 是 `consent.exe`——
    // 这一条实测最可靠。OpenInputDesktop 只作辅助：Win11 上它经常照样打得开，
    // 单靠它会漏判（实测锁屏 + idle 3s 时它仍返回「可用」）。
    static bool DesktopLocked()
    {
        string fgProc = ProcName(FgPid());
        if (fgProc == "LockApp" || fgProc == "LogonUI" || fgProc == "consent")
            return true;

        IntPtr h = OpenInputDesktop(0, false, DESKTOP_SWITCHDESKTOP);
        if (h == IntPtr.Zero) return true;
        CloseDesktop(h);
        return false;
    }

    static uint FgPid()
    {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return 0;
        uint pid;
        GetWindowThreadProcessId(fg, out pid);
        return pid;
    }

    static string Sample()
    {
        long idle = IdleSeconds();
        bool locked = DesktopLocked();

        IntPtr fg = GetForegroundWindow();
        uint fgPid = 0;
        if (fg != IntPtr.Zero) GetWindowThreadProcessId(fg, out fgPid);

        var sb = new StringBuilder();
        sb.Append("{\"ok\":true");
        sb.Append(",\"ts\":").Append(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        sb.Append(",\"idleSeconds\":").Append(idle);
        sb.Append(",\"locked\":").Append(locked ? "true" : "false");
        sb.Append(",\"fgHwnd\":").Append(fg.ToInt64());
        sb.Append(",\"fgPid\":").Append(fgPid);
        sb.Append(",\"fgProc\":\"").Append(Esc(ProcName(fgPid))).Append("\"");
        sb.Append(",\"fgTitle\":\"").Append(Esc(Title(fg))).Append("\"");
        sb.Append(",\"fgMin\":").Append(fg != IntPtr.Zero && IsIconic(fg) ? "true" : "false");
        sb.Append(",\"selfPid\":").Append(Process.GetCurrentProcess().Id);

        var wins = new List<string>();
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            string t = Title(h);
            if (t.Length == 0) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            wins.Add("{\"hwnd\":" + h.ToInt64() + ",\"pid\":" + pid +
                     ",\"proc\":\"" + Esc(ProcName(pid)) + "\"" +
                     ",\"min\":" + (IsIconic(h) ? "true" : "false") +
                     ",\"title\":\"" + Esc(t) + "\"}");
            return true;
        }, IntPtr.Zero);
        sb.Append(",\"windows\":[").Append(string.Join(",", wins.ToArray())).Append("]}");
        return sb.ToString();
    }

    // 原子替换：先写临时文件再换名，读的一方永远看不到写了一半的内容
    static void AtomicWrite(string dest, string content)
    {
        string tmp = dest + ".tmp";
        File.WriteAllText(tmp, content, new UTF8Encoding(false));
        try
        {
            if (File.Exists(dest)) File.Replace(tmp, dest, null);
            else File.Move(tmp, dest);
        }
        catch
        {
            try { if (File.Exists(dest)) File.Delete(dest); File.Move(tmp, dest); } catch { }
        }
    }

    static void Main(string[] args)
    {
        string loopFile = null;
        int interval = 1000;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--loop" && i + 1 < args.Length) loopFile = args[++i];
            else if (args[i] == "--interval" && i + 1 < args.Length) interval = int.Parse(args[++i]);
        }

        if (loopFile == null)
        {
            try { Console.Out.Write(Sample()); }
            catch (Exception e) { Console.Out.Write("{\"ok\":false,\"error\":\"" + Esc(e.Message) + "\"}"); }
            return;
        }

        // 常驻：bridge 挂了也要自己退出并删掉采样文件，否则 hook 会一直读到
        // 一份「人不在场」的陈旧数据，把本该交给电脑的弹窗继续拦在飞书上。
        // 判据取启动时的父进程：bridge 用 spawn 拉起，父进程一死这里就知道。
        int parentPid = 0;
        try
        {
            using (var probe = Process.GetCurrentProcess())
            {
                parentPid = ParentOf(probe.Id);
            }
        }
        catch { parentPid = 0; }

        while (true)
        {
            if (parentPid > 0 && !ParentAlive(parentPid))
            {
                try { File.Delete(loopFile); } catch { }
                return;
            }

            string json;
            try { json = Sample(); }
            catch (Exception e)
            {
                json = "{\"ok\":false,\"ts\":" + DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() +
                       ",\"error\":\"" + Esc(e.Message) + "\"}";
            }
            try { AtomicWrite(loopFile, json); } catch { }

            if (Environment.TickCount % 60000 < interval) procCache.Clear();  // 顺手回收进程名缓存
            Thread.Sleep(interval);
        }
    }

    // 进程的父 pid。.NET Framework 没有现成 API，走 WMI；只在启动时调一次。
    static int ParentOf(int pid)
    {
        try
        {
            using (var q = new System.Management.ManagementObjectSearcher(
                "SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + pid))
            {
                foreach (var o in q.Get()) return Convert.ToInt32(o["ParentProcessId"]);
            }
        }
        catch { }
        return 0;
    }

    static bool ParentAlive(int pid)
    {
        try { using (var p = Process.GetProcessById(pid)) return !p.HasExited; }
        catch { return false; }
    }
}
