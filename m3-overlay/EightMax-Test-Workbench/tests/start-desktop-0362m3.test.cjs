'use strict';
// 0.36.2 Milestone 3: windows/Start-Desktop.ps1 fallback compile. Static checks that run everywhere (the real fallback compile, cache reuse,
// invalid-cache recovery and shutdown run on Windows: windows/Test-Milestone3-0362.ps1 / .github/workflows/windows-0362-m3.yml), plus a Mono
// compile of the exact fallback source set and options when Mono is installed.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), cp = require('child_process'), os = require('os');
const ROOT = path.join(__dirname, '..'), read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const start = read('windows/Start-Desktop.ps1'), build = read('windows/Build-Executables.ps1'), comp = JSON.parse(read('desktop/COMPONENT-VERSIONS.json'));
const fallback = [...start.match(/\$HostSources=@\(([^)]*)\)/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/\\/g, '/'));
const buildHost = [...build.match(/Compile 'winexe' \$hostOut @\(([^\n]*)\) 'EightMax\.Workbench\.DesktopHost'/)[1].matchAll(/Join-Path \$Root '(desktop\\[A-Za-z]+\.cs)'/g)].map((m) => m[1].replace(/\\/g, '/'));

test('M3 fallback compile: every desktop-host source is compiled (InputBroker.cs included), the same list as the Windows build and the component record', () => {
  assert.deepEqual(fallback, ['desktop/DesktopHost.cs', 'desktop/CaptureService.cs', 'desktop/InputBroker.cs']);
  assert.deepEqual(fallback, buildHost, 'Start-Desktop.ps1 and Build-Executables.ps1 compile the same host sources');
  assert.deepEqual(fallback, comp.components['desktop/bin/EightMaxWorkbench.exe'].sources, 'and COMPONENT-VERSIONS.json records them');
  const topLevel = fs.readdirSync(path.join(ROOT, 'desktop')).filter((f) => f.endsWith('.cs')).map((f) => 'desktop/' + f).sort();
  assert.deepEqual([...fallback].sort(), topLevel, 'every top-level desktop/*.cs file belongs to the host and is compiled');
  assert.match(start, /\$CompilerOptions='\/target:winexe \/platform:x64 \/optimize\+ \/langversion:5 \/main:'\+\$HostMain/); assert.match(start, /\$HostMain='EightMax\.Workbench\.DesktopHost'/);
  assert.match(start, /\$texts=\[string\[\]\]@\(\$HostSources\|ForEach-Object/, 'the compiler is given the texts of ALL host sources');
});

test('M3 fallback cache: the identity covers format, options, references, runtime and every source hash; a cached executable is reused only after its hash and manifest match', () => {
  const id = start.match(/\$identity=([^\n]*)/)[1];
  for (const part of ['$CacheFormat', '$CompilerOptions', '$refNames', '[Environment]::Version', '$sourceList']) assert.ok(id.includes(part), 'fingerprint includes ' + part);
  assert.match(start, /\$CacheFormat='eightmax-desktop-cache-v2'/, 'a new cache format: Milestone 2 cache folders (two-source key) are never looked up');
  assert.match(start, /\$cache=Join-Path \$CacheRoot \$fingerprint/);
  for (const why of ['no cached executable', 'compiler-output.sha256 missing', 'cached executable does not match its recorded hash', 'cache-manifest.json missing', 'cache manifest does not describe the current sources', 'cache manifest sources differ']) assert.ok(start.includes(why), 'invalid-cache reason: ' + why);
  assert.match(start, /if\(\$rebuild -and \(Test-Path -LiteralPath \$exe -PathType Leaf\)\)\{ \$status\.invalidCache=\$why; try\{Remove-Item -LiteralPath \$exe -Force\}/, 'an invalid cached executable is removed before rebuilding');
  assert.match(start, /Write-WorkbenchUtf8 \$manifest/, 'a manifest is written with every compile');
});

test('M3 launcher safety: release verification runs before any compile or launch; the fallback keeps -Headless; the script is plain ASCII for Windows PowerShell 5.1', () => {
  const verify = start.indexOf('Get-WorkbenchHashFailures $root'), compile = start.indexOf('CompileAssemblyFromSource'), launch = start.indexOf('Start-Process -FilePath $exe');
  assert.ok(verify > 0 && verify < compile && verify < launch, 'SHA256SUMS verification first');
  assert.match(start, /\$fallbackArgs=@\{ ForceCompile=\$true; ReadyFile=\$ReadyFile; Headless=\[bool\]\$Headless \}/);
  assert.equal((start.match(/& \$PSCommandPath @fallbackArgs/g) || []).length, 2, 'both fallback paths (start failure, not ready) pass the same arguments');
  assert.ok(![...start].some((ch) => ch.charCodeAt(0) > 127), 'no non-ASCII character (the file has no BOM)');
  assert.ok(!/\[pscustomobject\]/i.test(start), 'status records are dictionaries (JavaScriptSerializer cannot serialise PSCustomObject on PowerShell 5.1)');
});

const mono = (() => { try { cp.execFileSync('mcs', ['--version'], { stdio: 'ignore' }); return fs.existsSync('/usr/lib/mono/4.8-api/mscorlib.dll'); } catch (e) { return false; } })();
test('M3 fallback source set compiles with the launcher options (Mono, .NET Framework 4.8 API); the Milestone 2 set does not', { skip: mono ? false : 'needs Mono (mcs) with the 4.8 reference assemblies' }, () => {
  const A = '/usr/lib/mono/4.8-api', refs = ['-nostdlib', ...['mscorlib', 'System', 'System.Core', 'System.Web.Extensions', 'System.Windows.Forms', 'System.Drawing'].map((n) => '-r:' + A + '/' + n + '.dll')];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-m3-fallback-'));
  const run = (srcs, out) => cp.spawnSync('mcs', ['-langversion:5', '-platform:x64', '-optimize+', '-target:winexe', '-main:EightMax.Workbench.DesktopHost', ...refs, '-out:' + path.join(dir, out), ...srcs.map((s) => path.join(ROOT, s))], { encoding: 'utf8' });
  try {
    const m3 = run(fallback, 'm3.exe'); assert.equal(m3.status, 0, m3.stdout + m3.stderr);
    const m2 = run(['desktop/DesktopHost.cs', 'desktop/CaptureService.cs'], 'm2.exe'); assert.notEqual(m2.status, 0); assert.match(m2.stdout + m2.stderr, /InputBroker/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
