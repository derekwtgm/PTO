"""0.36.2 Milestone 3: take the Windows-built input driver into the package and record it.

Usage: python3 -I tools/record-driver-build-0362m3.py DIR
DIR is the driver-build/ folder that .github/workflows/windows-0362-m3-driver-build.yml published to branch m3-results/<run id>:
bin/EightMaxInput.exe, driver-build.json (this job's record), build-evidence-ci.json (windows\\Build-Executables.ps1's own record), build.log.

Refuses unless: the executable's SHA-256 equals both records, the job compiled exactly the shipped desktop/input/*.cs (same SHA-256),
the build ran on Windows with the .NET Framework 4.x compiler and the record names a CI run. Then it
  * copies the executable to desktop/bin/EightMaxInput.exe,
  * replaces the EightMaxInput.exe entry of evidence/build-evidence.json with the CI entry (+ where and when it was rebuilt) and appends
    a 'rebuilds' record; every other entry (the Milestone 1 Windows build of the unchanged executables) is kept as it is,
  * keeps the raw CI records in evidence/0.36.2-m3/driver-build/,
  * records the rebuild in release-0362-m3.json (executables, windowsBinariesRebuilt, rebuiltExecutables),
  * regenerates desktop/COMPONENT-VERSIONS.json (tools/make-components.py) and SHA256SUMS.txt (tools/make-manifest.py).
A Windows CI claim for the new file appears only once evidence/windows-ci-runs.json lists a run of this exact SHA-256."""
import hashlib, json, shutil, subprocess, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src = Path(sys.argv[1]).resolve()
EXE = 'desktop/bin/EightMaxInput.exe'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
def load(p): return json.loads(Path(p).read_text(encoding='utf-8-sig'))
def fail(m): raise SystemExit('refused: ' + m)

exe = src / 'bin' / 'EightMaxInput.exe'
rec, ci_ev = load(src / 'driver-build.json'), load(src / 'build-evidence-ci.json')
h = sha(exe)
if rec.get('sha256') != h: fail('driver-build.json names ' + str(rec.get('sha256')) + ', the executable is ' + h)
ci_out = ci_ev.get('outputs', {}).get(EXE) or fail('build-evidence-ci.json has no ' + EXE)
if ci_out.get('sha256') != h: fail('build-evidence-ci.json names ' + str(ci_out.get('sha256')) + ' for ' + EXE)
if not str(ci_ev.get('buildHost', '')).startswith('Windows'): fail('not built on Windows: ' + str(ci_ev.get('buildHost')))
if 'Visual C# Compiler' not in str(ci_out.get('compiler', '')) or ci_out.get('crossCompiled') is not False: fail('unexpected compiler ' + str(ci_out.get('compiler')))
run_id = str((rec.get('ci') or {}).get('runId') or '')
if not run_id.isdigit() or str((ci_ev.get('ci') or {}).get('runId')) != run_id: fail('no matching CI run id in the records')
shipped = {s: sha(root / s) for s in sorted('desktop/input/' + p.name for p in (root / 'desktop/input').glob('*.cs'))}
if ci_out.get('sourceHashes') != shipped: fail('the CI build compiled other sources than the shipped desktop/input/*.cs: ' + json.dumps({'ci': ci_out.get('sourceHashes'), 'shipped': shipped}))
if rec.get('sourceHashes') != shipped: fail('driver-build.json source hashes differ from the shipped sources')
if '0.36.2-dev' not in str(rec.get('versionOutput', '')): fail('unexpected --version output ' + str(rec.get('versionOutput')))

# 1. the executable
old = sha(root / EXE); shutil.copyfile(exe, root / EXE)
# 2. build evidence: only the input driver's entry changes
ev_path = root / 'evidence/build-evidence.json'; ev = load(ev_path)
entry = dict(ci_out); entry['rebuiltIn'] = {'milestone': '0.36.2-milestone-3', 'reason': 'desktop/input/Driver.cs changed (cursor bookkeeping after an operation the driver stopped part-way; Windows CI run 45203097931)',
                                           'ci': ci_ev.get('ci'), 'builtAt': ci_ev.get('builtAt'), 'buildHost': ci_ev.get('buildHost'), 'script': rec.get('script'), 'replaces': old}
ev['outputs'][EXE] = entry
ev.setdefault('rebuilds', [])
ev['rebuilds'] = [r for r in ev['rebuilds'] if r.get('milestone') != '0.36.2-milestone-3'] + [{'milestone': '0.36.2-milestone-3', 'outputs': [EXE], 'ci': ci_ev.get('ci'), 'builtAt': ci_ev.get('builtAt'), 'buildHost': ci_ev.get('buildHost'),
    'note': 'Only EightMaxInput.exe was taken from this build; the other executables are unchanged Milestone 1 Windows builds (their sources did not change), whose entries above keep the Milestone 1 build record.'}]
ev_path.write_text(json.dumps(ev, indent=2) + '\n', encoding='utf-8')
# 3. raw CI records
keep = root / 'evidence/0.36.2-m3/driver-build'; keep.mkdir(parents=True, exist_ok=True)
for f in ('driver-build.json', 'build-evidence-ci.json', 'build.log', 'package.log'):
    if (src / f).exists(): (keep / f).write_bytes((src / f).read_bytes().replace(b'\r\n', b'\n'))
# 4. release record
rel_path = root / 'release-0362-m3.json'; rel = load(rel_path)
rel['executables'][EXE]['sha256'] = h; rel['windowsBinariesRebuilt'] = True
rel['windowsBinariesReason'] = ('One C# source changed in Milestone 3 (desktop/input/Driver.cs), so EightMaxInput.exe was rebuilt ON WINDOWS by GitHub Actions run ' + run_id
                                + ' (windows\\Build-Executables.ps1 -SkipWgc, .NET Framework 4.x compiler). Every other executable is the unchanged Windows-built Milestone 1 binary.')
rel['rebuiltExecutables'] = {EXE: {'sha256': h, 'replaces': old, 'sources': list(shipped), 'ciRun': int(run_id), 'buildRecord': 'evidence/build-evidence.json (outputs, rebuilds) and evidence/0.36.2-m3/driver-build/'}}
rel_path.write_text(json.dumps(rel, indent=2) + '\n', encoding='utf-8')
# 5. generated metadata
for tool in ('tools/make-components.py', 'tools/make-manifest.py'):
    r = subprocess.run([sys.executable, '-I', str(root / tool)], capture_output=True, text=True)
    if r.returncode: fail(tool + ' failed: ' + r.stdout + r.stderr)
print(json.dumps({'installed': EXE, 'sha256': h, 'replaces': old, 'ciRun': int(run_id), 'sources': shipped}, indent=1))
