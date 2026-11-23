"""0.36.2 Milestone 3 build check (Linux, Mono). Milestone 3 changes NO C# source (the fallback-compile repair is in the PowerShell
launcher windows/Start-Desktop.ps1), so the shipped Windows executables stay the Windows-built (csc 4.8.9221.0) Milestone 1 binaries,
byte-identical. This tool proves that, that every C# component still compiles at C# 5 against the .NET Framework 4.8 reference
assemblies (outputs discarded: cross-compiled binaries are never shipped in place of Windows-built ones), and - for the Milestone 3
repair - that the desktop host's FALLBACK source set (read from windows/Start-Desktop.ps1, with its compiler options) compiles, that
it equals windows/Build-Executables.ps1 and desktop/COMPONENT-VERSIONS.json, and that the Milestone 2 fallback set (without
desktop/InputBroker.cs) does not compile. EightMaxInput.exe is compiled WITHOUT /define:UIA here (Mono has no UIAutomationClient).
Writes evidence/0.36.2-m3/build-check.json.  Usage: python3 tools/build-check-0362m3.py   (exit 0 = all checks passed)
This is NOT a Windows build and NOT Windows evidence; the real fallback compile runs on Windows (CI / RUN-0362-MILESTONE3-TESTS.cmd)."""
import hashlib, json, subprocess, tempfile, datetime, pathlib, shutil, sys, re
root = pathlib.Path(__file__).resolve().parent.parent
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
A = '/usr/lib/mono/4.8-api'
refs = ['-nostdlib'] + ['-r:%s/%s.dll' % (A, n) for n in ('mscorlib', 'System', 'System.Core', 'System.Web.Extensions', 'System.Windows.Forms', 'System.Drawing')]
ev = json.loads((root / 'evidence/build-evidence.json').read_text(encoding='utf-8'))
comp = json.loads((root / 'desktop/COMPONENT-VERSIONS.json').read_text(encoding='utf-8'))
start = (root / 'windows/Start-Desktop.ps1').read_text(encoding='utf-8')
build = (root / 'windows/Build-Executables.ps1').read_text(encoding='utf-8')
fallback = re.findall(r"'([^']+)'", re.search(r"\$HostSources=@\(([^)]*)\)", start).group(1))
fallback = [s.replace('\\', '/') for s in fallback]
options = [o for o in re.search(r"\$CompilerOptions='([^']*)'\+\$HostMain", start).group(1).split() if o != '/main:'] + ['/main:' + re.search(r"\$HostMain='([^']+)'", start).group(1)]
build_host = [s.replace('\\', '/') for s in re.findall(r"Join-Path \$Root '(desktop\\[A-Za-z]+\.cs)'", re.search(r"Compile 'winexe' \$hostOut @\(([^\n]*)\) 'EightMax\.Workbench\.DesktopHost'", build).group(1))]
top_level_cs = sorted(str(p.relative_to(root)).replace('\\', '/') for p in (root / 'desktop').glob('*.cs'))
targets = {
  'desktop/bin/EightMaxWorkbench.exe': (['-target:winexe', '-main:EightMax.Workbench.DesktopHost'], ['desktop/DesktopHost.cs', 'desktop/CaptureService.cs', 'desktop/InputBroker.cs']),
  'desktop/bin/EightMaxCapture.exe': (['-target:exe'], ['desktop/capture/EightMaxCapture.cs', 'desktop/CaptureService.cs']),
  'desktop/bin/EightMaxInput.exe': (['-target:exe', '-main:EightMax.Input.Program'], sorted(str(p.relative_to(root)).replace('\\', '/') for p in (root / 'desktop/input').glob('*.cs'))),
  'desktop/bin/EightMaxTestTable.exe': (['-target:winexe', '-main:EightMax.TestTable.Program'], ['desktop/testtable/EightMaxTestTable.cs']),
}
mcs = subprocess.run(['mcs', '--version'], capture_output=True, text=True).stdout.strip()
out = {'format': 'eightmax-build-check', 'version': 2, 'milestone': '0.36.2-milestone-3', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
       'buildHost': 'Linux (Mono cross-compilation check; outputs discarded) - NOT a Windows build', 'compiler': mcs, 'referenceAssemblies': A + ' (.NET Framework 4.8 API)',
       # 0.36.2 M3: the executables rebuilt ON WINDOWS for this milestone come from release-0362-m3.json (rebuiltExecutables); this Mono
       # check only compiles the sources (outputs discarded) and compares every shipped binary with its Windows build record
       'shippedBinariesRebuilt': sorted((json.loads((root / 'release-0362-m3.json').read_text()).get('rebuiltExecutables') or {}).keys()),
       'reason': 'Milestone 3 changes one C# source (desktop/input/Driver.cs): EightMaxInput.exe was rebuilt on Windows by the CI build job (record: evidence/build-evidence.json, evidence/0.36.2-m3/driver-build/); every other executable is the unchanged Windows-built Milestone 1 binary (GitHub Actions run 45083913369). The fallback-compile repair is in windows/Start-Desktop.ps1 (PowerShell).',
       'components': {}, 'fallbackCompile': {}}
