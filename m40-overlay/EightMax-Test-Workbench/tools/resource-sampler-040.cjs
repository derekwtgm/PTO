'use strict';
/* EightMax Test Workbench 0.36.2 Milestone 4.0: RESOURCE SAMPLER for performance runs - CPU and memory of the processes that take part
 * (desktop host, input driver, test tables, Node) and of the whole machine, plus GPU engine utilisation where Windows exposes it.
 *
 *   const S = require('./resource-sampler-040.cjs').start({ intervalMs: 5000 }); ... const summary = await S.stop();
 *
 * Windows: ONE long-running Windows PowerShell 5.1 process prints a JSON line per interval (Get-Process for the EightMax processes and
 * node, Win32_PerfFormattedData_PerfOS_Processor for the machine, the "GPU Engine" performance counters when they exist). Other
 * platforms: Node's own process only. Measurement only - nothing here changes how the Workbench runs. A sample that cannot be taken is
 * recorded as missing (null), never estimated.
 */
const cp = require('child_process'), os = require('os');
const mono = () => performance.now();
const PS = [
  "$ErrorActionPreference='SilentlyContinue'; $n=[Environment]::ProcessorCount",
  "while ($true) {",
  "  $p=@(Get-Process -Name EightMaxWorkbench,EightMaxInput,EightMaxTestTable,EightMaxWgc,node | ForEach-Object { [ordered]@{ name=$_.ProcessName; id=$_.Id; cpuS=[math]::Round([double]$_.TotalProcessorTime.TotalSeconds,3); ws=[int64]$_.WorkingSet64; priv=[int64]$_.PrivateMemorySize64 } })",
  "  $c=(Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter \"Name='_Total'\").PercentProcessorTime",
  "  $m=Get-CimInstance Win32_OperatingSystem; $g=$null",
  "  try { $s=(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction Stop).CounterSamples; if ($s) { $g=[math]::Round(($s | Measure-Object -Property CookedValue -Sum).Sum,2) } } catch { $g=$null }",
  "  $o=[ordered]@{ t=[DateTime]::UtcNow.ToString('o'); cpuPct=$c; freeMB=[int64]($m.FreePhysicalMemory/1024); totalMB=[int64]($m.TotalVisibleMemorySize/1024); gpu3dPct=$g; cores=$n; procs=$p }",
  "  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)); [Console]::Out.Flush(); Start-Sleep -Milliseconds INTERVAL",
  "}"].join('\n');

function start(o = {}) {
  const intervalMs = Math.max(1000, o.intervalMs || 5000), samples = [], node = [], t0 = mono(); let child = null, buf = '', stopped = false, lastCpu = process.cpuUsage(), lastT = mono();
  const nodeTick = () => { const now = mono(), c = process.cpuUsage(), mem = process.memoryUsage(); node.push({ t: +(now - t0).toFixed(0), cpuPct: +(((c.user - lastCpu.user + c.system - lastCpu.system) / 1000) / Math.max(1, now - lastT) * 100).toFixed(2), rssMB: +(mem.rss / 2 ** 20).toFixed(1), heapMB: +(mem.heapUsed / 2 ** 20).toFixed(1) }); lastCpu = c; lastT = now; if (node.length > 20000) node.shift(); };
  const timer = setInterval(nodeTick, intervalMs); if (timer.unref) timer.unref();
  if (process.platform === 'win32' && o.system !== false) {
    try {
      child = cp.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', PS.replace('INTERVAL', String(intervalMs))], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
      child.stdout.setEncoding('utf8'); child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!l) continue; try { const s = JSON.parse(l); s.rel = +(mono() - t0).toFixed(0); samples.push(s); if (samples.length > 20000) samples.shift(); } catch (e) { /* partial line */ } } });
      child.on('error', () => { child = null; });
    } catch (e) { child = null; }
  }
  async function stop() {
    if (stopped) return summary(); stopped = true; clearInterval(timer); nodeTick();
    if (child) { try { child.kill(); } catch (e) { /* gone */ } await new Promise((r) => { if (!child || child.exitCode !== null) return r(); child.once('exit', r); setTimeout(r, 3000); }); }
    return summary();
  }
  function summary() {
    const st = (a) => { const v = a.filter(Number.isFinite).sort((x, y) => x - y); if (!v.length) return null; const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p / 100 * v.length) - 1))]; return { n: v.length, mean: +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(2), p50: +q(50).toFixed(2), p95: +q(95).toFixed(2), max: +v[v.length - 1].toFixed(2) }; };
    // per process name: CPU % of ONE core between consecutive samples (sum over processes of that name) and the working set
    const byName = {}; for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i], dt = (Date.parse(b.t) - Date.parse(a.t)) / 1000; if (!(dt > 0)) continue; const prev = new Map((a.procs || []).map((p) => [p.id, p]));
      const agg = {}; for (const p of b.procs || []) { const q = prev.get(p.id), x = agg[p.name] || (agg[p.name] = { cpu: 0, ws: 0, count: 0 }); if (q) x.cpu += Math.max(0, p.cpuS - q.cpuS) / dt * 100; x.ws += p.ws; x.count++; }
      for (const [k, x] of Object.entries(agg)) { const r = byName[k] || (byName[k] = { cpuPctOfOneCore: [], workingSetMB: [], processes: [] }); r.cpuPctOfOneCore.push(x.cpu); r.workingSetMB.push(x.ws / 2 ** 20); r.processes.push(x.count); }
    }
    const procs = {}; for (const [k, r] of Object.entries(byName)) procs[k] = { cpuPctOfOneCore: st(r.cpuPctOfOneCore), workingSetMB: st(r.workingSetMB), processes: st(r.processes) };
    const gpu = samples.map((s) => s.gpu3dPct).filter((x) => x !== null && x !== undefined);
    return { format: 'eightmax-resource-samples', version: 1, intervalMs, platform: process.platform, cores: os.cpus().length, ramGiB: +(os.totalmem() / 2 ** 30).toFixed(1), systemSamples: samples.length,
      machineCpuPct: st(samples.map((s) => Number(s.cpuPct))), machineUsedMemoryMB: st(samples.map((s) => s.totalMB - s.freeMB)), gpu3dPct: gpu.length ? st(gpu) : null, gpuNote: gpu.length ? 'GPU Engine 3D utilisation (sum over engines)' : 'no GPU Engine counters on this machine (not available - not zero)',
      processes: procs, node: { cpuPctOfOneCore: st(node.map((x) => x.cpuPct)), rssMB: st(node.map((x) => x.rssMB)), heapMB: st(node.map((x) => x.heapMB)) } };
  }
  return { stop, summary };
}
module.exports = { start };
