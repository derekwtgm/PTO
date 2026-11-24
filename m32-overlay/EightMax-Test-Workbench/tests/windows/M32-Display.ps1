<# EightMax Test Workbench 0.36.2 Milestone 3.2 - Windows CI helper: set the TEST desktop's resolution and display scaling, and report what
   was actually achieved (JSON). Used only by .github/workflows/windows-0362-m32.yml on a disposable GitHub-hosted runner; never by the
   operator launchers. The operator PC runs at 3840 x 2160 and 125 %; Milestone 3.1 CI could only test 100 %.

     powershell -File tests\windows\M32-Display.ps1 -Width 1920 -Height 1080 -ScalePercent 125 -Out display.json

   Resolution: ChangeDisplaySettings. Scaling: DisplayConfigSetDeviceInfo with the per-monitor DPI-scale request the Windows Settings app
   uses (device-info types -3 get / -4 set; relative to the monitor's recommended scale). Neither needs a sign-out. If the virtual display
   refuses, the result says so and the job continues at the scaling it has: the report never claims a scaling that was not measured.
   Measured after the change: the DPI of the primary monitor (GetDpiForMonitor, per-monitor aware) and the system DPI. ASCII only. #>
param([int]$Width = 1920, [int]$Height = 1080, [int]$ScalePercent = 100, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class EmM32Display {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName; public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput; public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName; public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
  [DllImport("user32.dll")] static extern bool EnumDisplaySettings(string d, int m, ref DEVMODE dm);
  [DllImport("user32.dll")] static extern int ChangeDisplaySettings(ref DEVMODE dm, int f);
  public static int SetResolution(int w, int h) { DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); EnumDisplaySettings(null, -1, ref dm); dm.dmPelsWidth = w; dm.dmPelsHeight = h; dm.dmFields = 0x80000 | 0x100000; return ChangeDisplaySettings(ref dm, 0); }
  public static int[] CurrentResolution() { DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); EnumDisplaySettings(null, -1, ref dm); return new int[] { dm.dmPelsWidth, dm.dmPelsHeight }; }

  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct SOURCE { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct TARGET { public LUID adapterId; public uint id; public uint modeInfoIdx; public int outputTechnology; public int rotation; public int scaling; public uint refreshNum; public uint refreshDen; public int scanLineOrdering; public int targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH { public SOURCE sourceInfo; public TARGET targetInfo; public uint flags; }
  [StructLayout(LayoutKind.Sequential, Size = 64)] public struct MODE { public int infoType; public uint id; public LUID adapterId; }
  [StructLayout(LayoutKind.Sequential)] public struct HEADER { public int type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential)] public struct DPI_GET { public HEADER header; public int minScaleRel; public int curScaleRel; public int maxScaleRel; }
  [StructLayout(LayoutKind.Sequential)] public struct DPI_SET { public HEADER header; public int scaleRel; }
  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PATH[] paths, ref uint numModes, [Out] MODE[] modes, IntPtr topology);
  [DllImport("user32.dll")] static extern int DisplayConfigGetDeviceInfo(ref DPI_GET packet);
  [DllImport("user32.dll")] static extern int DisplayConfigSetDeviceInfo(ref DPI_SET packet);
  static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };
  /// <summary>Set every active display source to `percent` (relative to its recommended scale). Returns one line per source.</summary>
  public static string[] SetScale(int percent) {
    uint np, nm; int rc = GetDisplayConfigBufferSizes(2, out np, out nm); if (rc != 0) return new string[] { "GetDisplayConfigBufferSizes failed " + rc };
    PATH[] paths = new PATH[np]; MODE[] modes = new MODE[nm]; rc = QueryDisplayConfig(2, ref np, paths, ref nm, modes, IntPtr.Zero); if (rc != 0) return new string[] { "QueryDisplayConfig failed " + rc };
    int want = Array.IndexOf(Steps, percent); if (want < 0) return new string[] { "unsupported percent " + percent };
    string[] lines = new string[np];
    for (int i = 0; i < np; i++) {
      DPI_GET g = new DPI_GET(); g.header.type = -3; g.header.size = (uint)Marshal.SizeOf(typeof(DPI_GET)); g.header.adapterId = paths[i].sourceInfo.adapterId; g.header.id = paths[i].sourceInfo.id;
      int gr = DisplayConfigGetDeviceInfo(ref g); if (gr != 0) { lines[i] = "source " + i + ": get failed " + gr; continue; }
      int recommended = -g.minScaleRel, rel = want - recommended;   // the minimum is always 100 %: its distance from the recommended step
      if (rel < g.minScaleRel || rel > g.maxScaleRel) { lines[i] = "source " + i + ": " + percent + "% outside the allowed range (" + Steps[Math.Max(0, recommended + g.minScaleRel)] + "-" + Steps[Math.Min(Steps.Length - 1, recommended + g.maxScaleRel)] + "%), current " + Steps[Math.Max(0, Math.Min(Steps.Length - 1, recommended + g.curScaleRel))] + "%"; continue; }
      DPI_SET s = new DPI_SET(); s.header.type = -4; s.header.size = (uint)Marshal.SizeOf(typeof(DPI_SET)); s.header.adapterId = paths[i].sourceInfo.adapterId; s.header.id = paths[i].sourceInfo.id; s.scaleRel = rel;
      int sr = DisplayConfigSetDeviceInfo(ref s);
      DPI_GET g2 = g; g2.header.type = -3; DisplayConfigGetDeviceInfo(ref g2);
      lines[i] = "source " + i + ": set " + percent + "% (relative " + rel + ") returned " + sr + "; now " + Steps[Math.Max(0, Math.Min(Steps.Length - 1, recommended + g2.curScaleRel))] + "% (recommended " + Steps[Math.Max(0, Math.Min(Steps.Length - 1, recommended))] + "%)";
    }
    return lines;
  }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr mon, int type, out uint dx, out uint dy);
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x, y; }
  /// <summary>Effective DPI of the primary monitor as a per-monitor-aware thread sees it, and the system DPI.</summary>
  public static uint[] MeasuredDpi() { IntPtr old = SetThreadDpiAwarenessContext(new IntPtr(-4)); try { POINT p = new POINT(); IntPtr m = MonitorFromPoint(p, 1); uint dx, dy; int r = GetDpiForMonitor(m, 0, out dx, out dy); return new uint[] { r == 0 ? dx : 0, GetDpiForSystem() }; } finally { SetThreadDpiAwarenessContext(old); } }
}
"@
$res = [ordered]@{ format = 'eightmax-m32-ci-display'; version = 1; requested = [ordered]@{ width = $Width; height = $Height; scalePercent = $ScalePercent }; before = $null; resolutionResult = $null; scaleResult = @(); after = $null }
$d0 = [EmM32Display]::MeasuredDpi(); $r0 = [EmM32Display]::CurrentResolution()
$res.before = [ordered]@{ width = $r0[0]; height = $r0[1]; monitorDpi = $d0[0]; scalePercent = [math]::Round($d0[0] / 96.0 * 100) }
$rc = [EmM32Display]::SetResolution($Width, $Height); $res.resolutionResult = 'ChangeDisplaySettings returned ' + $rc + $(if ($rc -eq 0) { ' (DISP_CHANGE_SUCCESSFUL)' } elseif ($rc -eq -2) { ' (DISP_CHANGE_BADMODE: the virtual display does not offer this mode)' } else { '' })
Start-Sleep -Seconds 2
if ($ScalePercent -ne 100 -or $res.before.scalePercent -ne 100) { $res.scaleResult = @([EmM32Display]::SetScale($ScalePercent)); Start-Sleep -Seconds 3 }
$d1 = [EmM32Display]::MeasuredDpi(); $r1 = [EmM32Display]::CurrentResolution()
$res.after = [ordered]@{ width = $r1[0]; height = $r1[1]; monitorDpi = $d1[0]; systemDpi = $d1[1]; scalePercent = [math]::Round($d1[0] / 96.0 * 100) }
$res.achieved = [ordered]@{ resolution = ($r1[0] -eq $Width -and $r1[1] -eq $Height); scaling = ($res.after.scalePercent -eq $ScalePercent) }
$json = $res | ConvertTo-Json -Depth 5
if ($Out) { [IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false))) }
$json