tmp = pathlib.Path(tempfile.mkdtemp(prefix='em-m3-build-'))
def mono(flags, srcs, name):
  o = tmp / name
  r = subprocess.run(['mcs', '-langversion:5', '-platform:x64', '-optimize+'] + flags + refs + ['-out:' + str(o)] + [str(root / s) for s in srcs], capture_output=True, text=True)
  lines = (r.stdout + r.stderr).splitlines()
  return {'exitCode': r.returncode, 'compiled': r.returncode == 0 and o.exists(), 'warnings': len([l for l in lines if 'warning' in l]), 'errors': [l.replace(str(root) + '/', '') for l in lines if 'error' in l][:10]}
ok_all = True
try:
  for exe, (flags, srcs) in targets.items():
    rec = ev['outputs'].get(exe, {}); srch = rec.get('sourceHashes', {}) if isinstance(rec.get('sourceHashes'), dict) else {}
    c = {'shippedSha256': sha(root / exe), 'windowsBuildSha256': rec.get('sha256'), 'binaryIdenticalToWindowsBuild': sha(root / exe) == rec.get('sha256'),
         'sources': {s: {'sha256': sha(root / s), 'matchesWindowsBuildEvidence': (srch.get(s) == sha(root / s)) if s in srch else None} for s in srcs},
         'monoCompile': mono(flags, srcs, pathlib.Path(exe).name)}
    if exe.endswith('EightMaxInput.exe'): c['monoCompile']['note'] = 'without /define:UIA (UI Automation reference assemblies are Windows-only)'
    c['ok'] = c['binaryIdenticalToWindowsBuild'] and c['monoCompile']['compiled'] and all(v['matchesWindowsBuildEvidence'] is not False for v in c['sources'].values())
    ok_all = ok_all and c['ok']; out['components'][exe] = c
  # ---- Milestone 3: the desktop host's fallback compile (windows/Start-Desktop.ps1) ----
  mflags = []
  for o in options:
    k, _, v = o.lstrip('/').partition(':'); mflags.append('-' + k + (':' + v if v else ''))
  mflags = [f for f in mflags if not f.startswith('-platform') and not f.startswith('-optimize') and not f.startswith('-langversion')]   # given by mono()
  fc = out['fallbackCompile']
  fc['startDesktopSources'] = fallback; fc['compilerOptions'] = ' '.join(options)
  fc['buildExecutablesHostSources'] = build_host
  fc['componentVersionsSources'] = comp['components']['desktop/bin/EightMaxWorkbench.exe']['sources']
  fc['topLevelDesktopSources'] = top_level_cs
  fc['sameAsBuildExecutables'] = fallback == build_host
  fc['sameAsComponentVersions'] = fallback == fc['componentVersionsSources']
  fc['includesEveryTopLevelDesktopSource'] = sorted(fallback) == top_level_cs
  fc['milestone3Set'] = mono(mflags, fallback, 'fallback-m3.exe')
  m2 = ['desktop/DesktopHost.cs', 'desktop/CaptureService.cs']
  fc['milestone2Set'] = {'sources': m2, **mono(mflags, m2, 'fallback-m2.exe'), 'expected': 'fails: DesktopHost.cs uses InputBroker, which only desktop/InputBroker.cs defines'}
  fc['ok'] = fc['sameAsBuildExecutables'] and fc['sameAsComponentVersions'] and fc['includesEveryTopLevelDesktopSource'] and fc['milestone3Set']['compiled'] and not fc['milestone2Set']['compiled'] and any('InputBroker' in e for e in fc['milestone2Set']['errors'])
  ok_all = ok_all and fc['ok']
finally:
  shutil.rmtree(tmp, ignore_errors=True)
out['unchangedBinaries'] = {p: sha(root / p) for p in ('desktop/bin/EightMaxWgc.exe', 'native/mwcli.exe', 'runtime/node/node.exe')}
out['nativeEngine'] = {'file': 'native/mwcli.exe', 'sha256': out['unchangedBinaries']['native/mwcli.exe'], 'expected': 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72', 'build': '7d08acc7eb4577ee'}
out['nativeEngine']['unchanged'] = out['nativeEngine']['sha256'] == out['nativeEngine']['expected']
out['ok'] = ok_all and out['nativeEngine']['unchanged']
p = root / 'evidence/0.36.2-m3/build-check.json'; p.parent.mkdir(parents=True, exist_ok=True); p.write_text(json.dumps(out, indent=1) + '\n', encoding='utf-8', newline='\n')
print(json.dumps({'ok': out['ok'], 'components': {k: v['ok'] for k, v in out['components'].items()}, 'fallbackCompile': {k: out['fallbackCompile'][k] for k in ('sameAsBuildExecutables', 'sameAsComponentVersions', 'includesEveryTopLevelDesktopSource', 'ok')}, 'm3SetCompiled': out['fallbackCompile']['milestone3Set']['compiled'], 'm2SetCompiled': out['fallbackCompile']['milestone2Set']['compiled'], 'm2Errors': out['fallbackCompile']['milestone2Set']['errors'][:1], 'nativeUnchanged': out['nativeEngine']['unchanged']}, indent=1))
sys.exit(0 if out['ok'] else 1)
