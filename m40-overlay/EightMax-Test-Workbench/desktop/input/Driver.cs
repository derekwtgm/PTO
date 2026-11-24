// EightMax Test Workbench 0.35.0 - EightMaxInput.exe, the Windows input driver.
//
// What it does: visible mouse and keyboard input into ONE kind of target - a window the operator registered and authorised
// (their own simulator or the bundled test table). Protocol: one JSON object per line on stdin/stdout, opened by
// {"cmd":"hello","token":...} with the token the parent put in EIGHTMAX_INPUT_TOKEN; nothing else is accepted before that.
// Input operations run one at a time on a worker thread (the desktop has one cursor); cancel / estop / status / release
// commands are handled immediately on the reader thread so they can interrupt a movement in progress.
//
// Safety: every operation names a registered target and is refused unless the window still has the same handle, process id,
// process start time and class, is not minimised, has the expected client rectangle, and the window under the point is the
// target itself. Movements re-check this while they run. The emergency hotkey (RegisterHotKey) and physical mouse/keyboard
// activity (Raw Input: injected input has no device handle) latch a stop; nothing resumes without an explicit command.
// Held buttons and keys are always released (finally blocks, emergency stop, shutdown, parent exit, stdin closing).
// Not here: hooks, process-memory access, hidden input, anti-detection, randomised "human" behaviour, launching programs.
//
// 0.36.2 Milestone 4.0 (requested per command; without the new fields every command behaves exactly as in Milestone 3.2):
//   clickGuard "process"  the double-click spacing (system double-click time + 40 ms) applies between clicks into the same target
//                         PROCESS. Windows pairs two clicks into a double-click only inside one input queue (one GUI thread, same
//                         window, same spot); a click into another process's window can never pair with it. Default "global": any
//                         two clicks, as before.
//   drain true            after the button is released, wait until Windows has processed the release (async button state up) and the
//                         target window's GUI thread has pumped its messages twice (SendMessageTimeout WM_NULL): the click has then been
//                         processed by the window before the driver replies and before any other window can be raised. A drain that is
//                         not confirmed (window busy or hung, 250 ms per round trip) is reported (drained:false) and makes the NEXT click
//                         into any process wait the full global spacing, as in Milestone 3.2.
//   raiseWait "poll"      after raising a covered target window, wait until it is on top at the click point (5-100 ms) instead of 30 ms
//   phases                every move / click reply carries the operation's phase times (queue, checks, movement, pre-click wait, raise,
//                         double-click guard, hold, drain) for performance measurement.
//   window-info, cursor and monitors are read-only: they are answered on the reader thread, so an identity probe of one table no
//   longer waits behind another table's click (field queued:true keeps the old queued behaviour).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

[assembly: System.Reflection.AssemblyTitle("EightMax Workbench input driver")]
[assembly: System.Reflection.AssemblyProduct("EightMax Test Workbench")]
[assembly: System.Reflection.AssemblyVersion("0.36.2.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.36.2.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.36.2-dev")]
namespace EightMax.Input {
public sealed class DriverError : Exception { public readonly string Code; public DriverError(string code, string message) : base(message) { Code = code; } }

public static class Json {
    public static readonly CultureInfo C = CultureInfo.InvariantCulture;
    public static Dictionary<string, object> Obj(object o) { Dictionary<string, object> d = o as Dictionary<string, object>; if (d == null) throw new DriverError("bad-request", "Expected a JSON object."); return d; }
    public static object Get(Dictionary<string, object> d, string k) { object v; return d != null && d.TryGetValue(k, out v) ? v : null; }
    public static double Num(Dictionary<string, object> d, string k, double def, double lo, double hi) {
        object v = Get(d, k); if (v == null) return def;
        if (!(v is int || v is long || v is decimal || v is double)) throw new DriverError("bad-request", k + " must be a number.");
        double x = Convert.ToDouble(v, C); if (Double.IsNaN(x) || x < lo || x > hi) throw new DriverError("bad-request", k + " must be between " + lo + " and " + hi + "."); return x;
    }
    public static int Int(Dictionary<string, object> d, string k, int def, int lo, int hi) { double x = Num(d, k, def, lo, hi); if (Math.Floor(x) != x) throw new DriverError("bad-request", k + " must be an integer."); return (int)x; }
    public static string Str(Dictionary<string, object> d, string k, int max) { string s = Get(d, k) as string; if (s == null || s.Length > max) throw new DriverError("bad-request", k + " must be text of at most " + max + " characters."); return s; }
    public static Rect Box(object o) { Dictionary<string, object> d = Obj(o); return new Rect(Int(d, "x", 0, -100000, 100000), Int(d, "y", 0, -100000, 100000), Int(d, "w", 0, 0, 100000), Int(d, "h", 0, 0, 100000)); }
    public static Dictionary<string, object> Box(Rect r) { Dictionary<string, object> d = new Dictionary<string, object>(); d["x"] = r.X; d["y"] = r.Y; d["w"] = r.W; d["h"] = r.H; return d; }
    public static long Handle(object o) {
        string s = o as string; if (s != null) { if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return Convert.ToInt64(s.Substring(2), 16); return Convert.ToInt64(s, C); }
        if (o is int || o is long) return Convert.ToInt64(o); throw new DriverError("bad-request", "Window handle must be text like 0x1A2B.");
    }
    public static string Hex(long h) { return "0x" + h.ToString("X", C); }
}

public sealed class Target {
    public long Hwnd; public int Pid; public long ProcessStart; public string ClassName = ""; public string Exe = ""; public string ExeSha256 = ""; public string Label = "";
    public DateTime Expires = DateTime.MaxValue;
}

public sealed class Op {
    public long Id; public long Deadline; public string Cmd = ""; public Dictionary<string, object> Args; public long Enqueued; public volatile bool Cancelled; public string CancelReason = "";
    // 0.36.2 M4.0: phase times of the operation (milliseconds from its start on the worker), reported as reply "phases"
    public Stopwatch Sw; public Dictionary<string, object> Marks;
    public void Mark(string k) { if (Sw != null) { if (Marks == null) Marks = new Dictionary<string, object>(); Marks[k] = Math.Round(Sw.Elapsed.TotalMilliseconds, 2); } }
    public void Add(string k, double ms) { if (Sw != null) { if (Marks == null) Marks = new Dictionary<string, object>(); object v; double prev = Marks.TryGetValue(k, out v) ? Convert.ToDouble(v, CultureInfo.InvariantCulture) : 0; Marks[k] = Math.Round(prev + ms, 2); } }
}

public sealed class Driver {
    public const string Version = "0.36.2-dev";
    public const string Build = "0.36.2-m40";   // 0.36.2 M4.0: per-process click guard, input drain, phase timings, read-only queries on the reader thread
    readonly IPlatform os; readonly string token; readonly TextWriter output; readonly object outGate = new object();
    readonly JavaScriptSerializer js = new JavaScriptSerializer { MaxJsonLength = 8 * 1024 * 1024, RecursionLimit = 32 };
    readonly Dictionary<long, Target> targets = new Dictionary<long, Target>();
    readonly Queue<Op> queue = new Queue<Op>(); readonly object qGate = new object(); const int MaxQueue = 8;
    volatile Op current; volatile bool authenticated, stopping;
    // Latched safety states. estop: emergency stop (hotkey or command); yielded: a person used the mouse/keyboard; manual: operator chose manual control.
    volatile string estop, yielded; volatile bool manual, armed; long armedAt;
    readonly HashSet<char> heldUnicode = new HashSet<char>();
    readonly HashSet<ushort> heldKeys = new HashSet<ushort>(); readonly bool[] heldButtons = new bool[2];
    int lastX = int.MinValue, lastY = int.MinValue; long lastClickAt; int lastClickX, lastClickY;
    int cmdX = int.MinValue, cmdY = int.MinValue;   // 0.36.2 M3: the last point the driver itself moved the cursor to
    // 0.36.2 M4.0: the last click into each target process (per-process double-click guard) and the time of the last click whose
    // processing the target window did not confirm (the next click into ANY process then keeps the global spacing)
    readonly Dictionary<int, long> lastClickByPid = new Dictionary<int, long>(); long undrainedAt;
    public string HotkeySpec = "Ctrl+Alt+F12"; public volatile bool HotkeyRegistered; public volatile bool RawInputActive; public string SafetyNote = "";
    public int OverrideGraceMs = 1500, OverrideTolerancePx = 6;
    readonly Stats stats = new Stats();
    CursorMonitor monitor;
    sealed class Stats { public long Ops, Moves, Clicks, Keys, Chars, Refused, Cancelled, Errors, Corrections, MaxCorrection, DoubleClickGuards, MisdirectedPresses; }

