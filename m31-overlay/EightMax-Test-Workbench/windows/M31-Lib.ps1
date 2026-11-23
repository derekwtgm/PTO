<# EightMax Test Workbench 0.36.2 Milestone 3.1 - Windows test-run library (Windows PowerShell 5.1; it also loads in PowerShell 7 so its
   reporting, packaging and recovery logic is tested on Linux - Windows-only parts check $script:M31IsWindows).

   WHY (Milestone 3 on the operator PC): the Milestone 3 runner kept every result in memory and wrote its phase state, report and ZIP only
   after the LAST phase. When the host-start phase stopped responding and the window was closed, nothing but raw tool logs remained.

   CONTINUOUS PERSISTENCE - created when the run starts and updated during the run:
     run-status.json      the run's state (atomic write: temp file + replace; a crash never leaves a half-written file): mode, phases with
                          start / end / status, current phase, current operation (with its time limit), last successful check, current
                          child process, last exit code, heartbeat; state running / completed / interrupted
     console.log          everything shown in the window, with time stamps (appended line by line)
     errors.log           every failure and every exception with type, message, script, line, stack trace, phase, operation, last
                          successful check, child process, exit code and time
     checks.jsonl         one JSON line per completed check, appended the moment the check completes
     operations.jsonl     one JSON line when an instrumented operation STARTS and one when it ENDS (where a hang stopped is visible)
     phases\NN-name.json  each phase's result, written as soon as the phase ends
   At the end (also after an ordinary failure, a timeout or Ctrl+C): milestone3-results.json, milestone3-results.txt, milestone3-results.zip
   If the process is killed, the computer shuts down or power fails, the files above survive; the next launch finds the unfinished run
   (state running, runner process gone), marks it INTERRUPTED and packages its logs. No result is invented for a phase that never ran.

   STATUS WORDS   checks: PASS FAIL WARNING SKIPPED      phases: PASS FAIL WARNING SKIPPED NOT RUN INTERRUPTED
   FAILURE CLASS  application (the Workbench failed a test), harness (the test runner itself failed), environment (this computer prevents
                  the test: port in use, another EightMax running, missing file ...), timeout (an operation exceeded its time limit)
   EXIT CODES     0 PASS (warnings allowed)   1 FAIL (application or timeout)   2 HARNESS ERROR   3 ENVIRONMENT PROBLEM   4 INTERRUPTED
                  5 the launcher could not start PowerShell or the runner (CMD wrappers)   6 nothing to package (mode D)
   SESSION OWNERSHIP  the runner places itself in a Windows job object that ends every process it started (and their children) when the
                  runner ends, however it ends. Cleanup only ever stops processes of this job or descendants of processes this run started;
                  another program - or another EightMax started by the operator - is reported, never stopped. #>

$script:M31Version = '0.36.2-milestone-3.1'
$script:M31AppVersion = '0.36.2-dev'
$script:M31IsWindows = ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT)
$script:M31Utf8 = New-Object Text.UTF8Encoding($false)
$script:M31 = $null
$script:M31HelperOk = $false
$script:M31HelperError = ''
$script:M31JobOk = $false
$script:M31JobError = ''
$script:M31Tracked = New-Object Collections.ArrayList
$script:M31Statuses = @('PASS', 'FAIL', 'WARNING', 'SKIPPED')
$script:M31Categories = @('application', 'harness', 'environment', 'timeout')
$script:M31HostNames = @('EightMaxWorkbench', 'EightMaxInput', 'EightMaxTestTable', 'EightMaxCapture', 'EightMaxWgc', 'mwcli')

