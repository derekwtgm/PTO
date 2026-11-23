"""0.36.2 Milestone 3: record a Milestone 3 Windows CI validation run in evidence/windows-ci-runs.json, from the run's own results.

Usage: python3 -I tools/record-windows-run-0362m3.py RESULTS_DIR CANDIDATE_TEXT
RESULTS_DIR is the content of branch m3-results/<run id> (run.json, results/milestone3-results.json, logs/).

The record lists the SHA-256 of every executable AS THE WINDOWS RUN MEASURED IT (identity phase), never the local files, and is refused
unless the run passed every check (overall PASS): a component is 'validated in Windows CI' only through a passing run that names its exact
hash (tools/make-components.py). The raw results are copied to evidence/0.36.2-m3/windows-ci-<run id>/. Then COMPONENT-VERSIONS.json and
SHA256SUMS.txt are regenerated."""
import json, re, shutil, subprocess, sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
src, candidate = Path(sys.argv[1]).resolve(), sys.argv[2]
run = json.loads((src / 'run.json').read_text(encoding='utf-8-sig')); run_id = str(run['run'])
res = json.loads((src / 'results' / 'milestone3-results.json').read_text(encoding='utf-8-sig'))
if res.get('overall') != 'PASS': raise SystemExit('refused: run ' + run_id + ' is ' + str(res.get('overall')) + ' (' + json.dumps(res.get('counts')) + ')')
# the identity phase lists every executable it measured on the runner: [{file, sha256, bytes, fileVersion, productVersion}]
full = {e['file'].replace('\\', '/'): e['sha256'] for e in (res.get('executables') or []) if e.get('sha256')}
need = ['desktop/bin/EightMaxWorkbench.exe', 'desktop/bin/EightMaxInput.exe', 'desktop/bin/EightMaxTestTable.exe', 'native/mwcli.exe']
if [k for k in need if k not in full]: raise SystemExit('refused: the run did not report the hashes of ' + ', '.join(k for k in need if k not in full))
m = res.get('machine') or {}
groups = res.get('groups') or {}
observed_all = 'Milestone 3 (all ' + str(res['counts']['checks']) + ' checks passed): ' + ', '.join(g + ' ' + str(v.get('pass')) + '/' + str(v.get('pass', 0) + v.get('fail', 0)) for g, v in groups.items())
obs = {k: observed_all for k in full}
obs['desktop/bin/EightMaxInput.exe'] = 'Milestone 3: every input of the lifecycle (A-K), gameplay (T1-T6), multi-table (1/2/5/8 tables) and campaign phases on real windows; ' + observed_all
obs['desktop/bin/EightMaxWorkbench.exe'] = 'Milestone 3: prebuilt start, forced fallback compile, cache reuse, invalid-cache rebuild, shutdown and port release, and host for every phase; ' + observed_all
w = m.get('windows') or {}; scr = ', '.join(x.get('bounds', '') for x in (m.get('screens') or []))
rec = {'release': '0.36.2-dev Milestone 3 validation', 'runId': int(run_id), 'date': res.get('at'), 'conclusion': 'milestone-3 checks passed (' + str(res['counts']['passed']) + '/' + str(res['counts']['checks']) + ')',
       'runner': 'GitHub-hosted windows-latest: ' + str(w.get('caption', '')) + ' ' + str(w.get('version', '')) + ' build ' + str(w.get('build', '')) + ', screen ' + scr + ' at ' + str(m.get('displayScalingPercent', '?')) + ' %',
       'candidate': candidate, 'executables': full, 'observed': obs}
p = root / 'evidence/windows-ci-runs.json'; doc = json.loads(p.read_text(encoding='utf-8'))
doc['runs'] = [r for r in doc['runs'] if str(r.get('runId')) != run_id] + [rec]
p.write_text(json.dumps(doc, indent=2) + '\n', encoding='utf-8')
dest = root / 'evidence/0.36.2-m3' / ('windows-ci-' + run_id)
if dest.exists(): shutil.rmtree(dest)
shutil.copytree(src, dest, ignore=shutil.ignore_patterns('*.png', '*.bmp'))
for tool in ('tools/make-components.py', 'tools/make-manifest.py'):
    r = subprocess.run([sys.executable, '-I', str(root / tool)], capture_output=True, text=True)
    if r.returncode: raise SystemExit(tool + ' failed: ' + r.stdout + r.stderr)
print(json.dumps({'recorded': int(run_id), 'executables': full}, indent=1))