    public Driver(IPlatform platform, string token, TextWriter output) { os = platform; this.token = token; this.output = output; }
    public IPlatform Platform { get { return os; } }

    /* ---------------- output ---------------- */
    public void Send(Dictionary<string, object> m) { string line; lock (js) line = js.Serialize(m); lock (outGate) { output.Write(line); output.Write('\n'); output.Flush(); } }
    Dictionary<string, object> Reply(long id, bool ok) { Dictionary<string, object> r = new Dictionary<string, object>(); r["id"] = id; r["ok"] = ok; return r; }
    void Fail(long id, string code, string message) { Dictionary<string, object> r = Reply(id, false); r["code"] = code; r["error"] = message; Send(r); }
    public void Event(string kind, string detail) { Dictionary<string, object> e = new Dictionary<string, object>(); e["event"] = kind; e["detail"] = detail; e["t"] = os.Ticks(); Send(e); }

    /* ---------------- safety latches (callable from any thread) ---------------- */
    public void EmergencyStop(string why) {
        if (estop == null) estop = why; Op c = current; if (c != null) { c.Cancelled = true; c.CancelReason = "emergency stop"; }
        lock (qGate) { while (queue.Count > 0) { Op q = queue.Dequeue(); Fail(q.Id, "emergency-stop", "Emergency stop: " + why); } }
        ReleaseAll(); armed = false; Event("estop", why);
    }
    public void PhysicalInput(string what) {
        if (!armed || yielded != null || estop != null) return; if (os.Ticks() - armedAt < OverrideGraceMs) return;
        yielded = what; Op c = current; if (c != null) { c.Cancelled = true; c.CancelReason = "manual override"; }
        lock (qGate) { while (queue.Count > 0) { Op q = queue.Dequeue(); Fail(q.Id, "manual-override", "You used the mouse or keyboard; automation yielded."); } }
        ReleaseAll(); Event("override", what);
    }
    public void ReleaseAll() {
        lock (heldKeys) {
            for (int b = 0; b < 2; b++) if (heldButtons[b]) { try { os.Button(b, false); } catch (Exception) { } heldButtons[b] = false; }
            foreach (ushort k in new List<ushort>(heldKeys)) { try { os.Key(k, false); } catch (Exception) { } }
            heldKeys.Clear();
            foreach(char c in new List<char>(heldUnicode)){try{os.Unicode(c,false);}catch{}}heldUnicode.Clear();
            // Modifiers the driver might have pressed are released even when not recorded (e.g. after an exception between press and record).
            foreach (ushort m in new ushort[] { 0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5 }) if (os.IsKeyDown(m) && WePressedModifiers) { try { os.Key(m, false); } catch (Exception) { } }
            WePressedModifiers = false;
        }
    }
    bool WePressedModifiers;
    void Down(int b) { lock (heldKeys) {
        if (estop != null || yielded != null || manual || !armed || (current != null && current.Cancelled)) throw new DriverError("cancelled", "Input was cancelled before button-down.");
        heldButtons[b] = true; os.Button(b, true);
    } }
    void Up(int b) { try { os.Button(b, false); } finally { lock (heldKeys) heldButtons[b] = false; } }
    void KeyDown(ushort vk) { lock (heldKeys) {
        if (estop != null || yielded != null || manual || !armed || (current != null && current.Cancelled)) throw new DriverError("cancelled", "Input was cancelled before key-down.");
        heldKeys.Add(vk); if (vk >= 0x10 && vk <= 0x12 || vk >= 0xA0 && vk <= 0xA5) WePressedModifiers = true; os.Key(vk, true);
    } }
    void KeyUp(ushort vk) { try { os.Key(vk, false); } finally { lock (heldKeys) heldKeys.Remove(vk); } }

    /* ---------------- reader ---------------- */
    public void Run(TextReader input) {
        Thread worker = new Thread(WorkLoop) { IsBackground = true, Name = "input-worker" }; worker.Start();
        try {
            string line;
            while (!stopping && (line = input.ReadLine()) != null) { if (line.Length == 0) continue; if (line.Length > 1000000) { Fail(0, "too-large", "Request line exceeds 1 MB."); continue; } Handle(line); }
        } finally { stopping = true; ReleaseAll(); lock (qGate) Monitor.PulseAll(qGate); if (monitor != null) monitor.Stop(); }
    }
    void Handle(string line) {
        Dictionary<string, object> m; long id = 0;
        try { lock (js) m = Json.Obj(js.DeserializeObject(line)); } catch (Exception) { Fail(0, "bad-json", "Request is not a JSON object."); return; }
        try {
            object idv = Json.Get(m, "id"); if (idv != null) id = Convert.ToInt64(idv, Json.C);
            string cmd = Json.Get(m, "cmd") as string ?? "";
            if (!authenticated) {
                if (cmd != "hello") { Fail(id, "not-authenticated", "Send hello with the session token first."); return; }
                string t = Json.Get(m, "token") as string; if (token == null || t == null || !SecureEquals(t, token)) { Fail(id, "bad-token", "Wrong session token."); stopping = true; return; }
                authenticated = true; Dictionary<string, object> r = Reply(id, true); r["driver"] = Version; r["platform"] = os.Name; r["capabilities"] = Capabilities(); Send(r); return;
            }
            switch (cmd) {
                case "health": case "status": Send(Status(id)); return;
                case "cancel": { long op = Convert.ToInt64(Json.Get(m, "op"), Json.C); bool hit = false; Op c = current; if (c != null && c.Id == op) { c.Cancelled = true; c.CancelReason = "cancelled"; hit = true; }
                    lock (qGate) { Queue<Op> keep = new Queue<Op>(); while (queue.Count > 0) { Op q = queue.Dequeue(); if (q.Id == op) { hit = true; Fail(q.Id, "cancelled", "Cancelled before it started."); } else keep.Enqueue(q); } while (keep.Count > 0) queue.Enqueue(keep.Dequeue()); }
                    Dictionary<string, object> r = Reply(id, true); r["found"] = hit; Send(r); return; }
                case "cancel-all": { Op c = current; if (c != null) { c.Cancelled = true; c.CancelReason = "cancelled"; } int n = 0; lock (qGate) { while (queue.Count > 0) { n++; Fail(queue.Dequeue().Id, "cancelled", "Cancelled before it started."); } } Dictionary<string, object> r = Reply(id, true); r["dropped"] = n; Send(r); return; }
                case "estop": EmergencyStop(Json.Get(m, "reason") as string ?? "operator"); Send(Status(id)); return;
                case "reset-estop": if (current != null) { Fail(id, "busy", "Wait for the cancelled operation to finish."); return; } estop = null; Send(Status(id)); return;
                case "arm": if (estop != null) { Fail(id, "emergency-stop", "Reset the emergency stop first."); return; } yielded = null; armed = true; armedAt = os.Ticks(); RememberCursor(); Send(Status(id)); return;
                case "disarm": armed = false; { Op c = current; if (c != null) { c.Cancelled = true; c.CancelReason = "automation disabled"; } } Send(Status(id)); return;
                case "resume": if (estop != null) { Fail(id, "emergency-stop", "Reset the emergency stop first."); return; } yielded = null; armedAt = os.Ticks(); RememberCursor(); Send(Status(id)); return;
                case "manual-mode": manual = Json.Get(m, "on") is bool && (bool)Json.Get(m, "on"); if (manual) { Op c = current; if (c != null) { c.Cancelled = true; c.CancelReason = "manual control mode"; } ReleaseAll(); } Send(Status(id)); return;
                case "release-all": ReleaseAll(); Send(Status(id)); return;
                case "monitor-start": { if (monitor != null) monitor.Stop(); monitor = new CursorMonitor(os, Json.Int(m, "intervalMs", 2, 1, 50), Json.Int(m, "maxSamples", 200000, 100, 2000000)); monitor.Start(); Send(Reply(id, true)); return; }
                case "monitor-stop": { Dictionary<string, object> r = Reply(id, true); if (monitor != null) { monitor.Stop(); r["samples"] = monitor.Samples(); r["buttonDownSamples"] = monitor.ButtonDown; monitor = null; } else r["samples"] = new object[0]; Send(r); return; }
                case "shutdown": stopping = true; ReleaseAll(); Send(Reply(id, true)); return;
                case "virtual-user-move": { VirtualPlatform v = os as VirtualPlatform; if (v == null) { Fail(id, "unsupported", "Only the virtual test desktop accepts simulated user input."); return; } v.UserMove(Json.Int(m, "x", 0, -100000, 100000), Json.Int(m, "y", 0, -100000, 100000)); PhysicalInput("simulated person moved the mouse"); Send(Reply(id, true)); return; }
                case "virtual-hotkey": { if (!(os is VirtualPlatform)) { Fail(id, "unsupported", "Only the virtual test desktop simulates the hotkey."); return; } EmergencyStop("hotkey " + HotkeySpec + " (simulated)"); Send(Reply(id, true)); return; }
                case "virtual-events": { VirtualPlatform v = os as VirtualPlatform; if (v == null) { Fail(id, "unsupported", "virtual only"); return; } Dictionary<string, object> r = Reply(id, true); lock (v) r["events"] = v.Events.ToArray(); Send(r); return; }
            }
            Op o = new Op { Id = id, Cmd = cmd, Args = m, Enqueued = os.Ticks() };
            if (!IsOperation(cmd)) { Fail(id, "unknown-command", "Unknown command " + cmd + "."); return; }
            // 0.36.2 M4.0: read-only queries are answered here, never behind another table's movement (queued:true = the old behaviour)
            if ((cmd == "window-info" || cmd == "cursor" || cmd == "monitors") && !(Json.Get(m, "queued") is bool && (bool)Json.Get(m, "queued"))) { Dictionary<string, object> qr = Execute(o); qr["inline"] = true; Interlocked.Increment(ref stats.Ops); Send(qr); return; }
            lock (qGate) { if (queue.Count >= MaxQueue) { stats.Refused++; Fail(id, "queue-full", "The input queue holds " + MaxQueue + " operations; wait for them to finish."); return; } queue.Enqueue(o); Monitor.Pulse(qGate); }
        } catch (DriverError e) { Fail(id, e.Code, e.Message); } catch (Exception e) { Fail(id, "internal-error", e.GetType().Name + ": " + e.Message); }
    }
    static bool SecureEquals(string a, string b) { if (a.Length != b.Length) return false; int d = 0; for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i]; return d == 0; }
    static readonly string[] Operations = { "cursor", "monitors", "list-windows", "window-info", "exe-identity", "register-target", "unregister-target", "focus", "move", "move-click", "click", "double-click", "mouse-down", "mouse-up", "key", "type", "clear-field", "read-text", "enter-text", "uia-controls", "wait" };
    static bool IsOperation(string c) { return Array.IndexOf(Operations, c) >= 0; }