# ------------------------------------------------------------------------------------------------------------------------------------------
# JSON (one serializer for Windows PowerShell 5.1 and PowerShell 7; ASCII output, non-ASCII escaped as \uXXXX)
# ------------------------------------------------------------------------------------------------------------------------------------------
function ConvertTo-M31JsonString([string]$Text) {
    if ($null -eq $Text) { return 'null' }
    $q = [string][char]34
    if ($Text -notmatch '[\x00-\x1f\x22\x5c\x7f-\uffff]') { return $q + $Text + $q }
    $e = [regex]::Replace($Text, '[\x00-\x1f\x22\x5c\x7f-\uffff]', [Text.RegularExpressions.MatchEvaluator] {
            param($m)
            $c = [int][char]$m.Value
            switch ($c) { 34 { return '\' + [char]34 } 92 { return '\\' } 10 { return '\n' } 13 { return '\r' } 9 { return '\t' } 8 { return '\b' } 12 { return '\f' } default { return '\u' + $c.ToString('x4') } }
        })
    return $q + $e + $q
}
function ConvertTo-M31Json($Value, [int]$Depth = 0) {
    if ($Depth -gt 40) { return ConvertTo-M31JsonString '(depth limit)' }
    if ($null -eq $Value) { return 'null' }
    $custom = $false
    $base = $Value.PSObject.BaseObject
    if ($null -ne $base) { if ($base.GetType().FullName -eq 'System.Management.Automation.PSCustomObject') { $custom = $true } else { $Value = $base } }
    if ($Value -is [string] -or $Value -is [char]) { return ConvertTo-M31JsonString ([string]$Value) }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [int16] -or $Value -is [byte] -or $Value -is [uint32] -or $Value -is [uint64] -or $Value -is [uint16] -or $Value -is [sbyte] -or $Value -is [decimal]) { return ([IFormattable]$Value).ToString($null, [Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [double] -or $Value -is [single]) { $d = [double]$Value; if ([double]::IsNaN($d) -or [double]::IsInfinity($d)) { return 'null' }; return $d.ToString('R', [Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [DateTime]) { return ConvertTo-M31JsonString ($Value.ToUniversalTime().ToString('o')) }
    if ($Value -is [DateTimeOffset]) { return ConvertTo-M31JsonString ($Value.UtcDateTime.ToString('o')) }
    if ($Value -is [TimeSpan]) { return ([long]$Value.TotalMilliseconds).ToString([Globalization.CultureInfo]::InvariantCulture) }
    if ($Value -is [enum]) { return ConvertTo-M31JsonString ([string]$Value) }
    $sb = New-Object Text.StringBuilder
    if ($Value -is [Collections.IDictionary]) {
        [void]$sb.Append('{'); $first = $true
        foreach ($k in @($Value.Keys)) { if (-not $first) { [void]$sb.Append(',') }; $first = $false; [void]$sb.Append((ConvertTo-M31JsonString ([string]$k))).Append(':').Append((ConvertTo-M31Json $Value[$k] ($Depth + 1))) }
        return $sb.Append('}').ToString()
    }
    if ($custom) {
        [void]$sb.Append('{'); $first = $true
        foreach ($p in $Value.PSObject.Properties) { if (-not $first) { [void]$sb.Append(',') }; $first = $false; [void]$sb.Append((ConvertTo-M31JsonString $p.Name)).Append(':').Append((ConvertTo-M31Json $p.Value ($Depth + 1))) }
        return $sb.Append('}').ToString()
    }
    if ($Value -is [Collections.IEnumerable]) {
        [void]$sb.Append('['); $first = $true
        foreach ($x in $Value) { if (-not $first) { [void]$sb.Append(',') }; $first = $false; [void]$sb.Append((ConvertTo-M31Json $x ($Depth + 1))) }
        return $sb.Append(']').ToString()
    }
    return ConvertTo-M31JsonString ([string]$Value)
}
function Read-M31JsonFile([string]$Path) {
    # small files written by this library (ConvertFrom-Json is enough below its 2 MB limit on Windows PowerShell 5.1)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $t = Read-M31Text $Path
    if (-not $t.Trim()) { return $null }
    return ($t | ConvertFrom-Json)
}
function Read-M31LargeJson([string]$Path) {
    # tool reports can exceed ConvertFrom-Json's 2 MB limit on Windows PowerShell 5.1: JavaScriptSerializer without a length limit there
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $t = Read-M31Text $Path
    if ($script:M31IsWindows -and $PSVersionTable.PSVersion.Major -lt 6) {
        Add-Type -AssemblyName System.Web.Extensions
        $js = New-Object Web.Script.Serialization.JavaScriptSerializer; $js.MaxJsonLength = [int]::MaxValue; $js.RecursionLimit = 200
        return $js.DeserializeObject($t)
    }
    return ($t | ConvertFrom-Json)
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Files: atomic writes, appends, shared reads (a file another process still writes can always be read)
# ------------------------------------------------------------------------------------------------------------------------------------
function Write-M31AtomicText([string]$Path, [string]$Text) {
    $dir = [IO.Path]::GetDirectoryName($Path)
    $tmp = [IO.Path]::Combine($dir, '.' + [IO.Path]::GetFileName($Path) + '.' + $PID + '.tmp')
    $bytes = $script:M31Utf8.GetBytes($Text)
    $fs = New-Object IO.FileStream($tmp, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
    for ($i = 0; $i -lt 20; $i++) {
        try {
            if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp, $Path, [NullString]::Value) } else { [IO.File]::Move($tmp, $Path) }
            return
        } catch { Start-Sleep -Milliseconds 50 }
    }
    # a reader that keeps the file open without delete sharing: write in place rather than lose the record
    [IO.File]::WriteAllBytes($Path, $bytes); try { [IO.File]::Delete($tmp) } catch {}
}
function Add-M31Line([string]$Path, [string]$Line) {
    for ($i = 0; $i -lt 10; $i++) { try { [IO.File]::AppendAllText($Path, $Line + "`r`n", $script:M31Utf8); return } catch { Start-Sleep -Milliseconds 30 } }
}
function Read-M31Text([string]$Path, [int]$MaxBytes = 0) {
    try {
        $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $len = $fs.Length; $start = 0
            if ($MaxBytes -gt 0 -and $len -gt $MaxBytes) { $start = $len - $MaxBytes }
            [void]$fs.Seek($start, [IO.SeekOrigin]::Begin)
            $buf = New-Object byte[] ([int]($len - $start)); $n = 0
            while ($n -lt $buf.Length) { $r = $fs.Read($buf, $n, $buf.Length - $n); if ($r -le 0) { break }; $n += $r }
            return $script:M31Utf8.GetString($buf, 0, $n)
        } finally { $fs.Dispose() }
    } catch { return '' }
}
function Get-M31Tail([string]$Path, [int]$Lines = 20, [int]$MaxBytes = 65536) {
    $t = Read-M31Text $Path $MaxBytes
    if (-not $t) { return '' }
    $all = @($t -split "`r?`n" | Where-Object { $_ -ne '' })
    return (($all | Select-Object -Last $Lines) -join "`n")
}
function Get-M31Sha256([string]$Path) {
    $h = [Security.Cryptography.SHA256]::Create()
    try {
        $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try { return ([BitConverter]::ToString($h.ComputeHash($fs)) -replace '-', '').ToLowerInvariant() } finally { $fs.Dispose() }
    } finally { $h.Dispose() }
}
function Get-M31TextSha256([string]$Text) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($h.ComputeHash($script:M31Utf8.GetBytes($Text))) -replace '-', '').ToLowerInvariant() } finally { $h.Dispose() }
}
function Get-M31SafeName([string]$Name) { return ($Name -replace '[^A-Za-z0-9 ._()-]', '-') }
function Get-M31PathInfo([string]$Path) {
    if (-not $Path) { return $null }
    return [ordered]@{ path = $Path; length = $Path.Length; hasSpaces = ($Path -match ' '); hasNonAscii = ($Path -match '[^\x00-\x7f]'); hasParentheses = ($Path -match '[()]'); hasAmpersand = ($Path -match '&'); hasPercentOrBang = ($Path -match '[%!]'); isUnc = $Path.StartsWith('\\'); longerThan200 = ($Path.Length -gt 200) }
}
function Test-M31PathInside([string]$Child, [string]$Parent) {
    if (-not $Child -or -not $Parent) { return $false }
    $c = [IO.Path]::GetFullPath($Child).TrimEnd('\', '/'); $p = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/')
    $cmp = $(if ($script:M31IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal })
    if ([string]::Equals($c, $p, $cmp)) { return $true }
    return $c.StartsWith($p + [IO.Path]::DirectorySeparatorChar, $cmp)
}
function Get-M31RelativePath([string]$Full, [string]$Base) {
    $b = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $f = [IO.Path]::GetFullPath($Full)
    if ($f.Length -ge $b.Length -and $f.Substring(0, $b.Length) -eq $b) { return ($f.Substring($b.Length) -replace '\\', '/') }
    return ($f -replace '\\', '/')
}
function Format-M31Duration([double]$Seconds) {
    if ($Seconds -lt 60) { return ([math]::Round($Seconds, 1)).ToString([Globalization.CultureInfo]::InvariantCulture) + ' s' }
    $m = [math]::Floor($Seconds / 60); return ([string]$m + ' min ' + [string][math]::Round($Seconds - 60 * $m) + ' s')
}
function Get-M31Now { return [DateTime]::UtcNow.ToString('o') }
function ConvertTo-M31Date($Value) {
    # a DateTime (PowerShell 7 ConvertFrom-Json) or an ISO 8601 string (Windows PowerShell 5.1), independent of the regional settings
    if ($null -eq $Value -or [string]$Value -eq '') { return $null }
    if ($Value -is [DateTime]) { return $Value }
    try { return [DateTime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) } catch { return $null }
}
function Format-M31Time($Value) {
    # local 'yyyy-MM-dd HH:mm:ss' from an ISO string (Windows PowerShell 5.1) or a DateTime (PowerShell 7 ConvertFrom-Json converts dates)
    if ($null -eq $Value -or [string]$Value -eq '') { return '' }
    try { if ($Value -is [DateTime]) { $d = $Value } else { $d = [DateTime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }; return $d.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) } catch { return [string]$Value }
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Console + logs
# ------------------------------------------------------------------------------------------------------------------------------------------
function Write-M31Log([string]$Text, [string]$Color = '', [switch]$NoConsole) {
    $stamp = [DateTime]::Now.ToString('HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)
    if (-not $NoConsole) {
        try { if ($Color) { Write-Host ($stamp + '  ' + $Text) -ForegroundColor $Color } else { Write-Host ($stamp + '  ' + $Text) } } catch { try { [Console]::WriteLine($stamp + '  ' + $Text) } catch {} }
    }
    if ($script:M31 -and $script:M31.Files) { Add-M31Line $script:M31.Files.Console ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture) + '  ' + $Text) }
}
function Write-M31ErrorLog([string]$Text) {
    if ($script:M31 -and $script:M31.Files) { Add-M31Line $script:M31.Files.Errors ([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss.fff', [Globalization.CultureInfo]::InvariantCulture) + '  ' + $Text) }
}
function Set-M31Title([string]$Text) { try { $Host.UI.RawUI.WindowTitle = 'EightMax M3.1 tests - ' + $Text } catch {} }

# ------------------------------------------------------------------------------------------------------------------------------------------
# Windows helper (job object, TCP owners, top-level windows, process snapshot). Compiled once; every caller has a fallback without it.
# ------------------------------------------------------------------------------------------------------------------------------------
$script:M31HelperSource = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace EightMaxM31 {
public static class Win {
    [StructLayout(LayoutKind.Sequential)] struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
    [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr p, q, r, s; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PE32 { public uint dwSize, cntUsage, th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID, cntThreads, th32ParentProcessID; public int pcPriClassBase; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile; }
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int size, out int ret);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32FirstW(IntPtr s, ref PE32 e);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool Process32NextW(IntPtr s, ref PE32 e);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int cls, uint reserved);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    static IntPtr job = IntPtr.Zero;
    public static string JoinKillOnCloseJob() {
        try {
            if (job != IntPtr.Zero) return "";
            IntPtr j = CreateJobObject(IntPtr.Zero, null);
            if (j == IntPtr.Zero) return "CreateJobObject failed (error " + Marshal.GetLastWin32Error() + ")";
            EXT info = new EXT(); info.Basic.LimitFlags = 0x2000;
            if (!SetInformationJobObject(j, 9, ref info, Marshal.SizeOf(typeof(EXT)))) return "SetInformationJobObject failed (error " + Marshal.GetLastWin32Error() + ")";
            if (!AssignProcessToJobObject(j, GetCurrentProcess())) return "AssignProcessToJobObject failed (error " + Marshal.GetLastWin32Error() + ")";
            job = j; return "";
        } catch (Exception e) { return e.GetType().Name + ": " + e.Message; }
    }
    public static int[] JobProcessIds() {
        if (job == IntPtr.Zero) return new int[0];
        int size = 8 + 8 * 4096; IntPtr buf = Marshal.AllocHGlobal(size);
        try {
            int ret; if (!QueryInformationJobObject(job, 3, buf, size, out ret)) return new int[0];
            int n = Marshal.ReadInt32(buf, 4); int[] ids = new int[n];
            for (int i = 0; i < n; i++) ids[i] = (int)Marshal.ReadInt64(buf, 8 + 8 * i);
            return ids;
        } finally { Marshal.FreeHGlobal(buf); }
    }
    public static List<string[]> Processes() {
        List<string[]> list = new List<string[]>(); IntPtr s = CreateToolhelp32Snapshot(2, 0);
        if (s == IntPtr.Zero || s == new IntPtr(-1)) return list;
        try {
            PE32 e = new PE32(); e.dwSize = (uint)Marshal.SizeOf(typeof(PE32));
            if (Process32FirstW(s, ref e)) { do { list.Add(new string[] { e.th32ProcessID.ToString(), e.th32ParentProcessID.ToString(), e.szExeFile }); } while (Process32NextW(s, ref e)); }
        } finally { CloseHandle(s); }
        return list;
    }
    static int Port(int v) { return ((v & 0xff) << 8) | ((v >> 8) & 0xff); }
    public static List<int[]> TcpRows(int port) {
        List<int[]> rows = new List<int[]>();
        foreach (int af in new int[] { 2, 23 }) {
            int size = 0; GetExtendedTcpTable(IntPtr.Zero, ref size, false, af, 5, 0); size += 4096;
            IntPtr buf = Marshal.AllocHGlobal(size);
            try {
                if (GetExtendedTcpTable(buf, ref size, false, af, 5, 0) != 0) continue;
                int n = Marshal.ReadInt32(buf), rowSize = af == 2 ? 24 : 56;
                for (int i = 0; i < n; i++) {
                    IntPtr row = new IntPtr(buf.ToInt64() + 4 + (long)i * rowSize);
                    int local, state, pid;
                    if (af == 2) { state = Marshal.ReadInt32(row, 0); local = Port(Marshal.ReadInt32(row, 8)); pid = Marshal.ReadInt32(row, 20); }
                    else { local = Port(Marshal.ReadInt32(row, 20)); state = Marshal.ReadInt32(row, 48); pid = Marshal.ReadInt32(row, 52); }
                    if (local == port) rows.Add(new int[] { af == 2 ? 4 : 6, state, pid });
                }
            } finally { Marshal.FreeHGlobal(buf); }
        }
        return rows;
    }
    public static List<string[]> Windows() {
        List<string[]> list = new List<string[]>();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            uint pid; GetWindowThreadProcessId(h, out pid);
            StringBuilder t = new StringBuilder(512), c = new StringBuilder(256);
            GetWindowText(h, t, 512); GetClassName(h, c, 256);
            list.Add(new string[] { h.ToInt64().ToString(), pid.ToString(), IsWindowVisible(h) ? "1" : "0", c.ToString(), t.ToString() });
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
}
'@
function Initialize-M31Helper {
    if (-not $script:M31IsWindows) { $script:M31HelperError = 'not Windows'; return $false }
    if ($script:M31HelperOk) { return $true }
    try {
        if (-not ('EightMaxM31.Win' -as [type])) { Add-Type -TypeDefinition $script:M31HelperSource -Language CSharp -ErrorAction Stop }
        $script:M31HelperOk = $true
    } catch { $script:M31HelperError = $_.Exception.Message; $script:M31HelperOk = $false }
    return $script:M31HelperOk
}
function Enable-M31SessionJob {
    # Every process this run starts (and their children) ends when the runner ends, however it ends (window closed, killed, crash).
    if (-not (Initialize-M31Helper)) { $script:M31JobError = 'helper unavailable: ' + $script:M31HelperError; return $false }
    $e = [EightMaxM31.Win]::JoinKillOnCloseJob()
    if ($e) { $script:M31JobError = $e; $script:M31JobOk = $false } else { $script:M31JobOk = $true }
    return $script:M31JobOk
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Processes: snapshot, trees, session ownership, details, bounded runs
# ------------------------------------------------------------------------------------------------------------------------------------------
function Get-M31ProcessList {
    $list = New-Object Collections.ArrayList
    if ($script:M31HelperOk) {
        foreach ($r in [EightMaxM31.Win]::Processes()) { [void]$list.Add([ordered]@{ pid = [int]$r[0]; ppid = [int]$r[1]; name = [string]$r[2] }) }
        return $list.ToArray()
    }
    if ($script:M31IsWindows) {
        try { foreach ($p in @(Get-CimInstance Win32_Process -OperationTimeoutSec 20 -ErrorAction Stop)) { [void]$list.Add([ordered]@{ pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = [string]$p.Name }) }; return $list.ToArray() } catch {}
    } else {
        foreach ($d in @(Get-ChildItem -LiteralPath '/proc' -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^\d+$' })) {
            try { $st = [IO.File]::ReadAllText('/proc/' + $d.Name + '/stat'); $m = [regex]::Match($st, '^(\d+) \((.*)\) \S+ (\d+)'); if ($m.Success) { [void]$list.Add([ordered]@{ pid = [int]$m.Groups[1].Value; ppid = [int]$m.Groups[3].Value; name = $m.Groups[2].Value }) } } catch {}
        }
        return $list.ToArray()
    }
    foreach ($p in @(Get-Process -ErrorAction SilentlyContinue)) { [void]$list.Add([ordered]@{ pid = [int]$p.Id; ppid = -1; name = [string]$p.ProcessName }) }
    return $list.ToArray()
}
function Get-M31Descendants([int[]]$RootPids, $List = $null) {
    if ($null -eq $List) { $List = @(Get-M31ProcessList) }
    $found = New-Object Collections.ArrayList; $frontier = @($RootPids)
    for ($round = 0; $round -lt 16 -and $frontier.Count; $round++) {
        $next = @()
        foreach ($p in $List) { if ($frontier -contains $p.ppid -and $p.pid -ne $p.ppid -and -not ($found -contains $p.pid) -and -not ($RootPids -contains $p.pid)) { [void]$found.Add($p.pid); $next += $p.pid } }
        $frontier = $next
    }
    return $found.ToArray()
}
function Test-M31Alive([int]$ProcessId) {
    try { $p = [Diagnostics.Process]::GetProcessById($ProcessId) } catch { return $false }
    $alive = $true; try { $alive = -not $p.HasExited } catch { $alive = $true }   # an elevated process denies the query: it exists
    try { $p.Dispose() } catch {}; return $alive
}
function Get-M31SessionPids {
    # processes of this run: the job's members (without the runner) and descendants of every process this run started
    $ids = New-Object Collections.ArrayList
    if ($script:M31JobOk) { foreach ($i in [EightMaxM31.Win]::JobProcessIds()) { if ($i -ne $PID -and -not ($ids -contains $i)) { [void]$ids.Add([int]$i) } } }
    $roots = @($script:M31Tracked | ForEach-Object { [int]$_ })
    if ($roots.Count) {
        $list = @(Get-M31ProcessList)
        foreach ($r in $roots) { if ((Test-M31Alive $r) -and -not ($ids -contains $r)) { [void]$ids.Add($r) } }
        foreach ($d in @(Get-M31Descendants $roots $list)) { if ($d -ne $PID -and -not ($ids -contains $d)) { [void]$ids.Add([int]$d) } }
    }
    return $ids.ToArray()
}
function Test-M31SessionOwned([int]$ProcessId) { return (@(Get-M31SessionPids) -contains $ProcessId) }
function Get-M31ProcessDetails([int[]]$Pids) {
    $out = New-Object Collections.ArrayList
    $cim = @{}
    if ($script:M31IsWindows -and $Pids.Count) {
        try {
            $filter = ($Pids | ForEach-Object { 'ProcessId=' + $_ }) -join ' OR '
            foreach ($c in @(Get-CimInstance Win32_Process -Filter $filter -OperationTimeoutSec 15 -ErrorAction Stop)) { $cim[[int]$c.ProcessId] = $c }
        } catch {}
    }
    foreach ($i in $Pids) {
        $d = [ordered]@{ pid = $i; name = $null; path = $null; startedAt = $null; commandLine = $null; parentPid = $null; sessionOwned = $null; alive = (Test-M31Alive $i) }
        try { $p = [Diagnostics.Process]::GetProcessById($i); $d.name = $p.ProcessName; try { $d.startedAt = $p.StartTime.ToUniversalTime().ToString('o') } catch {}; try { $d.path = $p.MainModule.FileName } catch {}; $p.Dispose() } catch {}
        if ($cim.ContainsKey($i)) { $c = $cim[$i]; $d.commandLine = [string]$c.CommandLine; if (-not $d.path) { $d.path = [string]$c.ExecutablePath }; $d.parentPid = [int]$c.ParentProcessId; if (-not $d.name) { $d.name = [string]$c.Name } }
        if ($d.commandLine) { $d.commandLine = ($d.commandLine -replace '(?i)(token[=: ]+)[0-9a-f]{16,}', '$1(redacted)') }
        [void]$out.Add($d)
    }
    return $out.ToArray()
}
function Get-M31ProcessTree([int]$RootPid) {
    $list = @(Get-M31ProcessList)
    $ids = @($RootPid) + @(Get-M31Descendants @($RootPid) $list)
    $details = @(Get-M31ProcessDetails ([int[]]@($ids | Where-Object { Test-M31Alive $_ })))
    return [ordered]@{ root = $RootPid; processes = $details }
}
function Stop-M31ProcessTree([int]$ProcessId, [string]$Why) {
    # Only processes of this test session are ever stopped (job members or descendants of processes this run started).
    $owned = @(Get-M31SessionPids)
    if (-not ($owned -contains $ProcessId)) { Write-M31Log ('  not stopping pid ' + $ProcessId + ' (' + $Why + '): it does not belong to this test session') 'Yellow'; return [ordered]@{ stopped = @(); refused = @($ProcessId) } }
    $list = @(Get-M31ProcessList)
    $victims = @(@(Get-M31Descendants @($ProcessId) $list) | Where-Object { $owned -contains $_ })
    [array]::Reverse($victims); $victims += $ProcessId
    $stopped = New-Object Collections.ArrayList
    foreach ($v in $victims) {
        try { $p = [Diagnostics.Process]::GetProcessById($v); $n = $p.ProcessName; if (-not $p.HasExited) { $p.Kill(); [void]$p.WaitForExit(10000); [void]$stopped.Add($n + ' pid ' + $v) }; $p.Dispose() } catch {}
    }
    if ($stopped.Count) { Write-M31Log ('  stopped ' + ($stopped -join ', ') + ' (' + $Why + ')') 'Yellow' }
    return [ordered]@{ stopped = $stopped.ToArray(); refused = @() }
}
function Stop-M31SessionProcesses([string]$Why) {
    $left = @(Get-M31SessionPids | Where-Object { Test-M31Alive $_ })
    $names = New-Object Collections.ArrayList
    foreach ($i in $left) { try { $p = [Diagnostics.Process]::GetProcessById($i); [void]$names.Add($p.ProcessName + ' pid ' + $i); if (-not $p.HasExited) { $p.Kill(); [void]$p.WaitForExit(10000) }; $p.Dispose() } catch {} }
    if ($names.Count) { Write-M31Log ('  stopped session processes (' + $Why + '): ' + ($names -join ', ')) 'Yellow' }
    return $names.ToArray()
}
function Start-M31Process([string]$FilePath, [string]$Arguments, [string]$LogBase, [string]$WorkingDirectory, [switch]$Visible) {
    # stdout / stderr go to FILES (never pipes - a full pipe can block a child; Windows PowerShell 5.1 turns native stderr into errors).
    # Start-Process with redirection always uses CreateProcess: no shell-mediated prompt (security warning, SmartScreen) can block it.
    $out = $LogBase + '.out.txt'; $err = $LogBase + '.err.txt'
    $sp = @{ FilePath = $FilePath; RedirectStandardOutput = $out; RedirectStandardError = $err; PassThru = $true }
    if ($Arguments) { $sp.ArgumentList = $Arguments }
    if ($WorkingDirectory) { $sp.WorkingDirectory = $WorkingDirectory }
    if ($script:M31IsWindows -and -not $Visible) { $sp.WindowStyle = 'Hidden' }
    $p = Start-Process @sp
    $null = $p.Handle
    [void]$script:M31Tracked.Add($p.Id)
    $info = [ordered]@{ pid = $p.Id; name = [IO.Path]::GetFileName($FilePath); commandLine = ($FilePath + ' ' + $Arguments); startedAt = (Get-M31Now); out = $out; err = $err }
    if ($script:M31) { $script:M31.CurrentChild = $info; Save-M31Status }
    return [ordered]@{ Process = $p; Pid = $p.Id; Out = $out; Err = $err; Info = $info }
}
function Wait-M31Process($Started, [int]$TimeoutSec, [string]$What, [scriptblock]$OnTick, [int]$TickSeconds = 15) {
    $sw = [Diagnostics.Stopwatch]::StartNew(); $next = $TickSeconds; $p = $Started.Process
    while (-not $p.WaitForExit(500)) {
        $el = $sw.Elapsed.TotalSeconds
        if ($el -ge $next) {
            $extra = ''; if ($OnTick) { try { $extra = [string](& $OnTick $el) } catch {} }
            Write-M31Log ('     ... ' + $What + ' still running after ' + [int]$el + ' s (time limit ' + $TimeoutSec + ' s)' + $(if ($extra) { ' - ' + $extra } else { '' })) 'DarkGray'
            Update-M31Heartbeat ($What + ': ' + [int]$el + ' s of ' + $TimeoutSec + ' s'); $next += $TickSeconds
        }
        if ($el -ge $TimeoutSec) {
            $diag = $null; try { $diag = Get-M31HangDiagnostics $Started.Pid $What } catch { $diag = [ordered]@{ error = $_.Exception.Message } }
            $stop = Stop-M31ProcessTree $Started.Pid ('time limit of ' + $TimeoutSec + ' s exceeded: ' + $What)
            if ($script:M31) { $script:M31.CurrentChild = $null; $script:M31.LastExitCode = $null; Save-M31Status }
            return [ordered]@{ exitCode = $null; timedOut = $true; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); diagnostics = $diag; stopped = $stop.stopped }
        }
    }
    try { $p.WaitForExit() } catch {}
    $code = $null; try { $code = $p.ExitCode } catch {}
    if ($script:M31) { $script:M31.CurrentChild = $null; $script:M31.LastExitCode = $code; Save-M31Status }
    return [ordered]@{ exitCode = $code; timedOut = $false; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1); diagnostics = $null; stopped = @() }
}
function Invoke-M31Tool([string]$FilePath, [string]$Arguments, [string]$LogBase, [int]$TimeoutSec, [string]$What, [string]$WorkingDirectory, [scriptblock]$OnTick) {
    $s = Start-M31Process $FilePath $Arguments $LogBase $WorkingDirectory
    $r = Wait-M31Process $s $TimeoutSec $What $OnTick
    $r.out = $s.Out; $r.err = $s.Err; $r.pid = $s.Pid
    return $r
}
function Invoke-M31WithTimeout([scriptblock]$Script, [int]$Seconds = 20, $Argument = $null) {
    # runs a query that can block (WMI, event log, Defender) in a separate runspace; abandoned (not awaited) after the time limit
    $ps = [PowerShell]::Create()
    try {
        [void]$ps.AddScript($Script.ToString()); if ($null -ne $Argument) { [void]$ps.AddArgument($Argument) }
        $h = $ps.BeginInvoke()
        if (-not $h.AsyncWaitHandle.WaitOne($Seconds * 1000)) { try { [void]$ps.BeginStop($null, $null) } catch {}; return [ordered]@{ timedOut = $true; value = $null; error = ('no answer within ' + $Seconds + ' s') } }
        $v = $ps.EndInvoke($h)
        $e = $null; if ($ps.Streams.Error.Count) { $e = [string]$ps.Streams.Error[0] }
        return [ordered]@{ timedOut = $false; value = $v; error = $e }
    } catch { return [ordered]@{ timedOut = $false; value = $null; error = $_.Exception.Message } }
    finally { if ($h -and $h.IsCompleted) { $ps.Dispose() } }
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Diagnostics: port owners, windows (security prompts), Mark of the Web, event logs
# ------------------------------------------------------------------------------------------------------------------------------------------
function Get-M31TcpStateName([int]$State) {
    $n = @{ 1 = 'CLOSED'; 2 = 'LISTEN'; 3 = 'SYN_SENT'; 4 = 'SYN_RCVD'; 5 = 'ESTABLISHED'; 6 = 'FIN_WAIT1'; 7 = 'FIN_WAIT2'; 8 = 'CLOSE_WAIT'; 9 = 'CLOSING'; 10 = 'LAST_ACK'; 11 = 'TIME_WAIT'; 12 = 'DELETE_TCB' }
    if ($n.ContainsKey($State)) { return $n[$State] }; return [string]$State
}
function Get-M31PortOwners([int]$Port = 48713, [switch]$All) {
    # LISTEN owners by default (only a listener blocks the desktop host); -All adds connections (diagnostics)
    $rows = New-Object Collections.ArrayList; $method = ''
    if ($script:M31HelperOk) {
        $method = 'GetExtendedTcpTable'
        foreach ($r in [EightMaxM31.Win]::TcpRows($Port)) { [void]$rows.Add([ordered]@{ family = 'IPv' + $r[0]; state = (Get-M31TcpStateName $r[1]); pid = [int]$r[2] }) }
    } elseif ($script:M31IsWindows) {
        try { $method = 'Get-NetTCPConnection'; foreach ($c in @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue)) { [void]$rows.Add([ordered]@{ family = $(if ([string]$c.LocalAddress -match ':') { 'IPv6' } else { 'IPv4' }); state = ([string]$c.State).ToUpperInvariant(); pid = [int]$c.OwningProcess }) } } catch { $method = 'unavailable: ' + $_.Exception.Message }
    } else {
        $method = 'not Windows'
    }
    $out = New-Object Collections.ArrayList
    foreach ($r in $rows) {
        $st = [string]$r.state; if ($st -eq 'LISTENING') { $st = 'LISTEN' }
        if (-not $All -and $st -ne 'LISTEN') { continue }
        $name = $null; $path = $null
        try { $p = [Diagnostics.Process]::GetProcessById($r.pid); $name = $p.ProcessName; try { $path = $p.MainModule.FileName } catch {}; $p.Dispose() } catch {}
        [void]$out.Add([ordered]@{ port = $Port; family = $r.family; state = $st; pid = $r.pid; process = $name; path = $path; sessionOwned = $null; method = $method })
    }
    return $out.ToArray()
}
function Format-M31PortOwners($Owners) { return (@($Owners | ForEach-Object { [string]$_.process + ' (pid ' + [string]$_.pid + ', ' + [string]$_.state + ')' }) -join ', ') }
function Get-M31Windows([int[]]$Pids) {
    # top-level windows of the given processes plus every window of a Windows security-prompt process (SmartScreen, UAC, credential UI)
    $out = New-Object Collections.ArrayList
    if (-not $script:M31HelperOk) { return $out.ToArray() }
    $prompt = @{}
    foreach ($p in @(Get-Process -Name smartscreen, consent, CredentialUIBroker -ErrorAction SilentlyContinue)) { $prompt[[int]$p.Id] = $p.ProcessName }
    foreach ($w in [EightMaxM31.Win]::Windows()) {
        $wpid = [int]$w[1]
        if (-not ($Pids -contains $wpid) -and -not $prompt.ContainsKey($wpid)) { continue }
        # invisible windows of the tree are kept: a process started hidden shows its FIRST window with SW_HIDE, so a security prompt
        # raised by a hidden start-up script is itself invisible (only windows with a title or a dialog class are listed)
        if ($w[2] -ne '1' -and -not $prompt.ContainsKey($wpid) -and -not $w[4] -and $w[3] -ne ([string][char]35 + '32770')) { continue }
        $pn = $null; try { $pp = [Diagnostics.Process]::GetProcessById($wpid); $pn = $pp.ProcessName; $pp.Dispose() } catch {}
        [void]$out.Add([ordered]@{ hwnd = $w[0]; pid = $wpid; process = $pn; visible = ($w[2] -eq '1'); class = $w[3]; title = $w[4] })
    }
    return $out.ToArray()
}
function Get-M31SecurityPromptFinding($Windows) {
    foreach ($w in @($Windows)) {
        $t = [string]$w.title; $c = [string]$w.class; $pn = [string]$w.process
        if ($pn -eq 'smartscreen' -and $w.visible) { return ('a Windows SmartScreen window is open (' + $t + '): Windows is asking whether the downloaded program may run') }
        if ($c -eq ([string][char]35 + '32770') -and $t -match 'Security Warning|SmartScreen|protected your PC|Open File') { return ('a Windows security dialog is waiting for an answer: ' + $t + ' (' + $pn + ' pid ' + $w.pid + $(if (-not $w.visible) { '; the dialog is INVISIBLE because its process was started hidden, so nobody can answer it' } else { '' }) + ')') }
        if ($pn -eq 'consent' -and $w.visible) { return 'a User Account Control prompt is open' }
    }
    return $null
}
function Get-M31ZoneInfo([string]$Path) {
    # Mark of the Web: the Zone.Identifier stream Windows adds to downloaded files (and to files extracted from a downloaded ZIP)
    if (-not $script:M31IsWindows) { return $null }
    try {
        $t = Get-Content -LiteralPath $Path -Stream Zone.Identifier -ErrorAction Stop | Out-String
        $zone = $null; if ($t -match 'ZoneId=(\d+)') { $zone = [int]$Matches[1] }
        $hostName = $null; if ($t -match 'HostUrl=([a-z]+://[^/\r\n]+)') { $hostName = $Matches[1] }
        return [ordered]@{ zoneId = $zone; zone = $(switch ($zone) { 0 { 'local computer' } 1 { 'local intranet' } 2 { 'trusted sites' } 3 { 'internet' } 4 { 'restricted sites' } default { 'unknown' } }); downloadedFrom = $hostName }
    } catch { return $null }
}
function Get-M31MarkOfTheWeb([string]$Root) {
    $key = @('desktop\bin\EightMaxWorkbench.exe', 'desktop\bin\EightMaxInput.exe', 'desktop\bin\EightMaxTestTable.exe', 'native\mwcli.exe', 'runtime\node\node.exe', 'windows\Start-Desktop.ps1', 'windows\Test-Milestone31.ps1')
    $res = [ordered]@{ checked = $false; keyFiles = [ordered]@{}; marked = 0; scanned = 0; examples = @() }
    if (-not $script:M31IsWindows) { return $res }
    $res.checked = $true
    foreach ($k in $key) { $z = Get-M31ZoneInfo (Join-Path $Root $k); $res.keyFiles[$k] = $(if ($z) { $z } else { 'not marked' }) }
    $ex = New-Object Collections.ArrayList
    foreach ($f in @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\.(exe|dll|ps1|cmd|bat|cjs|js)$' -and $_.FullName -notmatch '[\\/]test-results[\\/]' })) {
        $res.scanned++
        if (Get-M31ZoneInfo $f.FullName) { $res.marked++; if ($ex.Count -lt 5) { [void]$ex.Add((Get-M31RelativePath $f.FullName $Root)) } }
    }
    $res.examples = $ex.ToArray()
    return $res
}
function Get-M31EventEntries([DateTime]$Since, [string[]]$Patterns) {
    # Application errors / .NET runtime errors of EightMax programs, Defender detections and Code Integrity blocks since $Since (bounded)
    if (-not $script:M31IsWindows) { return [ordered]@{ checked = $false } }
    $sb = {
        param($a)
        $fromTime = $a[0]; $pat = $a[1]; $out = @()
        $logs = @(
            @{ name = 'Application'; filter = @{ LogName = 'Application'; StartTime = $fromTime; Level = 1, 2 } },
            @{ name = 'Microsoft-Windows-Windows Defender/Operational'; filter = @{ LogName = 'Microsoft-Windows-Windows Defender/Operational'; StartTime = $fromTime; Id = 1006, 1007, 1008, 1015, 1116, 1117, 1118, 1119, 1121, 1122, 5007 } },
            @{ name = 'Microsoft-Windows-CodeIntegrity/Operational'; filter = @{ LogName = 'Microsoft-Windows-CodeIntegrity/Operational'; StartTime = $fromTime; Level = 1, 2, 3 } },
            @{ name = 'Microsoft-Windows-SmartScreen/Debug'; filter = @{ LogName = 'Microsoft-Windows-SmartScreen/Debug'; StartTime = $since } }
        )
        foreach ($l in $logs) {
            $rec = @{ log = $l.name; readable = $true; error = $null; entries = @() }
            try {
                $ev = @(Get-WinEvent -FilterHashtable $l.filter -MaxEvents 200 -ErrorAction Stop)
                $rec.entries = @($ev | Where-Object { $m = [string]$_.Message; @($pat | Where-Object { $m -like ('*' + $_ + '*') }).Count -gt 0 } | Select-Object -First 20 | ForEach-Object { @{ time = $_.TimeCreated.ToUniversalTime().ToString('o'); id = $_.Id; provider = $_.ProviderName; level = [string]$_.LevelDisplayName; message = ([string]$_.Message).Substring(0, [math]::Min(800, ([string]$_.Message).Length)) } })
            } catch { $msg = $_.Exception.Message; if ($msg -match 'No events were found') { $rec.entries = @() } else { $rec.readable = $false; $rec.error = $msg } }
            $out += $rec
        }
        return $out
    }
    $r = Invoke-M31WithTimeout $sb 25 @($Since, $Patterns)
    return [ordered]@{ checked = $true; timedOut = $r.timedOut; error = $r.error; logs = $r.value }
}
function Get-M31HangDiagnostics([int]$RootPid, [string]$Context) {
    $tree = Get-M31ProcessTree $RootPid
    $pids = [int[]]@($tree.processes | ForEach-Object { [int]$_.pid })
    $wins = @(Get-M31Windows $pids)
    $finding = Get-M31SecurityPromptFinding $wins
    $d = [ordered]@{ at = (Get-M31Now); context = $Context; processTree = $tree; windows = $wins; securityPrompt = $finding; port48713 = @(Get-M31PortOwners 48713 -All) }
    if ($finding) { Write-M31Log ('     FOUND: ' + $finding) 'Red' }
    return $d
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# The run: folder, status, checks, phases, gates, operations, exceptions
# ------------------------------------------------------------------------------------------------------------------------------------------
function Resolve-M31OutputRoot([string]$Requested, [string]$AppRoot) {
    # The default results location is outside the application folder (the immutable release payload). Inside the application folder only
    # test-results\ is allowed. A location that cannot be written falls back to the next one; every refusal is reported.
    $notes = New-Object Collections.ArrayList
    $local = $env:LOCALAPPDATA; if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    $candidates = New-Object Collections.ArrayList
    if ($Requested) { [void]$candidates.Add([ordered]@{ path = $Requested; why = 'requested' }) }
    if ($local) { [void]$candidates.Add([ordered]@{ path = (Join-Path $local 'EightMax-Test-Workbench\TestResults'); why = 'default' }) }
    $tmp = [IO.Path]::GetTempPath(); if ($tmp) { [void]$candidates.Add([ordered]@{ path = (Join-Path $tmp 'EightMax-Test-Workbench\TestResults'); why = 'fallback (TEMP)' }) }
    $userHome = [Environment]::GetFolderPath('UserProfile'); if ($userHome) { [void]$candidates.Add([ordered]@{ path = (Join-Path $userHome 'EightMax-TestResults'); why = 'fallback (user profile)' }) }
    if ($AppRoot) { [void]$candidates.Add([ordered]@{ path = (Join-Path $AppRoot 'test-results'); why = 'last fallback (application test-results folder)' }) }
    foreach ($c in $candidates) {
        $p = $null; try { $p = [IO.Path]::GetFullPath(($c.path -replace '/', [string][IO.Path]::DirectorySeparatorChar)) } catch { [void]$notes.Add('not a usable path: ' + $c.path + ' (' + $_.Exception.Message + ')'); continue }
        if ($AppRoot -and (Test-M31PathInside $p $AppRoot) -and -not (Test-M31PathInside $p (Join-Path $AppRoot 'test-results'))) { [void]$notes.Add('refused ' + $p + ': inside the application folder (the release payload); only its test-results folder may hold results'); continue }
        try {
            [void][IO.Directory]::CreateDirectory($p)
            $probe = Join-Path $p ('.write-test-' + $PID + '.tmp'); [IO.File]::WriteAllText($probe, 'ok'); [IO.File]::Delete($probe)
            return [ordered]@{ path = $p; why = $c.why; notes = $notes.ToArray() }
        } catch { [void]$notes.Add('cannot write to ' + $p + ': ' + $_.Exception.Message) }
    }
    throw ('No writable results location: ' + ($notes -join '; '))
}
function New-M31Run([string]$Mode, [string]$Label, [string]$AppRoot, [string]$OutRoot, [string]$OutDir, [string[]]$PlannedPhases, [string]$RunPathFile, [string]$FaultInjected) {
    $started = [DateTime]::Now
    $rootNotes = @(); $why = 'explicit -OutDir'
    if ($OutDir) {
        $OutDir = [IO.Path]::GetFullPath($OutDir)
        if ($AppRoot -and (Test-M31PathInside $OutDir $AppRoot) -and -not (Test-M31PathInside $OutDir (Join-Path $AppRoot 'test-results'))) { throw ('Refusing -OutDir ' + $OutDir + ': it is inside the application folder (the release payload). Use test-results\ or another folder.') }
        [void][IO.Directory]::CreateDirectory($OutDir); $dir = $OutDir; $outRootUsed = [IO.Path]::GetDirectoryName($OutDir)
    } else {
        $r = Resolve-M31OutputRoot $OutRoot $AppRoot; $outRootUsed = $r.path; $rootNotes = @($r.notes); $why = $r.why
        $base = 'Milestone3.1-' + $started.ToString('yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture) + '-' + $Label
        $dir = Join-Path $outRootUsed $base; $n = 2
        while (Test-Path -LiteralPath $dir) { $dir = Join-Path $outRootUsed ($base + '-' + $n); $n++ }
        [void][IO.Directory]::CreateDirectory($dir)
    }
    [void][IO.Directory]::CreateDirectory((Join-Path $dir 'phases'))
    $runner = [ordered]@{ pid = $PID; processStartTime = $null; powershell = $PSVersionTable.PSVersion.ToString(); edition = [string]$PSVersionTable.PSEdition; is64BitProcess = [Environment]::Is64BitProcess }
    try { $runner.processStartTime = ([Diagnostics.Process]::GetCurrentProcess().StartTime).ToUniversalTime().ToString('o') } catch {}
    $script:M31 = @{
        RunId = [guid]::NewGuid().ToString('N').Substring(0, 12); Mode = $Mode; Label = $Label; AppRoot = $AppRoot; Dir = $dir; OutRoot = $outRootUsed; OutRootWhy = $why; OutRootNotes = $rootNotes
        StartedLocal = $started; StartedAt = $started.ToUniversalTime().ToString('o'); Sw = [Diagnostics.Stopwatch]::StartNew(); Runner = $runner
        Files = @{ Status = (Join-Path $dir 'run-status.json'); Console = (Join-Path $dir 'console.log'); Errors = (Join-Path $dir 'errors.log'); Checks = (Join-Path $dir 'checks.jsonl'); Operations = (Join-Path $dir 'operations.jsonl'); Phases = (Join-Path $dir 'phases') }
        Seq = 0; Checks = (New-Object Collections.ArrayList); Phases = [ordered]@{}; Planned = @($PlannedPhases); Gates = [ordered]@{}
        CurrentPhase = $null; CurrentOperation = $null; LastSuccessfulCheck = $null; CurrentChild = $null; LastExitCode = $null
        State = 'running'; Result = $null; ExitCode = $null; EndedAt = $null; LastStatusWrite = [DateTime]::MinValue; FaultInjected = $FaultInjected; PhaseNo = 0; Notes = (New-Object Collections.ArrayList)
    }
    foreach ($p in $PlannedPhases) { $script:M31.Phases[$p] = [ordered]@{ name = $p; title = $p; status = 'NOT RUN'; startedAt = $null; endedAt = $null; seconds = $null; reason = $null; counts = [ordered]@{ PASS = 0; FAIL = 0; WARNING = 0; SKIPPED = 0 }; categories = @(); file = $null } }
    # the four continuous files exist from the first second of the run
    foreach ($f in @($script:M31.Files.Console, $script:M31.Files.Errors, $script:M31.Files.Checks, $script:M31.Files.Operations)) { if (-not (Test-Path -LiteralPath $f)) { [IO.File]::WriteAllText($f, '') } }
    Add-M31Line $script:M31.Files.Errors ('EightMax 0.36.2 Milestone 3.1 - errors of run ' + $script:M31.RunId + ' (' + $Mode + '), started ' + $started.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture) + '. Empty below this line means: no error.')
    Save-M31Status -Force
    if ($RunPathFile) { try { [IO.File]::WriteAllText($RunPathFile, $dir, $script:M31Utf8) } catch {} }
    return $script:M31
}
function Get-M31StatusDocument {
    $m = $script:M31; $counts = [ordered]@{ PASS = 0; FAIL = 0; WARNING = 0; SKIPPED = 0 }
    foreach ($c in $m.Checks) { $counts[$c.status]++ }
    $cats = [ordered]@{ application = 0; harness = 0; environment = 0; timeout = 0 }
    foreach ($c in $m.Checks) { if ($c.status -eq 'FAIL' -and $c.category -and $cats.Contains($c.category)) { $cats[$c.category]++ } }
    return [ordered]@{
        format = 'eightmax-m31-run-status'; version = 1; app = $script:M31AppVersion; milestone = $script:M31Version; runId = $m.RunId; mode = $m.Mode; label = $m.Label
        state = $m.State; result = $m.Result; exitCode = $m.ExitCode; startedAt = $m.StartedAt; updatedAt = (Get-M31Now); heartbeatAt = (Get-M31Now); endedAt = $m.EndedAt
        elapsedSeconds = [math]::Round($m.Sw.Elapsed.TotalSeconds, 1); runner = $m.Runner; appRoot = $m.AppRoot; resultsFolder = $m.Dir; resultsRoot = $m.OutRoot; resultsRootChoice = $m.OutRootWhy; resultsRootNotes = $m.OutRootNotes
        faultInjected = $m.FaultInjected; currentPhase = $m.CurrentPhase; currentOperation = $m.CurrentOperation; lastSuccessfulCheck = $m.LastSuccessfulCheck; currentChildProcess = $m.CurrentChild; lastExitCode = $m.LastExitCode
        plannedPhases = $m.Planned; phases = @($m.Phases.Values); gates = $m.Gates; counts = $counts; failureCategories = $cats; checksRecorded = $m.Checks.Count
        sessionJob = [ordered]@{ active = $script:M31JobOk; error = $script:M31JobError }; notes = $m.Notes.ToArray()
    }
}
function Save-M31Status([switch]$Force) {
    if (-not $script:M31) { return }
    try { Write-M31AtomicText $script:M31.Files.Status (ConvertTo-M31Json (Get-M31StatusDocument)); $script:M31.LastStatusWrite = [DateTime]::UtcNow } catch { try { Write-M31ErrorLog ('run-status.json could not be written: ' + $_.Exception.Message) } catch {} }
}
function Update-M31Heartbeat([string]$Detail) {
    if (-not $script:M31) { return }
    if ($Detail -and $script:M31.CurrentOperation) { $script:M31.CurrentOperation.progress = $Detail }
    if (([DateTime]::UtcNow - $script:M31.LastStatusWrite).TotalSeconds -ge 5) { Save-M31Status }
}
function Set-M31Gate([string]$Name, [bool]$Ok, [string]$Reason) {
    $script:M31.Gates[$Name] = [ordered]@{ ok = $Ok; reason = $Reason; at = (Get-M31Now); phase = $script:M31.CurrentPhase }
    Save-M31Status
}
function Get-M31GateProblem([string[]]$Needs) {
    foreach ($g in $Needs) {
        if (-not $script:M31.Gates.Contains($g)) { return ('requirement "' + $g + '" was not established (the check that establishes it did not run)') }
        if (-not $script:M31.Gates[$g].ok) { return ('requirement "' + $g + '" failed: ' + [string]$script:M31.Gates[$g].reason) }
    }
    return $null
}
function Add-M31Check([string]$Group, [string]$Name, [string]$Status, [string]$Detail, [string]$Category, [string[]]$Evidence, $Data) {
    # recorded the moment the check completes: checks.jsonl (append), console, errors.log for failures, run-status.json
    $Status = $Status.ToUpperInvariant()
    if ($script:M31Statuses -notcontains $Status) { $Detail = 'invalid status ' + $Status + ' for this check: ' + $Detail; $Status = 'FAIL'; $Category = 'harness' }
    if ($Status -eq 'FAIL' -and -not $Category) { $Category = 'application' }
    if ($Status -ne 'FAIL') { $Category = $null }
    if ([string]::IsNullOrWhiteSpace($Detail)) { $Detail = $(if ($Status -eq 'PASS') { 'passed' } else { 'no detail was produced; see console.log and the files of this phase' }) }
    $m = $script:M31; $m.Seq++
    $rec = [ordered]@{ seq = $m.Seq; at = (Get-M31Now); phase = $m.CurrentPhase; group = $Group; name = $Name; status = $Status; category = $Category; detail = $Detail; operation = $(if ($m.CurrentOperation) { $m.CurrentOperation.name } else { $null }); evidence = @($Evidence | Where-Object { $_ }) }
    if ($null -ne $Data) { $rec.data = $Data }
    [void]$m.Checks.Add($rec)
    Add-M31Line $m.Files.Checks (ConvertTo-M31Json $rec)
    if ($m.CurrentPhase -and $m.Phases.Contains($m.CurrentPhase)) { $m.Phases[$m.CurrentPhase].counts[$Status]++; if ($Category -and -not (@($m.Phases[$m.CurrentPhase].categories) -contains $Category)) { $m.Phases[$m.CurrentPhase].categories = @($m.Phases[$m.CurrentPhase].categories) + $Category } }
    $color = switch ($Status) { 'PASS' { 'Green' } 'WARNING' { 'Yellow' } 'SKIPPED' { 'DarkYellow' } default { 'Red' } }
    $tag = $Status; if ($Category) { $tag = $Status + ' (' + $Category + ')' }
    Write-M31Log ('  [' + $Group + '] ' + $tag + ' ' + $Name + ': ' + $Detail) $color
    if ($Status -eq 'FAIL') { Write-M31ErrorLog ('FAIL (' + $Category + ') [' + $Group + '] ' + $Name + ' | phase ' + [string]$m.CurrentPhase + ' | ' + $Detail) }
    if ($Status -eq 'PASS') { $m.LastSuccessfulCheck = [ordered]@{ seq = $m.Seq; group = $Group; name = $Name; at = $rec.at } }
    Save-M31Status
    return $rec
}
function Get-M31ErrorDetail($ErrorRecord) {
    $m = $script:M31
    $ex = $ErrorRecord.Exception; $inv = $ErrorRecord.InvocationInfo
    $inner = New-Object Collections.ArrayList; $x = $ex.InnerException
    for ($i = 0; $i -lt 5 -and $x; $i++) { [void]$inner.Add(([ordered]@{ type = $x.GetType().FullName; message = $x.Message })); $x = $x.InnerException }
    return [ordered]@{
        at = (Get-M31Now); type = $ex.GetType().FullName; message = $ex.Message; innerExceptions = $inner.ToArray()
        script = $(if ($inv) { $inv.ScriptName } else { $null }); line = $(if ($inv) { $inv.ScriptLineNumber } else { $null }); column = $(if ($inv) { $inv.OffsetInLine } else { $null })
        lineText = $(if ($inv -and $inv.Line) { $inv.Line.Trim() } else { $null }); scriptStackTrace = [string]$ErrorRecord.ScriptStackTrace; dotNetStackTrace = [string]$ex.StackTrace
        errorId = [string]$ErrorRecord.FullyQualifiedErrorId; category = [string]$ErrorRecord.CategoryInfo
        phase = $(if ($m) { $m.CurrentPhase } else { $null }); operation = $(if ($m -and $m.CurrentOperation) { $m.CurrentOperation.name } else { $null })
        lastSuccessfulCheck = $(if ($m) { $m.LastSuccessfulCheck } else { $null }); currentChildProcess = $(if ($m) { $m.CurrentChild } else { $null }); lastExitCode = $(if ($m) { $m.LastExitCode } else { $null })
    }
}
function Add-M31Exception($ErrorRecord, [string]$Group, [string]$Name, [string]$Category = 'harness') {
    $d = Get-M31ErrorDetail $ErrorRecord
    $lines = @(('EXCEPTION ' + $d.type + ': ' + $d.message), ('  where: ' + [string]$d.script + ' line ' + [string]$d.line + ' col ' + [string]$d.column + ': ' + [string]$d.lineText),
        ('  phase: ' + [string]$d.phase + ' | operation: ' + [string]$d.operation + ' | last successful check: ' + $(if ($d.lastSuccessfulCheck) { [string]$d.lastSuccessfulCheck.name } else { '(none)' })),
        ('  child process: ' + $(if ($d.currentChildProcess) { [string]$d.currentChildProcess.name + ' pid ' + [string]$d.currentChildProcess.pid } else { '(none)' }) + ' | last exit code: ' + [string]$d.lastExitCode),
        '  PowerShell stack:', ('    ' + ($d.scriptStackTrace -replace "`r?`n", "`r`n    ")))
    if ($d.dotNetStackTrace) { $lines += '  .NET stack:'; $lines += ('    ' + ($d.dotNetStackTrace -replace "`r?`n", "`r`n    ")) }
    foreach ($i in $d.innerExceptions) { $lines += ('  inner ' + $i.type + ': ' + $i.message) }
    Write-M31ErrorLog ($lines -join "`r`n")
    Add-M31Line $script:M31.Files.Errors ('JSON ' + (ConvertTo-M31Json $d))
    $where = ''; if ($d.script) { $where = ' (' + [IO.Path]::GetFileName([string]$d.script) + ' line ' + [string]$d.line + ')' }
    return (Add-M31Check $Group $Name 'FAIL' ($d.type + ': ' + $d.message + $where) $Category @('errors.log') $d)
}
function Write-M31PhaseFile([string]$Name) {
    $m = $script:M31; $ph = $m.Phases[$Name]
    $idx = [array]::IndexOf(@($m.Phases.Keys), $Name) + 1
    $file = Join-Path $m.Files.Phases (('{0:00}' -f $idx) + '-' + $Name + '.json')
    $ph.file = 'phases/' + [IO.Path]::GetFileName($file)
    $doc = [ordered]@{ format = 'eightmax-m31-phase'; version = 1; runId = $m.RunId } ; foreach ($k in $ph.Keys) { $doc[$k] = $ph[$k] }
    $doc.checks = @($m.Checks | Where-Object { $_.phase -eq $Name })
    Write-M31AtomicText $file (ConvertTo-M31Json $doc)
}
function Complete-M31PhaseRecord([string]$Name, [string]$Forced, [string]$Reason) {
    $m = $script:M31; $ph = $m.Phases[$Name]
    if ($Forced) { $ph.status = $Forced }
    elseif ($ph.counts.FAIL -gt 0) { $ph.status = 'FAIL' }
    elseif ($ph.counts.WARNING -gt 0) { $ph.status = 'WARNING' }
    elseif ($ph.counts.PASS -gt 0) { $ph.status = 'PASS' }
    elseif ($ph.counts.SKIPPED -gt 0) { $ph.status = 'SKIPPED' }
    else { $ph.status = 'WARNING'; $Reason = 'the phase finished without recording a check' }
    if ($Reason) { $ph.reason = $Reason }
    $ph.endedAt = (Get-M31Now)
    if ($ph.startedAt) { $ph.seconds = [math]::Round(([DateTime]::Parse($ph.endedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) - [DateTime]::Parse($ph.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).TotalSeconds, 1) }
    try { Write-M31PhaseFile $Name } catch { Write-M31ErrorLog ('phase file for ' + $Name + ' could not be written: ' + $_.Exception.Message) }
    $m.CurrentPhase = $null; $m.CurrentOperation = $null
    Save-M31Status -Force
    $color = switch ($ph.status) { 'PASS' { 'Green' } 'WARNING' { 'Yellow' } 'SKIPPED' { 'DarkYellow' } 'NOT RUN' { 'DarkGray' } default { 'Red' } }
    Write-M31Log ('---- ' + $Name + ': ' + $ph.status + $(if ($ph.reason) { ' - ' + $ph.reason } else { '' }) + $(if ($null -ne $ph.seconds) { ' (' + (Format-M31Duration $ph.seconds) + ')' } else { '' })) $color
}
function Skip-M31Phase([string]$Name, [string]$Reason, [string]$Status = 'SKIPPED') {
    $m = $script:M31
    if (-not $m.Phases.Contains($Name)) { $m.Phases[$Name] = [ordered]@{ name = $Name; title = $Name; status = 'NOT RUN'; startedAt = $null; endedAt = $null; seconds = $null; reason = $null; counts = [ordered]@{ PASS = 0; FAIL = 0; WARNING = 0; SKIPPED = 0 }; categories = @(); file = $null } }
    $m.Phases[$Name].status = $Status; $m.Phases[$Name].reason = $Reason; $m.Phases[$Name].endedAt = (Get-M31Now)
    try { Write-M31PhaseFile $Name } catch {}
    Save-M31Status -Force
    Write-M31Log ('---- ' + $Name + ': ' + $Status + ' - ' + $Reason) 'DarkYellow'
}
function Invoke-M31Phase([string]$Name, [string]$Title, [string[]]$Needs, [scriptblock]$Body) {
    # one phase: requirements checked first (a phase whose requirement failed is SKIPPED with the reason - never run blindly, never
    # counted as passed); the body's exceptions become harness failures with full details; the result is written immediately.
    $m = $script:M31
    if (-not $m.Phases.Contains($Name)) { Skip-M31Phase $Name 'not part of this mode' 'NOT RUN'; return }
    $m.PhaseNo++
    $ph = $m.Phases[$Name]; $ph.title = $Title
    $problem = Get-M31GateProblem $Needs
    if ($problem) { Skip-M31Phase $Name ('not run because ' + $problem); return }
    Write-M31Log ''
    Write-M31Log ('==== ' + $Title + ' [' + $Name + '] (' + [string]$m.PhaseNo + ' of ' + [string]@($m.Planned).Count + ')') 'Cyan'
    Set-M31Title ($Name + ' (' + [string]$m.PhaseNo + ' of ' + [string]@($m.Planned).Count + ')')
    $m.CurrentPhase = $Name; $ph.startedAt = (Get-M31Now); $ph.status = 'RUNNING'
    Save-M31Status -Force
    $done = $false
    try {
        if ($m.FaultInjected -eq ('exception:' + $Name)) { throw (New-Object InvalidOperationException('Injected test fault: an unexpected exception inside phase ' + $Name + ' (fault injection, -InjectFault)')) }
        if ($m.FaultInjected -eq ('terminate:' + $Name)) { Write-M31Log ('TEST FAULT: the runner terminates itself abruptly inside phase ' + $Name + ' (no cleanup can run)') 'Magenta'; Save-M31Status -Force; [Diagnostics.Process]::GetCurrentProcess().Kill() }
        & $Body
        if ($m.FaultInjected -eq ('check-fail:' + $Name)) { [void](Add-M31Check $Name 'injected failing check (fault injection, -InjectFault)' 'FAIL' 'a test failure injected to verify that completed checks stay saved and the failed check is identified' 'application') }
        $done = $true
    } catch {
        if ($_.Exception -is [Management.Automation.PipelineStoppedException]) { throw }   # Ctrl+C: the phase is INTERRUPTED, not failed
        [void](Add-M31Exception $_ 'harness' ($Name + ' phase ran to completion'))
        $done = $true
    } finally {
        if (-not $done) {
            # Ctrl+C / pipeline stop: the phase did not finish
            $ph.status = 'INTERRUPTED'; $ph.reason = 'stopped while running (Ctrl+C or the runner was stopped)'; $ph.endedAt = (Get-M31Now)
            try { Write-M31PhaseFile $Name } catch {}
            Save-M31Status -Force
        }
    }
    if ($done) { Complete-M31PhaseRecord $Name }
}
function Invoke-M31Operation([string]$Group, [string]$Case, [string]$Op, [string]$Title, [int]$Index, [int]$Total, [int]$TimeoutSec, [scriptblock]$Body) {
    # an instrumented operation: its name and start time are written BEFORE it runs, its outcome right after (operations.jsonl);
    # the body returns @{ status; detail; category; data }. An exception is a harness failure with full details.
    $m = $script:M31
    $opRec = [ordered]@{ name = $Op; title = $Title; case = $Case; index = $Index; total = $Total; startedAt = (Get-M31Now); timeoutSeconds = $TimeoutSec; progress = $null }
    $m.CurrentOperation = $opRec
    Add-M31Line $m.Files.Operations (ConvertTo-M31Json ([ordered]@{ event = 'start'; at = $opRec.startedAt; phase = $m.CurrentPhase; case = $Case; operation = $Op; title = $Title; index = $Index; total = $Total; timeoutSeconds = $TimeoutSec }))
    Save-M31Status -Force
    Write-M31Log ('  [' + $Index + '/' + $Total + '] ' + $Title + ' ...') 'Gray'
    Set-M31Title ($Group + ': ' + $Case + ' ' + $Index + '/' + $Total)
    $sw = [Diagnostics.Stopwatch]::StartNew(); $res = $null
    try { $res = & $Body } catch { if ($_.Exception -is [Management.Automation.PipelineStoppedException]) { throw }; $d = Get-M31ErrorDetail $_; $res = [ordered]@{ status = 'FAIL'; category = 'harness'; detail = ('the test runner failed in this operation: ' + $d.type + ': ' + $d.message + ' (line ' + [string]$d.line + ')'); data = $d } }
    if ($res -is [array]) { $res = $res[$res.Count - 1] }
    if (-not $res) { $res = [ordered]@{ status = 'FAIL'; category = 'harness'; detail = 'the operation returned no result' } }
    $ms = [int]$sw.Elapsed.TotalMilliseconds
    $status = ([string]$res.status).ToUpperInvariant(); if (-not $status) { $status = 'FAIL' }
    $evt = [ordered]@{ event = 'end'; at = (Get-M31Now); phase = $m.CurrentPhase; case = $Case; operation = $Op; status = $status; category = $res.category; ms = $ms; detail = $res.detail }
    Add-M31Line $m.Files.Operations (ConvertTo-M31Json $evt)
    [void](Add-M31Check $Group ($Case + ' - ' + $Index + '/' + $Total + ' ' + $Title) $status ([string]$res.detail + ' [' + (Format-M31Duration ($ms / 1000.0)) + ']') ([string]$res.category) $res.evidence $res.data)
    $m.CurrentOperation = $null
    return [ordered]@{ status = $status; detail = $res.detail; category = $res.category; data = $res.data; ms = $ms }
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Results: document, text report, ZIP (works for a live run and for a recovered, interrupted run)
# ------------------------------------------------------------------------------------------------------------------------------------------
function Read-M31Checks([string]$Dir) {
    $out = New-Object Collections.ArrayList; $bad = 0
    $t = Read-M31Text (Join-Path $Dir 'checks.jsonl')
    foreach ($l in ($t -split "`r?`n")) { if (-not $l.Trim()) { continue }; try { [void]$out.Add(($l | ConvertFrom-Json)) } catch { $bad++ } }
    return [ordered]@{ checks = $out.ToArray(); unreadableLines = $bad }
}
function Get-M31ExitMeaning([int]$Code) {
    switch ($Code) { 0 { 'PASS: every required check passed (warnings, if any, are listed)' } 1 { 'FAIL: one or more tests failed' } 2 { 'HARNESS ERROR: the test runner itself failed; results may be incomplete' } 3 { 'ENVIRONMENT PROBLEM: this computer prevented a valid test (see the failures)' } 4 { 'INTERRUPTED: the run did not finish' } 5 { 'the launcher could not start PowerShell or the test runner' } 6 { 'nothing to package' } default { 'unknown' } }
}
function Get-M31Verdict($Checks, $Phases, [string]$State) {
    if ($State -in @('interrupted', 'cancelled')) { return [ordered]@{ overall = 'INTERRUPTED'; exitCode = 4 } }
    $f = @($Checks | Where-Object { $_.status -eq 'FAIL' })
    if ($f.Count) {
        $cats = @($f | ForEach-Object { [string]$_.category })
        if ($cats -contains 'harness') { return [ordered]@{ overall = 'FAIL'; exitCode = 2 } }
        if (($cats -contains 'environment') -and -not ($cats -contains 'application') -and -not ($cats -contains 'timeout')) { return [ordered]@{ overall = 'FAIL'; exitCode = 3 } }
        return [ordered]@{ overall = 'FAIL'; exitCode = 1 }
    }
    $w = @($Checks | Where-Object { $_.status -eq 'WARNING' }).Count + @($Phases | Where-Object { $_.status -in @('SKIPPED', 'WARNING') }).Count
    if (@($Phases | Where-Object { $_.status -in @('INTERRUPTED') }).Count) { return [ordered]@{ overall = 'INTERRUPTED'; exitCode = 4 } }
    if ($w) { return [ordered]@{ overall = 'WARNING'; exitCode = 0 } }
    if (-not @($Checks | Where-Object { $_.status -eq 'PASS' }).Count) { return [ordered]@{ overall = 'FAIL'; exitCode = 2 } }
    return [ordered]@{ overall = 'PASS'; exitCode = 0 }
}
function Get-M31Advice($Check) {
    $t = [string]$Check.detail + ' ' + [string]$Check.name
    if ($t -match 'port 48713') { return 'Close the program that holds port 48713 (named above) or restart Windows, then run the test again.' }
    if ($t -match 'already running|another EightMax') { return 'Close the EightMax Workbench, its dashboard and any EightMax test window, then run the test again.' }
    if ($t -match 'SmartScreen|security dialog|security prompt|Mark of the Web') { return 'Windows asked for confirmation before starting a downloaded program. See READ-ME-MILESTONE-3.1.txt, section WINDOWS SECURITY PROMPTS.' }
    if ($t -match 'not in the release manifest|differs from its release checksum|missing') { return 'Extract the complete release ZIP again into a NEW, empty folder and run the test from there.' }
    if ([string]$Check.category -eq 'timeout') { return 'An operation exceeded its time limit. The diagnostics of this operation (hang-diagnostics.json, console.log) show where it stopped.' }
    if ([string]$Check.category -eq 'harness') { return 'The test runner itself failed. errors.log has the exception, script line and stack trace.' }
    return ''
}
function New-M31ResultsDocument([string]$Dir, [switch]$Recovered, [string]$RecoveryNote) {
    $st = $null; try { $st = Read-M31JsonFile (Join-Path $Dir 'run-status.json') } catch {}
    $rc = Read-M31Checks $Dir
    $checks = @($rc.checks)
    $phases = @(); if ($st -and $st.phases) { $phases = @($st.phases) }
    $state = $(if ($st) { [string]$st.state } else { 'unknown' })
    $v = Get-M31Verdict $checks $phases $state
    $counts = [ordered]@{ PASS = 0; FAIL = 0; WARNING = 0; SKIPPED = 0; total = $checks.Count }
    foreach ($c in $checks) { if ($counts.Contains([string]$c.status)) { $counts[[string]$c.status]++ } }
    $cats = [ordered]@{ application = 0; harness = 0; environment = 0; timeout = 0 }
    foreach ($c in $checks) { if ($c.status -eq 'FAIL' -and $c.category -and $cats.Contains([string]$c.category)) { $cats[[string]$c.category]++ } }
    $failures = @($checks | Where-Object { $_.status -eq 'FAIL' } | ForEach-Object { [ordered]@{ seq = $_.seq; phase = $_.phase; group = $_.group; name = $_.name; category = $_.category; detail = $_.detail; advice = (Get-M31Advice $_) } })
    $files = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -notmatch '^milestone3-results\.(zip|zip\.partial)$' -and $_.Name -notmatch '^\..*\.tmp$' } | ForEach-Object { Get-M31RelativePath $_.FullName $Dir } | Sort-Object)
    $env = $null; try { $env = Read-M31JsonFile (Join-Path $Dir 'environment.json') } catch {}
    $doc = [ordered]@{
        format = 'eightmax-m31-results'; version = 1; app = $script:M31AppVersion; milestone = $script:M31Version
        runId = $(if ($st) { $st.runId } else { $null }); mode = $(if ($st) { $st.mode } else { $null }); label = $(if ($st) { $st.label } else { $null })
        overall = $v.overall; exitCode = $v.exitCode; exitMeaning = (Get-M31ExitMeaning $v.exitCode); state = $state; recovered = [bool]$Recovered; recoveryNote = $RecoveryNote
        faultInjected = $(if ($st) { $st.faultInjected } else { $null })
        startedAt = $(if ($st) { $st.startedAt } else { $null }); endedAt = $(if ($st -and $st.endedAt) { $st.endedAt } else { (Get-M31Now) }); lastHeartbeat = $(if ($st) { $st.heartbeatAt } else { $null })
        elapsedSeconds = $(if ($st) { $st.elapsedSeconds } else { $null })
        resultsFolder = $Dir; appRoot = $(if ($st) { $st.appRoot } else { $null }); runner = $(if ($st) { $st.runner } else { $null })
        counts = $counts; failureCategories = $cats; phases = $phases; gates = $(if ($st) { $st.gates } else { $null })
        interruptedAt = $(if ($state -eq 'interrupted' -and $st) { [ordered]@{ phase = $st.currentPhase; operation = $st.currentOperation; lastSuccessfulCheck = $st.lastSuccessfulCheck; childProcess = $st.currentChildProcess } } else { $null })
        failures = $failures; checks = $checks; unreadableCheckLines = $rc.unreadableLines
        machine = $(if ($env) { $env.machine } else { $null }); files = $files
    }
    return $doc
}
function Write-M31TextReport($Doc, [string]$Path) {
    $L = New-Object Collections.ArrayList
    $modeName = switch ([string]$Doc.mode) { 'Quick' { 'A - Quick verification' } 'Startup' { 'B - Startup diagnostics' } 'Full' { 'C - Full acceptance' } default { [string]$Doc.mode } }
    [void]$L.Add('EightMax Test Workbench 0.36.2 - Milestone 3.1 Windows test results')
    [void]$L.Add('=====================================================================')
    [void]$L.Add('RESULT:   ' + [string]$Doc.overall + '   (exit code ' + [string]$Doc.exitCode + ': ' + [string]$Doc.exitMeaning + ')')
    if ($Doc.recovered) { [void]$L.Add('NOTE:     this report was rebuilt from the saved progress of a run that did not finish. ' + [string]$Doc.recoveryNote) }
    if ($Doc.faultInjected) { [void]$L.Add('TEST MODE: a fault was injected on purpose (' + [string]$Doc.faultInjected + '); this is not a real result.') }
    [void]$L.Add('Mode:     ' + $modeName + $(if ($Doc.label -and $Doc.label -ne ([string]$Doc.mode).ToLowerInvariant()) { ' (' + [string]$Doc.label + ')' } else { '' }))
    [void]$L.Add('Started:  ' + (Format-M31Time $Doc.startedAt) + $(if ($Doc.state -eq 'interrupted') { '   Did not finish; last sign of life: ' + (Format-M31Time $Doc.lastHeartbeat) } else { '   Ended: ' + (Format-M31Time $Doc.endedAt) }) + $(if ($null -ne $Doc.elapsedSeconds) { '   (' + (Format-M31Duration ([double]$Doc.elapsedSeconds)) + ')' } else { '' }))
    if ($Doc.machine) { $mc = $Doc.machine; [void]$L.Add('Machine:  ' + [string]$mc.windows + ' | ' + [string]$mc.cpu + ' | ' + [string]$mc.ramGiB + ' GiB | display scaling ' + [string]$mc.displayScalingPercent + '% | PowerShell ' + [string]$mc.powershell) }
    [void]$L.Add('Folder:   ' + [string]$Doc.resultsFolder)
    [void]$L.Add('Checks:   ' + [string]$Doc.counts.PASS + ' passed, ' + [string]$Doc.counts.FAIL + ' failed, ' + [string]$Doc.counts.WARNING + ' warnings, ' + [string]$Doc.counts.SKIPPED + ' skipped')
    [void]$L.Add('')
    [void]$L.Add('PHASES')
    foreach ($p in @($Doc.phases)) {
        $c = $p.counts; $cnt = ''; if ($c) { $cnt = ('pass ' + [string]$c.PASS + ', fail ' + [string]$c.FAIL + ', warn ' + [string]$c.WARNING + ', skip ' + [string]$c.SKIPPED) }
        [void]$L.Add(('  {0,-14} {1,-12} {2,-38} {3}' -f [string]$p.name, [string]$p.status, $cnt, $(if ($p.reason) { [string]$p.reason } elseif ($null -ne $p.seconds) { Format-M31Duration ([double]$p.seconds) } else { '' })))
    }
    if ($Doc.interruptedAt) { $ia = $Doc.interruptedAt; [void]$L.Add(''); [void]$L.Add('WHERE THE RUN STOPPED: phase ' + [string]$ia.phase + $(if ($ia.operation) { ', operation ' + [string]$ia.operation.name + ' (started ' + (Format-M31Time $ia.operation.startedAt) + ')' } else { '' }) + $(if ($ia.lastSuccessfulCheck) { '; last successful check: ' + [string]$ia.lastSuccessfulCheck.name } else { '' }) + $(if ($ia.childProcess) { '; child process: ' + [string]$ia.childProcess.name + ' pid ' + [string]$ia.childProcess.pid } else { '' })) }
    [void]$L.Add('')
    if (@($Doc.failures).Count) {
        [void]$L.Add('WHAT FAILED')
        foreach ($f in @($Doc.failures)) { [void]$L.Add('  [' + [string]$f.group + '] FAIL (' + [string]$f.category + ') ' + [string]$f.name); [void]$L.Add('      ' + [string]$f.detail); if ($f.advice) { [void]$L.Add('      What to do: ' + [string]$f.advice) } }
        [void]$L.Add('')
    }
    $warn = @($Doc.checks | Where-Object { $_.status -eq 'WARNING' })
    if ($warn.Count) { [void]$L.Add('WARNINGS'); foreach ($w in $warn) { [void]$L.Add('  [' + [string]$w.group + '] ' + [string]$w.name + ': ' + [string]$w.detail) }; [void]$L.Add('') }
    [void]$L.Add('ALL CHECKS (in the order they completed)')
    foreach ($c in @($Doc.checks)) { [void]$L.Add(('  {0,4} [{1}] {2,-7} {3}: {4}' -f [string]$c.seq, [string]$c.group, ([string]$c.status + $(if ($c.category) { '/' + [string]$c.category } else { '' })), [string]$c.name, [string]$c.detail)) }
    [void]$L.Add('')
    [void]$L.Add('FILES IN THIS FOLDER: ' + [string]@($Doc.files).Count + ' (run-status.json, console.log, errors.log, checks.jsonl, operations.jsonl, phases\, and the logs of every step)')
    [void]$L.Add('Send this file back: ' + (Join-Path ([string]$Doc.resultsFolder) 'milestone3-results.zip'))
    Write-M31AtomicText $Path (($L.ToArray() -join "`r`n") + "`r`n")
}
function New-M31Zip([string]$SourceDir, [string]$ZipPath) {
    # Every file is read with sharing (a log another process still has open is included). A file that cannot be read is listed in
    # zip-skipped-files.txt inside the ZIP instead of failing the whole ZIP. Works for long paths and names with spaces.
    $res = [ordered]@{ ok = $false; path = $ZipPath; entries = 0; skipped = @(); method = 'System.IO.Compression'; error = $null }
    $tmp = $ZipPath + '.partial'
    $skipped = New-Object Collections.ArrayList
    try {
        try { Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop } catch {}
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }
        $errs = $null
        $files = @(Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force -ErrorAction SilentlyContinue -ErrorVariable errs)
        foreach ($e in @($errs)) { if ($e) { [void]$skipped.Add('(listing) ' + [string]$e.Exception.Message) } }
        $fs = New-Object IO.FileStream($tmp, [IO.FileMode]::Create, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
            $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create, $true)
            try {
                foreach ($f in $files) {
                    $full = $f.FullName
                    if ($full -eq [IO.Path]::GetFullPath($ZipPath) -or $full -eq [IO.Path]::GetFullPath($tmp)) { continue }
                    $rel = Get-M31RelativePath $full $SourceDir
                    try {
                        $src = New-Object IO.FileStream($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
                        try {
                            $entry = $zip.CreateEntry($rel, [IO.Compression.CompressionLevel]::Optimal)
                            try { $entry.LastWriteTime = [DateTimeOffset]$f.LastWriteTime } catch {}
                            $es = $entry.Open(); try { $src.CopyTo($es) } finally { $es.Dispose() }
                            $res.entries++
                        } finally { $src.Dispose() }
                    } catch { [void]$skipped.Add($rel + ' : ' + $_.Exception.Message) }
                }
                if ($skipped.Count) {
                    $entry = $zip.CreateEntry('zip-skipped-files.txt'); $es = $entry.Open()
                    try { $b = $script:M31Utf8.GetBytes(('These files could not be added to the ZIP:' + "`r`n" + ($skipped.ToArray() -join "`r`n") + "`r`n")); $es.Write($b, 0, $b.Length) } finally { $es.Dispose() }
                }
            } finally { $zip.Dispose() }
        } finally { $fs.Dispose() }
        if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
        [IO.File]::Move($tmp, $ZipPath)
        $res.ok = $true
    } catch {
        $res.error = $_.Exception.Message
        try {
            # fallback: Compress-Archive (cannot include files another process holds open)
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            Compress-Archive -Path (Join-Path $SourceDir '*') -DestinationPath $ZipPath -Force -ErrorAction Stop
            $res.ok = $true; $res.method = 'Compress-Archive (fallback after: ' + $res.error + ')'
        } catch { $res.error = $res.error + ' | Compress-Archive: ' + $_.Exception.Message }
    }
    $res.skipped = $skipped.ToArray()
    return $res
}
function Complete-M31Run([string]$State = 'completed', [string]$Reason) {
    # writes the final results (JSON, text, ZIP); used at normal completion, after an exception and after Ctrl+C
    $m = $script:M31
    if (-not $m) { return $null }
    foreach ($n in @($m.Phases.Keys)) {
        $p = $m.Phases[$n]
        if ($p.status -eq 'RUNNING') { $p.status = 'INTERRUPTED'; $p.reason = $(if ($Reason) { $Reason } else { 'the run ended while this phase was running' }); $p.endedAt = (Get-M31Now); try { Write-M31PhaseFile $n } catch {} }
        elseif ($p.status -eq 'NOT RUN' -and -not $p.reason) { $p.reason = $(if ($State -ne 'completed') { 'not reached: the run ended early' } else { 'not reached' }) }
    }
    $m.State = $State; $m.EndedAt = (Get-M31Now); $m.CurrentPhase = $null; $m.CurrentOperation = $null
    if ($Reason) { [void]$m.Notes.Add($Reason) }
    $v = Get-M31Verdict @($m.Checks) @($m.Phases.Values) $State
    $m.Result = $v.overall; $m.ExitCode = $v.exitCode
    Save-M31Status -Force
    $doc = $null; $zip = $null
    try {
        $doc = New-M31ResultsDocument $m.Dir
        Write-M31AtomicText (Join-Path $m.Dir 'milestone3-results.json') (ConvertTo-M31Json $doc)
        Write-M31TextReport $doc (Join-Path $m.Dir 'milestone3-results.txt')
    } catch { Write-M31ErrorLog ('the final report could not be written: ' + $_.Exception.Message + ' | ' + $_.ScriptStackTrace); Write-M31Log ('The final report could not be written: ' + $_.Exception.Message) 'Red' }
    $zip = New-M31Zip $m.Dir (Join-Path $m.Dir 'milestone3-results.zip')
    if (-not $zip.ok) { Write-M31ErrorLog ('the results ZIP could not be created: ' + [string]$zip.error) }
    return [ordered]@{ overall = $v.overall; exitCode = $v.exitCode; zip = $zip; document = $doc }
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Earlier runs: detection, interrupted-run recovery, packaging without running tests
# ------------------------------------------------------------------------------------------------------------------------------------------
function Test-M31RunnerAlive($Status) {
    if (-not $Status -or -not $Status.runner -or -not $Status.runner.pid) { return $false }
    try {
        $p = [Diagnostics.Process]::GetProcessById([int]$Status.runner.pid)
        $same = $true
        if ($Status.runner.processStartTime) { try { $same = [math]::Abs(($p.StartTime.ToUniversalTime() - (ConvertTo-M31Date $Status.runner.processStartTime).ToUniversalTime()).TotalSeconds) -lt 3 } catch { $same = $true } }
        $alive = -not $p.HasExited -and $same -and ($p.ProcessName -match '^(powershell|pwsh)$')
        $p.Dispose(); return $alive
    } catch { return $false }
}
function Find-M31Runs([string]$OutRoot, [string]$AppRoot) {
    $roots = New-Object Collections.ArrayList
    foreach ($r in @($OutRoot)) { if ($r -and (Test-Path -LiteralPath $r -PathType Container)) { [void]$roots.Add([ordered]@{ path = $r; kind = 'm31' }) } }
    if ($AppRoot) { $tr = Join-Path $AppRoot 'test-results'; if (Test-Path -LiteralPath $tr -PathType Container) { [void]$roots.Add([ordered]@{ path = $tr; kind = 'app-test-results' }) } }
    $local = $env:LOCALAPPDATA; if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    if ($local) { $lm3 = Join-Path $local 'EightMax-Test-Workbench\Milestone3-0.36.2'; if (Test-Path -LiteralPath $lm3 -PathType Container) { [void]$roots.Add([ordered]@{ path = $lm3; kind = 'm3-local' }) } }
    $runs = New-Object Collections.ArrayList
    foreach ($r in $roots) {
        foreach ($d in @(Get-ChildItem -LiteralPath $r.path -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^(Milestone3\.1-|Milestone3-|Milestone2-|run-)\d{8}-\d{6}' })) {
            $st = $null; try { $st = Read-M31JsonFile (Join-Path $d.FullName 'run-status.json') } catch {}
            $kind = $(if ($st) { 'm31' } else { 'legacy' })
            $alive = $(if ($st) { Test-M31RunnerAlive $st } else { $false })
            $complete = Test-Path -LiteralPath (Join-Path $d.FullName $(if ($kind -eq 'm31') { 'milestone3-results.json' } else { 'milestone3-results.json' }))
            $state = $(if ($st) { [string]$st.state } elseif ($complete) { 'completed' } else { 'no final report' })
            if ($st -and $state -eq 'running' -and -not $alive) { $state = 'running (runner gone: interrupted)' }
            [void]$runs.Add([ordered]@{ path = $d.FullName; name = $d.Name; kind = $kind; state = $state; runnerAlive = $alive; complete = $complete; mode = $(if ($st) { [string]$st.mode } else { $null }); lastWrite = $d.LastWriteTime; zip = $(if (Test-Path -LiteralPath (Join-Path $d.FullName 'milestone3-results.zip')) { Join-Path $d.FullName 'milestone3-results.zip' } else { $null }) })
        }
    }
    return @($runs | Sort-Object -Property @{ Expression = { $_.lastWrite }; Descending = $true })
}
function Get-M31TapFailures([string]$Tap) {
    # the failed tests of a node:test TAP report; a test FILE that stopped without reporting its tests (Node.js ended abnormally,
    # for example exit code 3221226505 = 0xC0000409) is named with its exit code instead of only "test failed"
    $names = @([regex]::Matches([string]$Tap, '(?m)^not ok \d+ - (.+?)\r?$') | ForEach-Object { $_.Groups[1].Value -replace '\\\\', '\' })
    $stopped = @([regex]::Matches([string]$Tap, '(?ms)^not ok \d+ - ([^\r\n]+?\.test\.cjs)\r?\n  ---\r?\n(.*?)^  \.\.\.') | ForEach-Object {
        $x = [regex]::Match($_.Groups[2].Value, 'exitCode: (\d+)')
        if ($x.Success) { ($_.Groups[1].Value -replace '\\\\', '\') + ' stopped with exit code ' + $x.Groups[1].Value + ' (0x' + ('{0:X8}' -f [int64]$x.Groups[1].Value) + ') before reporting its tests' } })
    if ($stopped.Count) { $names = @(@($names | Where-Object { $n0 = $_; -not @($stopped | Where-Object { $_.StartsWith($n0 + ' ') }).Count }) + $stopped) }
    return [ordered]@{ failed = $names; stopped = $stopped }
}
function Get-M31LegacySummary([string]$Dir) {
    # a Milestone 2 / 3 results folder without run-status.json: what is there, read-only
    $s = [ordered]@{ unitTests = $null; phasesWithState = @(); hostStartFiles = 0; files = 0 }
    $tap = Join-Path $Dir 'unit-tests.tap'
    if (Test-Path -LiteralPath $tap) {
        $t = Read-M31Text $tap; $n = { param($k) $ms = [regex]::Matches($t, '(?m)^' + [string][char]35 + ' ' + $k + ' (\d+)\r?$'); if ($ms.Count) { [int]$ms[$ms.Count - 1].Groups[1].Value } else { $null } }
        $s.unitTests = [ordered]@{ tests = (& $n 'tests'); pass = (& $n 'pass'); fail = (& $n 'fail'); skipped = (& $n 'skipped'); failed = @((Get-M31TapFailures $t).failed) }
    }
    $sd = Join-Path $Dir 'state'; if (Test-Path -LiteralPath $sd) { $s.phasesWithState = @(Get-ChildItem -LiteralPath $sd -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object { $_.BaseName }) }
    $s.hostStartFiles = @(Get-ChildItem -LiteralPath $Dir -Filter 'host-*' -File -ErrorAction SilentlyContinue).Count + @(Get-ChildItem -LiteralPath (Join-Path $Dir 'host-start') -Recurse -File -ErrorAction SilentlyContinue).Count
    $s.files = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -ErrorAction SilentlyContinue).Count
    return $s
}
function Complete-M31RecoveredRun([string]$Dir, [string]$Why) {
    # Packages an earlier run WITHOUT running any test. An M3.1 run whose runner is gone is marked INTERRUPTED: a phase that started
    # and did not end is INTERRUPTED, a phase that never started stays NOT RUN; no result is invented.
    $st = $null; try { $st = Read-M31JsonFile (Join-Path $Dir 'run-status.json') } catch {}
    $note = $Why
    if ($st) {
        if (Test-M31RunnerAlive $st) {
            $snap = Join-Path $Dir ('milestone3-snapshot-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture) + '.zip')
            $z = New-M31Zip $Dir $snap
            return [ordered]@{ path = $Dir; zip = $snap; zipOk = $z.ok; overall = 'RUNNING'; note = 'the run is still in progress; a snapshot was packaged and the run was not changed' }
        }
        if ([string]$st.state -eq 'running') {
            $raw = Read-M31Text (Join-Path $Dir 'run-status.json')
            $doc = $raw | ConvertFrom-Json
            # Add-Member -Force: a status file of an older or partial runner may lack a property (setting it directly would throw)
            $set = { param($o, [string]$n, $v) $o | Add-Member -NotePropertyName $n -NotePropertyValue $v -Force }
            & $set $doc 'state' 'interrupted'; & $set $doc 'result' 'INTERRUPTED'; & $set $doc 'exitCode' 4
            foreach ($p in @($doc.phases)) {
                if (-not $p) { continue }
                if ([string]$p.status -eq 'RUNNING') { & $set $p 'status' 'INTERRUPTED'; & $set $p 'reason' ('the runner stopped while this phase was running (process ended, window closed, shutdown or power loss); detected ' + [DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)) }
                elseif ([string]$p.status -eq 'NOT RUN' -and -not $p.reason) { & $set $p 'reason' 'never started: the run ended earlier' }
            }
            $doc | Add-Member -NotePropertyName interruptedDetectedAt -NotePropertyValue (Get-M31Now) -Force
            Write-M31AtomicText (Join-Path $Dir 'run-status.json') (ConvertTo-M31Json $doc)
            $note = 'The runner process ended without finishing (last heartbeat ' + [string]$st.heartbeatAt + '). ' + $Why
        }
        $res = New-M31ResultsDocument $Dir -Recovered -RecoveryNote $note
    } else {
        $sum = Get-M31LegacySummary $Dir
        $res = [ordered]@{
            format = 'eightmax-m31-results'; version = 1; app = $script:M31AppVersion; milestone = $script:M31Version; legacyFolder = $true
            overall = $(if (Test-Path -LiteralPath (Join-Path $Dir 'milestone3-results.json')) { 'see milestone3-results.json of that run' } else { 'INTERRUPTED' }); exitCode = 4; exitMeaning = (Get-M31ExitMeaning 4)
            recovered = $true; recoveryNote = ('A results folder of an older test runner (no run-status.json). Packaged as found; nothing was run. ' + $Why); resultsFolder = $Dir; summaryOfWhatExists = $sum
            phases = @(); checks = @(); failures = @(); counts = [ordered]@{ PASS = 0; FAIL = 0; WARNING = 0; SKIPPED = 0; total = 0 }
        }
        if (-not (Test-Path -LiteralPath (Join-Path $Dir 'milestone3-results.json'))) {
            $res.files = @(Get-ChildItem -LiteralPath $Dir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { Get-M31RelativePath $_.FullName $Dir } | Sort-Object)
        }
    }
    $jsonName = $(if ((Test-Path -LiteralPath (Join-Path $Dir 'milestone3-results.json')) -and -not $st) { 'milestone3-recovery.json' } else { 'milestone3-results.json' })
    Write-M31AtomicText (Join-Path $Dir $jsonName) (ConvertTo-M31Json $res)
    if ($st) { Write-M31TextReport $res (Join-Path $Dir 'milestone3-results.txt') }
    else {
        $u = $res.summaryOfWhatExists.unitTests
        $txt = @('EightMax Test Workbench - results folder of an older test runner, packaged by Milestone 3.1 (no test was run)', ('Folder: ' + $Dir), ('Files: ' + [string]$res.summaryOfWhatExists.files),
            ('Unit tests: ' + $(if ($u) { [string]$u.pass + ' passed, ' + [string]$u.fail + ' failed, ' + [string]$u.skipped + ' skipped of ' + [string]$u.tests + $(if (@($u.failed).Count) { '; failed: ' + (@($u.failed) -join '; ') } else { '' }) } else { 'no unit-tests.tap' })),
            ('Phase state files: ' + $(if (@($res.summaryOfWhatExists.phasesWithState).Count) { @($res.summaryOfWhatExists.phasesWithState) -join ', ' } else { 'none (the run ended before any phase state was written)' })),
            ('Host-start files: ' + [string]$res.summaryOfWhatExists.hostStartFiles), '', [string]$res.recoveryNote)
        Write-M31AtomicText (Join-Path $Dir 'milestone3-recovery.txt') (($txt -join "`r`n") + "`r`n")
    }
    $zipPath = Join-Path $Dir 'milestone3-results.zip'
    if (-not $st -and (Test-Path -LiteralPath $zipPath)) { $zipPath = Join-Path $Dir ('milestone3-results-repackaged-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture) + '.zip') }
    $z = New-M31Zip $Dir $zipPath
    return [ordered]@{ path = $Dir; zip = $zipPath; zipOk = $z.ok; zipError = $z.error; skipped = $z.skipped; overall = $res.overall; note = $note }
}

# ------------------------------------------------------------------------------------------------------------------------------------------
# Environment snapshot (read-only; every query that can block is bounded)
# ------------------------------------------------------------------------------------------------------------------------------------------
function Get-M31RegValue([string]$Key, [string]$Name) { try { return (Get-ItemProperty -Path $Key -Name $Name -ErrorAction Stop).$Name } catch { return $null } }
function Get-M31EnvironmentSnapshot([string]$AppRoot) {
    $e = [ordered]@{ collectedAt = (Get-M31Now); machine = [ordered]@{}; paths = [ordered]@{}; security = [ordered]@{}; powershell = [ordered]@{}; console = [ordered]@{}; session = [ordered]@{}; timeZone = $null }
    $e.powershell = [ordered]@{ version = $PSVersionTable.PSVersion.ToString(); edition = [string]$PSVersionTable.PSEdition; clr = [string]$PSVersionTable.CLRVersion; is64BitProcess = [Environment]::Is64BitProcess; is64BitOs = [Environment]::Is64BitOperatingSystem; languageMode = [string]$ExecutionContext.SessionState.LanguageMode; host = $Host.Name }
    $e.machine.powershell = $PSVersionTable.PSVersion.ToString() + ' ' + [string]$PSVersionTable.PSEdition
    try { $e.timeZone = [TimeZoneInfo]::Local.Id + ' (UTC' + [TimeZoneInfo]::Local.GetUtcOffset([DateTime]::Now).ToString() + ')' } catch {}
    $e.console = [ordered]@{ outputEncoding = $(try { [Console]::OutputEncoding.WebName } catch { $null }); culture = [Globalization.CultureInfo]::CurrentCulture.Name; uiCulture = [Globalization.CultureInfo]::CurrentUICulture.Name }
    $e.session = [ordered]@{ userInteractive = [Environment]::UserInteractive; sessionId = $(try { [Diagnostics.Process]::GetCurrentProcess().SessionId } catch { $null }); isAdministrator = $null }
    if ($script:M31IsWindows) {
        try { $id = [Security.Principal.WindowsIdentity]::GetCurrent(); $e.session.isAdministrator = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch {}
        $q = Invoke-M31WithTimeout {
            $o = @{}
            try { $os = Get-CimInstance Win32_OperatingSystem -OperationTimeoutSec 15; $o.windows = [string]$os.Caption + ' build ' + [string]$os.BuildNumber; $o.windowsVersion = [string]$os.Version; $o.architecture = [string]$os.OSArchitecture; $o.lastBoot = [string]$os.LastBootUpTime } catch { $o.osError = $_.Exception.Message }
            try { $cs = Get-CimInstance Win32_ComputerSystem -OperationTimeoutSec 15; $o.ramGiB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1) } catch {}
            try { $o.cpu = (@(Get-CimInstance Win32_Processor -OperationTimeoutSec 15 | ForEach-Object { [string]$_.Name.Trim() + ' (' + $_.NumberOfCores + ' cores, ' + $_.NumberOfLogicalProcessors + ' threads)' })) -join '; ' } catch {}
            try { $o.gpu = (@(Get-CimInstance Win32_VideoController -OperationTimeoutSec 15 | ForEach-Object { [string]$_.Name + ' (driver ' + [string]$_.DriverVersion + ', ' + [string]$_.CurrentHorizontalResolution + 'x' + [string]$_.CurrentVerticalResolution + ')' })) -join '; ' } catch {}
            try { $o.antivirus = (@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -OperationTimeoutSec 15 -ErrorAction Stop | ForEach-Object { [string]$_.displayName })) -join '; ' } catch { $o.antivirus = 'not available (' + $_.Exception.Message + ')' }
            return $o
        } 45
        if ($q.value) { $v = @($q.value)[0]; foreach ($k in @($v.Keys)) { $e.machine[$k] = $v[$k] } } else { $e.machine.queryError = $q.error }
        try { Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop; $e.machine.screens = @([Windows.Forms.Screen]::AllScreens | ForEach-Object { [string]$_.DeviceName + ' ' + [string]$_.Bounds.Width + 'x' + [string]$_.Bounds.Height + $(if ($_.Primary) { ' (primary)' } else { '' }) }) } catch { $e.machine.screens = @() }
        $dpi = Get-M31RegValue 'HKCU:\Control Panel\Desktop\WindowMetrics' 'AppliedDPI'; $e.machine.displayScalingPercent = $(if ($dpi) { [math]::Round([int]$dpi / 96 * 100) } else { 'unknown' })
        $e.machine.dotNetFrameworkRelease = Get-M31RegValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
        $e.machine.longPathsEnabled = Get-M31RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled'
        $e.machine.ansiCodePage = Get-M31RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage' 'ACP'
        $e.security.smartScreen = [ordered]@{ explorerSetting = (Get-M31RegValue 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer' 'SmartScreenEnabled'); policy = (Get-M31RegValue 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\System' 'EnableSmartScreen') }
        $sac = Get-M31RegValue 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' 'VerifiedAndReputablePolicyState'
        $e.security.smartAppControl = $(switch ($sac) { 0 { 'off' } 1 { 'on' } 2 { 'evaluation' } default { 'unknown' } })
        $mp = Invoke-M31WithTimeout { try { $p = Get-MpPreference -ErrorAction Stop; $s = Get-MpComputerStatus -ErrorAction Stop; return @{ controlledFolderAccess = [string]$p.EnableControlledFolderAccess; realTimeProtection = [bool]$s.RealTimeProtectionEnabled; antivirusEnabled = [bool]$s.AntivirusEnabled; engine = [string]$s.AMEngineVersion } } catch { return @{ error = $_.Exception.Message } } } 25
        $e.security.defender = $(if ($mp.value) { @($mp.value)[0] } else { @{ error = $mp.error } })
        try { $e.security.executionPolicy = [ordered]@{}; foreach ($x in @(Get-ExecutionPolicy -List)) { $e.security.executionPolicy[[string]$x.Scope] = [string]$x.ExecutionPolicy } } catch {}
        $e.security.markOfTheWeb = Get-M31MarkOfTheWeb $AppRoot
        $e.security.defaultTerminal = Get-M31RegValue 'HKCU:\Console\%%Startup' 'DelegationConsole'
    } else {
        $e.machine.windows = [Environment]::OSVersion.VersionString; $e.machine.cpu = [string][Environment]::ProcessorCount + ' logical processors'
    }
    $local = $env:LOCALAPPDATA; if (-not $local) { $local = [Environment]::GetFolderPath('LocalApplicationData') }
    $e.paths = [ordered]@{ appRoot = (Get-M31PathInfo $AppRoot); userProfile = (Get-M31PathInfo ([Environment]::GetFolderPath('UserProfile'))); localAppData = (Get-M31PathInfo $local); temp = (Get-M31PathInfo ([IO.Path]::GetTempPath())); resultsFolder = $(if ($script:M31) { Get-M31PathInfo $script:M31.Dir } else { $null }) }
    try { $d = New-Object IO.DriveInfo(([IO.Path]::GetPathRoot($AppRoot))); $e.paths.appDriveFreeGiB = [math]::Round($d.AvailableFreeSpace / 1GB, 1) } catch {}
    try { if ($script:M31) { $d = New-Object IO.DriveInfo(([IO.Path]::GetPathRoot($script:M31.Dir))); $e.paths.resultsDriveFreeGiB = [math]::Round($d.AvailableFreeSpace / 1GB, 1) } } catch {}
    $protectedFolders = @('Desktop', 'MyDocuments', 'MyPictures', 'MyVideos', 'MyMusic', 'Favorites') | ForEach-Object { [Environment]::GetFolderPath($_) } | Where-Object { $_ }
    $e.paths.appInFolderProtectedByControlledFolderAccess = [bool](@($protectedFolders | Where-Object { Test-M31PathInside $AppRoot $_ }).Count)
    return $e
}
