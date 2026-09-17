using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A GUI-subsystem observer, not a terminal parent. It launches each Node probe
// with CREATE_NO_WINDOW and observes actual visible desktop windows using Win32.
class Observer {
    delegate bool EnumWindowsProc(IntPtr window, IntPtr state);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr state);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder value, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder value, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rectangle);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("winmm.dll")] static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] static extern uint timeEndPeriod(uint period);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
        public uint cb; public string reserved, desktop, title;
        public uint x, y, width, height, xCountChars, yCountChars, fillAttribute, flags;
        public ushort showWindow, reservedSize; public IntPtr reservedBytes, stdInput, stdOutput, stdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public uint pid, tid; }
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 10000000 };
    static string outputDir;
    static string workdir;
    static bool IsConsoleClass(string name) {
        return name == "ConsoleWindowClass" || name == "CASCADIA_HOSTING_WINDOW_CLASS" || name == "PseudoConsoleWindow";
    }
    static string Sanitize(string value) { return value.Replace(workdir, "<workdir>"); }
    static Dictionary<string, Dictionary<string, object>> Snapshot() {
        var result = new Dictionary<string, Dictionary<string, object>>();
        EnumWindows(delegate(IntPtr window, IntPtr ignored) {
            if (!IsWindowVisible(window)) return true;
            var text = new StringBuilder(1024); GetClassName(window, text, text.Capacity);
            string className = text.ToString();
            if (!IsConsoleClass(className)) return true;
            uint pid; GetWindowThreadProcessId(window, out pid);
            RECT bounds; GetWindowRect(window, out bounds);
            int cloaked = 0; DwmGetWindowAttribute(window, 14, out cloaked, 4);
            if (bounds.right <= bounds.left || bounds.bottom <= bounds.top || cloaked != 0 || IsIconic(window)) return true;
            text.Clear(); GetWindowText(window, text, text.Capacity);
            string processName = "exited";
            try { processName = Process.GetProcessById((int)pid).ProcessName; } catch (ArgumentException) { }
            string key = window.ToInt64().ToString("X") + ":" + pid;
            result[key] = new Dictionary<string, object> {
                { "handle", window.ToInt64().ToString("X") }, { "pid", pid }, { "class", className },
                { "process", processName }, { "title", Sanitize(text.ToString()) },
                { "visible", true }, { "minimized", IsIconic(window) }, { "cloaked", cloaked },
                { "bounds", new int[] { bounds.left, bounds.top, bounds.right, bounds.bottom } }
            };
            return true;
        }, IntPtr.Zero);
        return result;
    }
    static void Screenshot(string phase) {
        var bounds = Screen.PrimaryScreen.Bounds;
        using (var bitmap = new Bitmap(bounds.Width, bounds.Height)) {
            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bounds.Size);
            bitmap.Save(Path.Combine(outputDir, phase + "-first-window.png"), ImageFormat.Png);
        }
    }
    static object RunPhase(string node, string worker, string configFile, string phase, bool positive) {
        Thread.Sleep(350);
        var preexisting = Snapshot();
        var seen = new Dictionary<string, Dictionary<string, object>>();
        var startup = new STARTUPINFO(); startup.cb = (uint)Marshal.SizeOf(startup);
        startup.flags = 1; startup.showWindow = 1;
        var command = new StringBuilder("\"" + node + "\" --experimental-strip-types \"" + worker + "\" \"" + configFile + "\" " + phase);
        PROCESS_INFORMATION process;
        uint flags = positive ? 0x00000010u : 0x08000000u;
        if (!CreateProcess(node, command, IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, workdir, ref startup, out process)) throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
        var timer = Stopwatch.StartNew();
        bool checkedConsole = positive;
        bool nodeHadConsole = positive;
        int attachError = 0;
        int samples = 0;
        string screenshotError = null;
        bool screenshotAttempted = false;
        uint exitCode;
        try {
            while (true) {
                samples++;
                foreach (var pair in Snapshot()) {
                    if (preexisting.ContainsKey(pair.Key)) continue;
                    if (!seen.ContainsKey(pair.Key)) {
                        pair.Value["firstMs"] = timer.Elapsed.TotalMilliseconds;
                        pair.Value["samples"] = 0;
                        seen[pair.Key] = pair.Value;
                    }
                    seen[pair.Key]["lastMs"] = timer.Elapsed.TotalMilliseconds;
                    seen[pair.Key]["samples"] = (int)seen[pair.Key]["samples"] + 1;
                }
                // The long positive control gives a stable screenshot. Keep real
                // Git observation free of screenshot latency.
                if (positive && seen.Count > 0 && !screenshotAttempted) {
                    screenshotAttempted = true;
                    try { Screenshot(phase); } catch (Exception error) { screenshotError = error.Message; }
                }
                if (!checkedConsole && File.Exists(Path.Combine(outputDir, phase + "-ready"))) {
                    nodeHadConsole = AttachConsole(process.pid);
                    attachError = Marshal.GetLastWin32Error();
                    if (nodeHadConsole) FreeConsole();
                    checkedConsole = true;
                }
                if (WaitForSingleObject(process.process, 0) == 0) break;
                if (timer.ElapsedMilliseconds > 60000) { TerminateProcess(process.process, 9); throw new Exception("Probe phase timed out"); }
                Thread.Sleep(1);
            }
            GetExitCodeProcess(process.process, out exitCode);
        } finally { CloseHandle(process.thread); CloseHandle(process.process); }
        return new {
            phase, nodePid = process.pid, flags = positive ? "CREATE_NEW_CONSOLE" : "CREATE_NO_WINDOW",
            observerConsoleHandle = GetConsoleWindow().ToInt64(), checkedConsole, nodeHadConsole, attachError,
            exitCode, samples, elapsedMs = timer.Elapsed.TotalMilliseconds, screenshotError,
            preexistingVisibleConsoleWindows = preexisting.Values,
            newVisibleConsoleWindows = seen.Values, newVisibleConsoleWindowCount = seen.Count
        };
    }
    [STAThread] static int Main(string[] args) {
        string configFile = Path.GetFullPath(args[0]);
        var config = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configFile));
        outputDir = (string)config["outputDir"]; workdir = (string)config["workdir"];
        Directory.CreateDirectory(outputDir);
        var report = new Dictionary<string, object>();
        int status = 0;
        timeBeginPeriod(1);
        try {
            report["observerSubsystem"] = "Windows GUI";
            report["observerConsoleHandle"] = GetConsoleWindow().ToInt64();
            report["userInteractive"] = Environment.UserInteractive;
            report["sessionId"] = Process.GetCurrentProcess().SessionId;
            report["osVersion"] = Environment.OSVersion.ToString();
            report["screenBounds"] = Screen.PrimaryScreen.Bounds.ToString();
            if (GetConsoleWindow() != IntPtr.Zero) throw new Exception("Observer unexpectedly has a console");
            var phases = new List<object>(); report["phases"] = phases;
            foreach (string phase in new [] { "positive-control", "baseline-1", "fixed-1", "baseline-2", "fixed-2" }) {
                object data = RunPhase((string)config["node"], (string)config["worker"], configFile, phase, phase == "positive-control");
                phases.Add(data);
                File.WriteAllText(Path.Combine(outputDir, "windows-observation.json"), Json.Serialize(report));
            }
        } catch (Exception error) { report["error"] = error.ToString(); status = 1; }
        finally { timeEndPeriod(1); File.WriteAllText(Path.Combine(outputDir, "windows-observation.json"), Json.Serialize(report)); }
        return status;
    }
}