    Dictionary<string, object> Capabilities() {
        Dictionary<string, object> c = new Dictionary<string, object>();
        c["signedCurves"] = true; c["maxDeviationPx"] = true; c["singleClickGuardMaxMs"] = os.DoubleClickMs() + 40; c["operations"] = Operations; c["sendInput"] = os.Name == "win32"; c["virtual"] = os.Name == "virtual"; c["uiAutomation"] = Uia.Available; c["rawInputOverride"] = RawInputActive;
        c["clickGuardScopes"] = new string[] { "global", "process" }; c["inputDrain"] = true; c["pressGuard"] = true; c["captureBarrier"] = true; c["raiseWaitModes"] = new string[] { "fixed-30", "poll" }; c["phaseTimings"] = true; c["inlineQueries"] = new string[] { "window-info", "cursor", "monitors" }; c["build"] = Build;
        c["hotkey"] = HotkeySpec; c["hotkeyRegistered"] = HotkeyRegistered; c["maxQueue"] = MaxQueue; c["dpiAwareness"] = Program.DpiAwareness; c["note"] = SafetyNote; return c;
    }
    Dictionary<string, object> Status(long id) {
        Dictionary<string, object> r = Reply(id, true); r["driver"] = Version; r["platform"] = os.Name; r["estop"] = estop; r["yielded"] = yielded; r["manual"] = manual; r["armed"] = armed;
        Op c = current; r["busy"] = c != null; r["currentOp"] = c == null ? null : (object)c.Id; lock (qGate) r["queued"] = queue.Count;
        lock (heldKeys) { r["heldButtons"] = heldButtons[0] || heldButtons[1]; r["heldKeys"] = heldKeys.Count; }
        r["targets"] = targets.Count; r["capabilities"] = Capabilities();
        Dictionary<string, object> s = new Dictionary<string, object>(); s["ops"] = stats.Ops; s["moves"] = stats.Moves; s["clicks"] = stats.Clicks; s["keys"] = stats.Keys; s["chars"] = stats.Chars; s["refused"] = stats.Refused; s["cancelled"] = stats.Cancelled; s["errors"] = stats.Errors; s["corrections"] = stats.Corrections; s["maxCorrectionPx"] = stats.MaxCorrection; s["doubleClickGuards"] = stats.DoubleClickGuards; s["misdirectedPresses"] = stats.MisdirectedPresses; r["stats"] = s;
        return r;
    }

    /* ---------------- worker ---------------- */
    void WorkLoop() {
        while (!stopping) {
            Op o; lock (qGate) { while (queue.Count == 0 && !stopping) Monitor.Wait(qGate, 500); if (stopping) return; o = queue.Dequeue(); current = o; }
            try {
                int maxWait = Json.Int(o.Args, "queueTimeoutMs", 10000, 0, 600000);
                if (os.Ticks() - o.Enqueued > maxWait) throw new DriverError("expired", "Waited " + (os.Ticks() - o.Enqueued) + " ms in the queue (limit " + maxWait + " ms); not executed.");
                object budget = Json.Get(o.Args, "mustFinishWithinMs"); if (budget != null) o.Deadline = o.Enqueued + (long)Json.Num(o.Args, "mustFinishWithinMs", 0, 0, 1e9);
                o.Sw = Stopwatch.StartNew(); Dictionary<string, object> r = Execute(o); Interlocked.Increment(ref stats.Ops);
                if (o.Marks != null) { o.Marks["queueMs"] = Math.Max(0, o.Sw == null ? 0 : (double)(os.Ticks() - o.Enqueued) - o.Sw.Elapsed.TotalMilliseconds); o.Marks["totalMs"] = Math.Round(o.Sw.Elapsed.TotalMilliseconds, 2); r["phases"] = o.Marks; }
                Send(r);
            } catch (DriverError e) { if (e.Code == "cancelled" || e.Code == "emergency-stop" || e.Code == "manual-override") stats.Cancelled++; else stats.Refused++; if (InputOp(o.Cmd) && e.Code != "manual-override" && e.Code != "emergency-stop") ResyncAfterOwnAbort(); Fail(o.Id, e.Code, e.Message); }
            catch (Exception e) { stats.Errors++; Fail(o.Id, "internal-error", e.GetType().Name + ": " + e.Message); }
            finally { ReleaseHeldAfterOp(); current = null; }
        }
    }
    void ReleaseHeldAfterOp() { lock (heldKeys) { if (!(heldButtons[0] || heldButtons[1] || heldKeys.Count > 0 || heldUnicode.Count > 0)) return; } if (current != null && (current.Cmd == "mouse-down")) return; ReleaseAll(); }

    void Gate(Op o) {
        if (o.Deadline > 0 && os.Ticks() >= o.Deadline) throw new DriverError("deadline", "Input deadline expired; stopped without retry.");
        if (estop != null) throw new DriverError("emergency-stop", "Emergency stop is latched (" + estop + "); reset it explicitly.");
        if (yielded != null) throw new DriverError("manual-override", "Automation yielded to manual input (" + yielded + "); resume explicitly.");
        if (manual) throw new DriverError("manual-mode", "Manual control mode is on.");
        if (o.Cancelled) throw new DriverError(o.CancelReason == "emergency stop" ? "emergency-stop" : o.CancelReason == "manual override" ? "manual-override" : "cancelled", "Operation " + o.CancelReason + ".");
    }
    bool InputOp(string cmd) { return cmd == "focus" || cmd == "move" || cmd == "move-click" || cmd == "click" || cmd == "double-click" || cmd == "mouse-down" || cmd == "mouse-up" || cmd == "key" || cmd == "type" || cmd == "clear-field" || cmd == "enter-text"; }

    Dictionary<string, object> Execute(Op o) {
        Dictionary<string, object> a = o.Args, r = Reply(o.Id, true);
        if (InputOp(o.Cmd)) { Gate(o); if (!armed) throw new DriverError("not-armed", "Automation is not enabled (send arm after the operator enables it)."); CheckCursorOwnership(); }
        switch (o.Cmd) {
            case "cursor": { int x, y; os.GetCursor(out x, out y); r["x"] = x; r["y"] = y; r["virtualScreen"] = Json.Box(os.VirtualScreen()); return r; }
            case "monitors": { List<object> l = new List<object>(); foreach (MonitorInfo m in os.Monitors()) { Dictionary<string, object> d = new Dictionary<string, object>(); d["id"] = m.Id; d["name"] = m.Name; d["bounds"] = Json.Box(m.Bounds); d["work"] = Json.Box(m.Work); d["dpiScale"] = m.DpiScale; d["primary"] = m.Primary; l.Add(d); } r["monitors"] = l; r["virtualScreen"] = Json.Box(os.VirtualScreen()); return r; }
            case "list-windows": { List<object> l = new List<object>(); foreach (WinInfo w in os.TopWindows()) l.Add(Describe(w)); r["windows"] = l; return r; }
            case "window-info": { WinInfo w = os.Window(Json.Handle(Json.Get(a, "hwnd"))); if (w == null) throw new DriverError("window-gone", "That window no longer exists."); r["window"] = Describe(w); return r; }
            case "exe-identity": { WinInfo w = os.Window(Json.Handle(Json.Get(a, "hwnd"))); if (w == null) throw new DriverError("window-gone", "That window no longer exists."); r["window"] = Describe(w); r["exeSha256"] = os.ExeSha256(w.Pid); return r; }
            case "register-target": return Register(a, r);
            case "unregister-target": { long h = Json.Handle(Json.Get(a, "hwnd")); lock (targets) targets.Remove(h); return r; }
            case "focus": { Target t = Check(a); Focus(t, true); r["foreground"] = Json.Hex(os.Foreground()); return r; }
            case "move": { Target t = Check(a); MoveTo(o, t, a, r); return r; }
            case "move-click": { Target t = Check(a); o.Mark("checkMs"); MoveTo(o, t, a, r); ClickAt(o, t, a, r, 1); return r; }
            case "click": { Target t = Check(a); o.Mark("checkMs"); ClickAt(o, t, a, r, 1); return r; }
            case "double-click": { Target t = Check(a); if (!(Json.Get(a, "authorized") is bool) || !(bool)Json.Get(a, "authorized")) throw new DriverError("double-click-not-authorized", "Double-click only when the control's profile says it needs one (authorized: true)."); ClickAt(o, t, a, r, 2); return r; }
            case "mouse-down": { Target t = Check(a); int x, y; os.GetCursor(out x, out y); GuardSingleClick(o, r, t); CheckCursorOwnership(); os.GetCursor(out x, out y); HitCheck(t, a, x, y); Down(Btn(a)); NoteInput(); stats.Clicks++; NoteClick(t); lastClickX = x; lastClickY = y; return r; }
            case "mouse-up": { Up(Btn(a)); NoteInput(); return r; }
            case "key": { Target t = Check(a); RequireForeground(t); PressKey(o, t, a); return r; }
            case "type": { Target t = Check(a); RequireForeground(t); TypeText(o, t, Json.Str(a, "text", 64), Json.Num(a, "keyIntervalMs", 45, 0, 2000), Json.Num(a, "keyHoldMs", 12, 0, 500)); return r; }
            case "clear-field": { Target t = Check(a); RequireForeground(t); long f = FocusedField(t, a); Clear(o, t, f, a); r["text"] = os.ControlText(f); return r; }
            case "read-text": { Target t = Check(a, false); long f = os.FocusedControl(t.Hwnd); Dictionary<string, object> p = Json.Get(a, "point") as Dictionary<string, object>; if (p != null) { long c = os.ChildAt(Json.Int(p, "x", 0, -100000, 100000), Json.Int(p, "y", 0, -100000, 100000)); if (c != 0 && c != t.Hwnd) f = c; }
                r["control"] = Json.Hex(f); r["class"] = os.ControlClass(f); r["text"] = f == 0 ? null : os.ControlText(f); r["focused"] = f != 0 && f == os.FocusedControl(t.Hwnd); r["uia"] = Uia.Available ? Uia.FocusedValue() : null; return r; }
            case "enter-text": return EnterText(o, a, r);
            case "uia-controls": { Target t = Check(a, false); r["controls"] = Uia.Available ? Uia.Controls(t.Hwnd) : new List<object>(); r["available"] = Uia.Available; return r; }
            case "wait": { double ms = Json.Num(a, "ms", 0, 0, 10000); Sleep(o, ms); return r; }
        }
        throw new DriverError("unknown-command", "Unknown command.");
    }
    static int Btn(Dictionary<string, object> a) { string b = Json.Get(a, "button") as string; if (b == null || b == "left") return 0; if (b == "right") return 1; throw new DriverError("bad-request", "button must be left or right."); }

    Dictionary<string, object> Describe(WinInfo w) {
        Dictionary<string, object> d = new Dictionary<string, object>(); d["hwnd"] = Json.Hex(w.Hwnd); d["pid"] = w.Pid; d["processStart"] = w.ProcessStart.ToString(Json.C); d["title"] = w.Title; d["className"] = w.ClassName; d["exe"] = w.Exe;
        d["window"] = Json.Box(w.Window); d["client"] = Json.Box(w.Client); d["dpiScale"] = w.DpiScale; d["minimized"] = w.Minimized; d["visible"] = w.Visible; d["cloaked"] = w.Cloaked; d["foreground"] = w.Foreground; d["enabled"] = w.Enabled; d["monitor"] = w.Monitor;
        lock (targets) d["registered"] = targets.ContainsKey(w.Hwnd); return d;
    }

    /* ---------------- authorisation of targets ---------------- */
    Dictionary<string, object> Register(Dictionary<string, object> a, Dictionary<string, object> r) {
        Dictionary<string, object> auth = Json.Obj(Json.Get(a, "authorization"));
        if ((Json.Get(auth, "format") as string) != "eightmax-simulator-authorization" || Convert.ToInt32(Json.Get(auth, "version") ?? 0) != 1) throw new DriverError("authorization-refused", "Needs an eightmax-simulator-authorization v1 record.");
        foreach (string k in new[] { "operatorOwnsSimulator", "testEnvironmentOnly", "noRealMoney" }) if (!(Json.Get(auth, k) is bool) || !(bool)Json.Get(auth, k)) throw new DriverError("authorization-refused", "The authorization must state " + k + ": true.");
        double expires = Json.Num(auth, "expiresAtUnixMs", 0, 0, 1e15), now = (DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds;
        if (expires <= now) throw new DriverError("authorization-refused", "The authorization has expired."); if (expires - now > 8 * 3600e3 + 60e3) throw new DriverError("authorization-refused", "An authorization may last at most 8 hours.");
        Dictionary<string, object> exe = Json.Obj(Json.Get(auth, "executable")); string name = Json.Str(exe, "fileName", 260), sha = Json.Str(exe, "sha256", 64).ToLowerInvariant();
        long hwnd = Json.Handle(Json.Get(a, "hwnd")); WinInfo w = os.Window(hwnd); if (w == null) throw new DriverError("window-gone", "That window no longer exists.");
        if (!String.Equals(Path.GetFileName(w.Exe), name, StringComparison.OrdinalIgnoreCase)) throw new DriverError("authorization-refused", "The window belongs to " + Path.GetFileName(w.Exe) + ", not the authorised " + name + ".");
        string actual = os.ExeSha256(w.Pid); if (actual == null || actual != sha) throw new DriverError("authorization-refused", "The program's SHA-256 (" + (actual ?? "unreadable") + ") differs from the authorised executable.");
        Target t = new Target { Hwnd = hwnd, Pid = w.Pid, ProcessStart = w.ProcessStart, ClassName = w.ClassName, Exe = w.Exe, ExeSha256 = sha, Label = Json.Get(a, "label") as string ?? "", Expires = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(expires) };
        lock (targets) { if (targets.Count >= 16 && !targets.ContainsKey(hwnd)) throw new DriverError("too-many-targets", "At most 16 windows can be registered."); targets[hwnd] = t; }
        r["window"] = Describe(w); r["exeSha256"] = sha; return r;
    }
    /// <summary>The window named by the request must be registered and still be the same window.</summary>
    Target Check(Dictionary<string, object> a) { return Check(a, true); }
    Target Check(Dictionary<string, object> a, bool forInput) {
        long h = Json.Handle(Json.Get(a, "hwnd")); Target t; lock (targets) targets.TryGetValue(h, out t);
        if (t == null) throw new DriverError("target-not-registered", "Input goes only to a registered, authorised simulator window.");
        if (DateTime.UtcNow > t.Expires) throw new DriverError("authorization-expired", "The authorization for this window expired.");
        WinInfo w = Identity(t); if (forInput && w.Minimized) throw new DriverError("window-minimized", "The simulator window is minimised.");
        if (forInput && (!w.Visible || w.Cloaked)) throw new DriverError("window-hidden", "The simulator window is hidden or on another virtual desktop.");
        Dictionary<string, object> exp = Json.Get(a, "expectClient") as Dictionary<string, object>;
        if (exp != null && !Json.Box(exp).Same(w.Client)) throw new DriverError("layout-changed", "The window moved or was resized (client " + w.Client + ", expected " + Json.Box(exp) + "); take a new screenshot first.");
        return t;
    }
    WinInfo Identity(Target t) {
        WinInfo w = os.Window(t.Hwnd); if (w == null) { lock (targets) targets.Remove(t.Hwnd); throw new DriverError("window-gone", "The simulator window was closed."); }
        if (w.Pid != t.Pid || w.ProcessStart != t.ProcessStart || w.ClassName != t.ClassName) throw new DriverError("identity-changed", "The window handle now belongs to a different window or process.");
        return w;
    }
    void RequireForeground(Target t) { if (os.Foreground() != t.Hwnd) throw new DriverError("focus-lost", "The simulator window is not in the foreground; keyboard input refused."); }
    void Focus(Target t, bool force) {
        if (os.Foreground() == t.Hwnd) return; if (!force) throw new DriverError("focus-lost", "The simulator window is not in the foreground.");
        if (!os.SetForeground(t.Hwnd)) throw new DriverError("focus-denied", "Windows did not let the driver bring the simulator window to the front.");
    }
    /// <summary>The visible window under (x,y) must be the target itself, otherwise the click would land on another program.</summary>
    void HitCheck(Target t, Dictionary<string, object> a, int x, int y) {
        Dictionary<string, object> reg = Json.Get(a, "region") as Dictionary<string, object>;
        if (reg != null && !Json.Box(reg).Contains(x, y)) throw new DriverError("outside-region", "The cursor (" + x + "," + y + ") is not inside the validated control region " + Json.Box(reg) + ".");
        WinInfo w = Identity(t); if (!w.Client.Contains(x, y)) throw new DriverError("outside-window", "The point is outside the simulator's client area.");
        long root = os.RootAt(x, y);
        if (root != t.Hwnd) {
            string policy = Json.Get(a, "focusPolicy") as string ?? "bring-to-front";
            if (policy == "bring-to-front") {
                Focus(t, true);
                // 0.36.2 M4.0 raiseWait "poll": wait until the raised window is really on top at the point (at least 5 ms, at most 100 ms)
                // instead of a fixed 30 ms and one look; without the field: the Milestone 3.2 fixed wait
                if ((Json.Get(a, "raiseWait") as string) == "poll") { Stopwatch rw = Stopwatch.StartNew(); Thread.Sleep(5); root = os.RootAt(x, y); while (root != t.Hwnd && rw.ElapsedMilliseconds < 100) { Thread.Sleep(2); root = os.RootAt(x, y); } }
                else { Thread.Sleep(30); root = os.RootAt(x, y); }
            }
            if (root != t.Hwnd) throw new DriverError("target-covered", "Another window (" + Json.Hex(root) + ") covers the control.");
        }
    }

    /* ---------------- cursor ownership / manual override between operations ---------------- */
    void RememberCursor() { int x, y; os.GetCursor(out x, out y); lastX = x; lastY = y; }
    void NoteInput() { RememberCursor(); }
    // 0.36.2 M3: an operation of the driver's own that stopped part-way (window closed or moved, cancelled, deadline) left the cursor
    // at the driver's last commanded point, but the remembered position was not updated, so the NEXT operation - for any table -
    // reported "the cursor was moved by someone else" (Windows CI run 45203097931, two-table stability run). The remembered position
    // follows the driver's own last point only if the cursor is still exactly there (2 px): a person's movement is still detected.
    void ResyncAfterOwnAbort() { if (cmdX == int.MinValue) return; int x, y; os.GetCursor(out x, out y); if (Math.Abs(x - cmdX) <= 2 && Math.Abs(y - cmdY) <= 2) { lastX = x; lastY = y; } }
    void CheckCursorOwnership() {
        if (lastX == int.MinValue) { RememberCursor(); return; }
        int x, y; os.GetCursor(out x, out y);
        if (Math.Abs(x - lastX) > OverrideTolerancePx || Math.Abs(y - lastY) > OverrideTolerancePx) {
            if (armed && os.Ticks() - armedAt >= OverrideGraceMs) { PhysicalInput("cursor moved from " + lastX + "," + lastY + " to " + x + "," + y + " between operations"); throw new DriverError("manual-override", "The cursor was moved by someone else; automation yielded."); }
            RememberCursor();
        }
    }
    void Sleep(Op o, double ms) { long end = os.Ticks() + (long)Math.Ceiling(ms); while (true) { Gate(o); long left = end - os.Ticks(); if (left <= 0) return; Thread.Sleep((int)Math.Min(left, 10)); } }

    /* ---------------- movement ---------------- */
    void MoveTo(Op o, Target t, Dictionary<string, object> a, Dictionary<string, object> r) {
        Dictionary<string, object> to = Json.Obj(Json.Get(a, "to")); int tx = Json.Int(to, "x", 0, -100000, 100000), ty = Json.Int(to, "y", 0, -100000, 100000);
        MotionProfile p = MotionProfile.From(Json.Get(a, "motion") as Dictionary<string, object>);
        WinInfo w0 = Identity(t); if (!w0.Client.Contains(tx, ty)) throw new DriverError("outside-window", "The destination is outside the simulator's client area.");
        Dictionary<string, object> reg = Json.Get(a, "region") as Dictionary<string, object>; if (reg != null && !Json.Box(reg).Contains(tx, ty)) throw new DriverError("outside-region", "The destination is not inside the validated control region.");
        int x0, y0; os.GetCursor(out x0, out y0); double dist = Math.Sqrt((double)(tx - x0) * (tx - x0) + (double)(ty - y0) * (ty - y0));
        p.Arc = Motion.EffectiveArc(dist, p);
        // Check the whole quadratic path, including coordinate extrema, before sending any input.
        Rect desktop = os.VirtualScreen(); double dx = tx - x0, dy = ty - y0;
        List<double> extrema = new List<double> { 0, 1 };
        double bx = -4 * dy * p.Arc, by = 4 * dx * p.Arc;
        if (bx != 0) extrema.Add((dx + bx) / (2 * bx));
        if (by != 0) extrema.Add((dy + by) / (2 * by));
        foreach (double u in extrema) if (u >= 0 && u <= 1) {
            double ex = x0 + dx * u + bx * u * (1 - u), ey = y0 + dy * u + by * u * (1 - u);
            if (ex < desktop.X || ey < desktop.Y || ex > desktop.X + desktop.W - 1 || ey > desktop.Y + desktop.H - 1) throw new DriverError("path-outside-desktop", "Curve leaves the virtual desktop; reduce curvature or deviation.");
        }
        r["arc"] = p.Arc; r["maxDeviationPx"] = p.MaxDeviationPx;
        double dur = Motion.DurationMs(dist, p); int steps = Motion.Steps(dur, p);
        if (dur > p.MaxDurationMs) throw new DriverError("move-too-long", "The movement would take " + Math.Round(dur) + " ms (limit " + p.MaxDurationMs + " ms) at the configured speed; it is not sped up.");
        double deadline = Json.Num(a, "mustFinishWithinMs", 1e9, 0, 1e9);
        if (dur > deadline) throw new DriverError("deadline", "The movement needs " + Math.Round(dur) + " ms but only " + Math.Round(deadline) + " ms remain; refused instead of moving faster.");
        List<object> samples = new List<object>(); Rect client0 = w0.Client; long t0 = os.Ticks(); o.Mark("moveStartMs"); Stopwatch sw = Stopwatch.StartNew(); double lastStepMs = 0; int px = x0, py = y0, maxDev = 0;
        for (int k = 1; k <= steps; k++) {
            double due = Math.Max(dur * k / steps, lastStepMs + dur / steps); double wait = due - sw.Elapsed.TotalMilliseconds;
            while (wait > 0) { Gate(o); Thread.Sleep(wait > 3 ? (int)(wait - 2) : 0); wait = due - sw.Elapsed.TotalMilliseconds; }
            Gate(o);
            // Someone else moved the cursor since the last step? (Raw Input catches it first when available.)
            int cx, cy; os.GetCursor(out cx, out cy); int dev = Math.Max(Math.Abs(cx - px), Math.Abs(cy - py)); if (dev > maxDev) maxDev = dev;
            if (dev > OverrideTolerancePx && k > 1) { Event("cursor-diagnostic", "step=" + k + " expected=" + px + "," + py + " observed=" + cx + "," + cy + " deviation=" + dev + " elapsedMs=" + sw.ElapsedMilliseconds + " dpiScale=" + w0.DpiScale + " rawInput=" + RawInputActive); PhysicalInput("cursor ownership lost during a movement; inspect cursor-diagnostic"); throw new DriverError("manual-override", "The cursor was moved by someone else during the movement."); }
            if ((k & 3) == 0 || k == steps) { WinInfo w = Identity(t); if (!w.Client.Same(client0)) throw new DriverError("layout-changed", "The simulator window moved or was resized during the movement; stopped."); if (w.Minimized) throw new DriverError("window-minimized", "The window was minimised during the movement."); }
            PathPoint q = Motion.At(x0, y0, tx, ty, (double)k / steps, p.Arc); int nx = (int)Math.Round(q.X), ny = (int)Math.Round(q.Y); if (k == steps) { nx = tx; ny = ty; }
            lock(heldKeys) { Gate(o); os.MoveAbsolute(nx, ny); cmdX = nx; cmdY = ny; } lastStepMs=sw.Elapsed.TotalMilliseconds;
            // SendInput queues movement; wait for acknowledgement, without resending or relaxing raw-input override.
            long ackAt = os.Ticks(); int ax, ay;
            do { Gate(o); os.GetCursor(out ax, out ay); if (Math.Abs(ax - nx) <= 2 && Math.Abs(ay - ny) <= 2) break;
                if (os.Ticks() - ackAt >= 50) { Event("cursor-diagnostic", "unacknowledged step=" + k + " commanded=" + nx + "," + ny + " observed=" + ax + "," + ay + " dpiScale=" + w0.DpiScale); throw new DriverError("cursor-unacknowledged", "Cursor did not acknowledge movement within 50 ms; stopped without retry."); }
                Thread.Sleep(1);
            } while (true);
            px = nx; py = ny; stats.Moves++;
            if (samples.Count < 2000) { Dictionary<string, object> s = new Dictionary<string, object>(); s["t"] = Math.Round(sw.Elapsed.TotalMilliseconds, 2); s["x"] = nx; s["y"] = ny; samples.Add(s); }
        }
        // Final position check; a mapping rounding error of at most 2 px is corrected, anything larger is an error.
        int fx, fy; Sleep(o,2); os.GetCursor(out fx, out fy); int err = Math.Max(Math.Abs(fx - tx), Math.Abs(fy - ty));
        if (err > 0) { if (err > 2) throw new DriverError("target-miss", "The cursor ended at " + fx + "," + fy + " instead of " + tx + "," + ty + "."); lock(heldKeys) { Gate(o); os.SetCursor(tx, ty); cmdX = tx; cmdY = ty; } stats.Corrections++; if (err > stats.MaxCorrection) stats.MaxCorrection = err; }
        RememberCursor(); o.Mark("moveEndMs");
        r["from"] = Pt(x0, y0); r["to"] = Pt(tx, ty); r["distance"] = Math.Round(dist, 2); r["plannedMs"] = Math.Round(dur, 2); r["actualMs"] = Math.Round(sw.Elapsed.TotalMilliseconds, 2); r["steps"] = steps; r["samples"] = samples; r["finalError"] = err; r["maxObservedLag"] = maxDev; r["startedAt"] = t0;
    }
    static Dictionary<string, object> Pt(int x, int y) { Dictionary<string, object> d = new Dictionary<string, object>(); d["x"] = x; d["y"] = y; return d; }

    void GuardSingleClick(Op o, Dictionary<string, object> r, Target t) {
        // A global spacing guard cannot lose an earlier click when windows/controls move or interleave.
        // Measured from release for ordinary clicks, conservatively from press for explicit mouse-down.
        // 0.36.2 M4.0: clickGuard "process" measures from the last click into the same target process - or from the last click whose
        // processing was not confirmed (drain), whichever is later; anything else keeps the global guard.
        bool perProcess = (Json.Get(o.Args, "clickGuard") as string) == "process" && t != null;
        long last = lastClickAt; if (perProcess) { long lp; lock (lastClickByPid) { if (!lastClickByPid.TryGetValue(t.Pid, out lp)) lp = 0; } last = Math.Max(lp, undrainedAt); }
        long limit = os.DoubleClickMs() + 40, since = last <= 0 ? -1 : os.Ticks() - last, wait = last <= 0 ? 0 : limit - since; r["guardScope"] = perProcess ? "process" : "global";
        r["guardLimitMs"] = limit; if (since >= 0) r["guardSinceMs"] = since;   // 0.36.2 M4.0: why the click did or did not wait (diagnostics)
        if (wait > 0) { r["doubleClickGuardMs"] = wait; stats.DoubleClickGuards++; Stopwatch g = Stopwatch.StartNew(); Sleep(o, wait); o.Add("guardMs", g.Elapsed.TotalMilliseconds); } else o.Add("guardMs", 0);
    }
    /// <summary>
    /// 0.36.2 M4.0 press guard (field "pressGuard": true): once Windows has processed the press (async button state down, at most 30 ms),
    /// the target must still be the top-level window under the cursor. A window that closed (or was covered) between the last check and
    /// the press makes Windows deliver the press to the window beneath (Windows CI run 45401450070: a window closed by the test 12 ms before
    /// a click meant for it; the press reached another table). The press cannot be taken back, but its CLICK can be prevented: a button
    /// clicks only when the release is over the control that received the press, so the pointer is moved just outside that control before
    /// the release. Reported as press-misdirected (never repeated; the workbench treats it as an input that may have happened).
    /// The reply carries press {seen, seenMs, root, child} for every guarded press.
    /// </summary>
    void PressGuard(Op o, Target t, Dictionary<string, object> r, int b, int x, int y, ref bool released) {
        Stopwatch ps = Stopwatch.StartNew(); ushort vk = (ushort)(b == 1 ? 2 : 1); bool seen = os.IsKeyDown(vk);
        while (!seen && ps.ElapsedMilliseconds < 30) { Thread.Sleep(1); seen = os.IsKeyDown(vk); }
        long root = os.RootAt(x, y), child = os.ChildAt(x, y);
        Dictionary<string, object> p = new Dictionary<string, object>(); p["seen"] = seen; p["seenMs"] = Math.Round(ps.Elapsed.TotalMilliseconds, 2); p["root"] = Json.Hex(root); p["child"] = Json.Hex(child); r["press"] = p;
        o.Add("pressCheckMs", ps.Elapsed.TotalMilliseconds);
        if (root == t.Hwnd) {
            return;
        }
        int ax = x, ay = y; Rect box;
        if (child != 0 && child != root && os.ControlBox(child, out box) && box.W > 0 && box.H > 0) {
            Rect vs = os.VirtualScreen(); ay = box.Y - 4; if (ay < vs.Y) ay = box.Y + box.H + 4;   // just above (or below) the control that received the press
            os.MoveAbsolute(ax, ay);
        }
        Up(b); released = true; stats.MisdirectedPresses++;
        p["misdirected"] = true; p["releasedAt"] = Pt(ax, ay);
        Event("press-misdirected", "target=" + Json.Hex(t.Hwnd) + " reached=" + Json.Hex(root) + " control=" + Json.Hex(child) + " released=" + ax + "," + ay + " op=" + o.Id);
        throw new DriverError("press-misdirected", "The target window was no longer under the cursor when the button went down (closed or covered at that instant): the press reached window " + Json.Hex(root) + ". It was released outside the control it reached, so no click was completed there; the action is not repeated.");
    }
    /// <summary>0.36.2 M4.0: the button hold (same duration, still cancellable) while watching whether the control under the cursor took the
    /// mouse capture - i.e. its GUI thread has processed the press (evidence; and the capture barrier of the drain relies on it).</summary>
    void HoldWatchingCapture(Op o, double hold, long child, Dictionary<string, object> r) {
        Stopwatch hs = Stopwatch.StartNew(); long end = os.Ticks() + (long)Math.Ceiling(hold); double seenAt = -1; long cap = 0;
        while (true) {
            Gate(o); if (seenAt < 0 && child != 0) { cap = os.CaptureOf(child); if (cap == child) seenAt = hs.Elapsed.TotalMilliseconds; }
            long left = end - os.Ticks(); if (left <= 0) break; Thread.Sleep((int)Math.Min(left, 2));
        }
        Dictionary<string, object> p = r.ContainsKey("press") ? r["press"] as Dictionary<string, object> : null; if (p == null) { p = new Dictionary<string, object>(); r["press"] = p; }
        p["capturedByControl"] = seenAt >= 0; if (seenAt >= 0) p["captureMs"] = Math.Round(seenAt, 2); else p["capture"] = Json.Hex(cap);
    }
    /// <summary>0.36.2 M4.0: a click into target t happened now (global and per-process guard state).</summary>
    void NoteClick(Target t) { lastClickAt = os.Ticks(); if (t != null) lock (lastClickByPid) lastClickByPid[t.Pid] = lastClickAt; }
    /// <summary>
    /// 0.36.2 M4.0 input drain: after the release, wait until Windows has processed it (async button state up, at most 50 ms), then until the
    /// target window's GUI thread has pumped its messages twice (WM_NULL with a 250 ms limit each). Messages sent to a thread are dispatched
    /// before its queued input, so after two round trips the press and release that were already queued have been dispatched. Returns true
    /// when confirmed; false (window busy, hung or gone) leaves the next click under the global spacing.
    /// </summary>
    bool Drain(Op o, Target t, long hit, int b, Dictionary<string, object> r) {
        Stopwatch d = Stopwatch.StartNew(); ushort vk = (ushort)(b == 1 ? 2 : 1);
        while (os.IsKeyDown(vk) && d.ElapsedMilliseconds < 50) Thread.Sleep(1);
        // 0.36.2 M4.0 capture barrier: the control that processed the press keeps the mouse capture until its window procedure has processed
        // the release (WinForms Control.WmMouseUp releases it at the very end). A WinForms button raises Click only if, WHEN IT PROCESSES the
        // release, the window under the cursor is still the button - so another table's window raised over that spot before a busy table
        // thread got to its queued release silently swallows the click ("delivered, no state change"). Two WM_NULL round trips do not
        // prove the release was processed: Windows dispatches sent messages before queued mouse input. The reply (and with it the cursor
        // lease) waits until the capture is released, at most 600 ms; a capture still held after that is reported (not drained).
        // A press whose capture was never seen (a busy thread that had not processed it yet, or a control without capture) waits up to 300 ms
        // for the capture to appear and be released; if it never appears the click is NOT reported as processed: the settle stays inside
        // the lease and the next click keeps the global spacing (the Milestone 3.2 behaviour).
        Dictionary<string, object> pr = r.ContainsKey("press") ? r["press"] as Dictionary<string, object> : null;
        bool seen = pr != null && pr.ContainsKey("capturedByControl") && (bool)pr["capturedByControl"];
        long cap = hit != 0 ? os.CaptureOf(hit) : -1; Stopwatch bw = Stopwatch.StartNew();
        while (hit != 0 && cap != -1) {
            if (cap == hit) seen = true; else if (seen) break;
            if (bw.ElapsedMilliseconds >= (seen ? 600 : 300)) break;
            Thread.Sleep(1); cap = os.CaptureOf(hit);
        }
        bool released = seen && cap != hit && cap != -1;
        r["captureBarrier"] = true; r["captureReleased"] = released; r["captureSeen"] = seen; r["captureReleaseMs"] = Math.Round(bw.Elapsed.TotalMilliseconds, 2); o.Add("captureReleaseMs", bw.Elapsed.TotalMilliseconds);
        bool ok = released && os.DrainInput(hit != 0 ? hit : t.Hwnd, 250);
        r["drained"] = ok; r["drainMs"] = Math.Round(d.Elapsed.TotalMilliseconds, 2); o.Add("drainMs", d.Elapsed.TotalMilliseconds);
        if (!ok) { undrainedAt = os.Ticks(); Event("drain-unconfirmed", "hwnd=" + Json.Hex(hit != 0 ? hit : t.Hwnd) + " op=" + o.Id + " ms=" + d.ElapsedMilliseconds); }
        return ok;
    }
    void ClickAt(Op o, Target t, Dictionary<string, object> a, Dictionary<string, object> r, int count) {
        double pre = Json.Num(a, "preClickMs", 60, 0, 2000), hold = Json.Num(a, "holdMs", 70, 10, 1000), gap = Json.Num(a, "doubleGapMs", 120, 40, 400); int b = Btn(a);
        o.Mark("clickStartMs"); Sleep(o, pre); o.Mark("preClickEndMs");
        int x, y; os.GetCursor(out x, out y); Gate(o); Stopwatch hc = Stopwatch.StartNew(); HitCheck(t, a, x, y); o.Add("focusMs", hc.Elapsed.TotalMilliseconds);   // revalidate right before pressing (raises a covered window: focusPolicy)
        long child = os.ChildAt(x, y); r["hit"] = Json.Hex(child); r["hitClass"] = os.ControlClass(child);
        string want = Json.Get(a, "expectClass") as string; if (want != null && want.Length > 0 && os.ControlClass(child).IndexOf(want, StringComparison.OrdinalIgnoreCase) < 0) throw new DriverError("unexpected-control", "The control under the cursor is a " + os.ControlClass(child) + ", not the expected " + want + ".");
        // Two separate single clicks on the same spot within the system double-click time are a DOUBLE-click to Windows
        // (found by the 0.35 Windows acceptance). Unless a double-click was asked for, wait until a new press cannot pair up.
        if (count == 1) GuardSingleClick(o, r, t);
        CheckCursorOwnership(); os.GetCursor(out x, out y); HitCheck(t, a, x, y);
        o.Mark("pressMs");
        for (int i = 0; i < count; i++) {
            Gate(o); if (o.Deadline > 0 && os.Ticks() + hold >= o.Deadline) throw new DriverError("deadline", "Insufficient time for button hold."); Down(b); stats.Clicks++; NoteClick(t); lastClickX = x; lastClickY = y;
            Event("button-down", "button=" + b + " x=" + x + " y=" + y + " op=" + o.Id);
            bool released = false;
            bool guard = Json.Get(a, "pressGuard") is bool && (bool)Json.Get(a, "pressGuard"), drain = Json.Get(a, "drain") is bool && (bool)Json.Get(a, "drain");
            try { if (guard) PressGuard(o, t, r, b, x, y, ref released); if (guard || drain) HoldWatchingCapture(o, hold, child, r); else Sleep(o, hold); }
            finally { if (!released) { Up(b); Event("button-up", "button=" + b + " op=" + o.Id); } }   // the button is released even if a stop arrives during the hold
            if (i + 1 < count) Sleep(o, gap);
        }
        NoteClick(t); lastClickX = x; lastClickY = y; o.Mark("clickDoneMs");
        RememberCursor(); r["clickedAt"] = Pt(x, y); r["clicks"] = count; r["holdMs"] = hold;
        // 0.36.2 M4.0: confirm that the target window processed the click before replying (only when asked)
        if (Json.Get(a, "drain") is bool && (bool)Json.Get(a, "drain")) Drain(o, t, child, b, r);
    }

    /* ---------------- keyboard ---------------- */
    static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort> { { "backspace", 0x08 }, { "tab", 0x09 }, { "enter", 0x0D }, { "escape", 0x1B }, { "delete", 0x2E }, { "home", 0x24 }, { "end", 0x23 }, { "left", 0x25 }, { "right", 0x27 } };
    void PressKey(Op o, Target t, Dictionary<string, object> a) {
        string k = Json.Str(a, "key", 20); ushort vk; if (!Named.TryGetValue(k, out vk)) throw new DriverError("bad-request", "Key must be one of backspace, tab, enter, escape, delete, home, end, left, right.");
        int repeat = Json.Int(a, "repeat", 1, 1, 64); double gap = Json.Num(a, "keyIntervalMs", 40, 0, 2000), hold = Json.Num(a, "keyHoldMs", 12, 0, 500);
        for (int i = 0; i < repeat; i++) { Gate(o); RequireForeground(t); KeyDown(vk); try { Sleep(o, hold); } finally { KeyUp(vk); } stats.Keys++; NoteKey(); if (i + 1 < repeat) Sleep(o, gap); }
    }
    void NoteKey() { }
    void TypeText(Op o, Target t, string text, double gap, double hold) {
        foreach (char c in text) {
            Gate(o); RequireForeground(t);
            ushort vk = c >= '0' && c <= '9' ? (ushort)c : c == '.' ? (ushort)0xBE : (ushort)0;
            if (vk != 0) { KeyDown(vk); try { Sleep(o, hold); } finally { KeyUp(vk); } }
            else { if (c < 32 || c == 127) throw new DriverError("bad-request", "Control characters cannot be typed; use key."); lock(heldKeys){Gate(o);heldUnicode.Add(c);os.Unicode(c,true);} try { Sleep(o,hold); } finally { lock(heldKeys){os.Unicode(c,false);heldUnicode.Remove(c);} } }
            stats.Chars++; Sleep(o, gap);
        }
    }
    long FocusedField(Target t, Dictionary<string, object> a) {
        long f = os.FocusedControl(t.Hwnd); if (f == 0 || f == t.Hwnd) throw new DriverError("field-not-focused", "No text field has the keyboard focus in the simulator window.");
        string cls = os.ControlClass(f); if (cls.IndexOf("edit", StringComparison.OrdinalIgnoreCase) < 0) throw new DriverError("field-not-focused", "The focused control is a " + cls + ", not a text field.");
        Dictionary<string, object> p = Json.Get(a, "to") as Dictionary<string, object>;
        if (p != null) { long under = os.ChildAt(Json.Int(p, "x", 0, -100000, 100000), Json.Int(p, "y", 0, -100000, 100000)); if (under != f) throw new DriverError("field-not-focused", "The focused field is not the calibrated wager field."); }
        return f;
    }
    void Clear(Op o, Target t, long f, Dictionary<string, object> a) {
        string cur = os.ControlText(f); if (cur == null) throw new DriverError("field-unreadable", "The wager field's text cannot be read, so it cannot be verified.");
        if (cur.Length == 0) return; if (cur.Length > 32) throw new DriverError("field-unexpected", "The wager field holds " + cur.Length + " characters; refusing to clear it blind.");
        Dictionary<string, object> k = new Dictionary<string, object>(a); k["key"] = "end"; k["repeat"] = 1; PressKey(o, t, k);
        k["key"] = "backspace"; k["repeat"] = cur.Length + 1; PressKey(o, t, k);
        // The target window processes keystrokes asynchronously: wait (bounded) for the field to show the result before judging it.
        string after = WaitText(o, f, "", 600); if (after == null || after.Length != 0) throw new DriverError("clear-failed", "The wager field still shows '" + after + "' after clearing.");
    }
    /// <summary>Read the field until it shows `want` or `ms` pass; returns the last text read (null when unreadable).</summary>
    string WaitText(Op o, long f, string want, int ms) {
        long end = os.Ticks() + ms; string t = os.ControlText(f);
        while (t != want && os.ControlText(f) != null && os.Ticks() < end) { Gate(o); Thread.Sleep(15); t = os.ControlText(f); }
        return t;
    }
    /// <summary>Click the calibrated field, verify it has the focus, clear it, type sequentially, read it back. Nothing is submitted here.</summary>
    Dictionary<string, object> EnterText(Op o, Dictionary<string, object> a, Dictionary<string, object> r) {
        Gate(o); if (!armed) throw new DriverError("not-armed", "Automation is not enabled.");
        Target t = Check(a); string text = Json.Str(a, "text", 24); if (text.Length == 0) throw new DriverError("bad-request", "Empty amount.");
        foreach (char c in text) if (!(c >= '0' && c <= '9' || c == '.')) throw new DriverError("bad-request", "A wager may contain digits and one decimal point only.");
        double gap = Json.Num(a, "keyIntervalMs", 45, 0, 2000), hold = Json.Num(a, "keyHoldMs", 12, 0, 500), settle = Json.Num(a, "focusSettleMs", 80, 0, 2000);
        MoveTo(o, t, a, r); ClickAt(o, t, a, r, 1); Sleep(o, settle);
        RequireForeground(t); long f = FocusedField(t, a); r["field"] = Json.Hex(f);
        Clear(o, t, f, a); TypeText(o, t, text, gap, hold); Sleep(o, Math.Max(30, gap));
        string seen = WaitText(o, f, text, 600); r["typed"] = text; r["read"] = seen; r["verified"] = seen == text;
        if (seen != text) { try { Clear(o, t, f, a); } catch (DriverError) { } throw new DriverError("verify-mismatch", "The wager field shows '" + seen + "' instead of '" + text + "'; it was cleared and nothing was submitted."); }
        return r;
    }
}

/// <summary>Independent cursor sampler (its own thread) for movement validation: position and left-button state every few ms.</summary>
public sealed class CursorMonitor {
    readonly IPlatform os; readonly int interval, max; readonly List<int[]> samples = new List<int[]>(); volatile bool run; Thread th; public int ButtonDown;
    public CursorMonitor(IPlatform os, int intervalMs, int max) { this.os = os; interval = intervalMs; this.max = max; }
    public void Start() { run = true; th = new Thread(Loop) { IsBackground = true, Name = "cursor-monitor", Priority = ThreadPriority.AboveNormal }; th.Start(); }
    void Loop() { Stopwatch sw = Stopwatch.StartNew(); while (run) { int x, y; os.GetCursor(out x, out y); bool down = os.IsKeyDown(1); lock (samples) { if (samples.Count < max) samples.Add(new int[] { (int)(sw.Elapsed.TotalMilliseconds * 10), x, y, down ? 1 : 0 }); } if (down) ButtonDown++; Thread.Sleep(interval); } }
    public void Stop() { run = false; if (th != null) th.Join(1000); }
    public object[] Samples() { lock (samples) { object[] a = new object[samples.Count]; for (int i = 0; i < a.Length; i++) a[i] = samples[i]; return a; } }
}
}
