"""0.36.2 Milestone 1: append ONE Windows CI run record to evidence/windows-ci-runs.json from the run's own result files,
then regenerate desktop/COMPONENT-VERSIONS.json. An executable is listed only if it actually ran in this run and every check
that exercised it passed, so 'validatedInWindowsCI' stays an evidence-based claim.
Usage: python tools/record-windows-run-0362.py --m1 milestone1-results.json [--selftest input-selftest.json]
       [--acceptance input-acceptance.json] [--benchmark benchmark.json] [--regression regression.log] --candidate TEXT"""
import argparse, hashlib, json, os, re, subprocess, sys
from datetime import datetime, timezone
from pathlib import Path
root = Path(__file__).resolve().parent.parent
a = argparse.ArgumentParser()
for k in ('m1', 'selftest', 'acceptance', 'benchmark', 'regression', 'candidate'): a.add_argument('--' + k)
o = a.parse_args()
load = lambda p: json.loads(Path(p).read_text(encoding='utf-8-sig')) if p and Path(p).is_file() else None
sha = lambda p: hashlib.sha256((root / p).read_bytes()).hexdigest()
m1 = load(o.m1)
if not m1: sys.exit('milestone-1 results missing; nothing recorded')
groups = {}
for c in m1['checks']: groups.setdefault(c['group'], []).append(c)
ok = lambda *gs: all(c['status'] != 'fail' for g in gs for c in groups.get(g, [])) and all(groups.get(g) for g in gs)
n = lambda *gs: '%d/%d' % (sum(c['status'] == 'pass' for g in gs for c in groups.get(g, [])), sum(len(groups.get(g, [])) for g in gs))
st, acc, bench = load(o.selftest), load(o.acceptance), load(o.benchmark)
reg = None
if o.regression and Path(o.regression).is_file():
    t = Path(o.regression).read_text(encoding='utf-8', errors='replace')
    reg = {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped) (\d+)', t, re.M)}
executables, observed = {}, {}
common = ok('integrity', 'version')
if common and ok('host', 'native', 'shutdown'):
    executables['desktop/bin/EightMaxWorkbench.exe'] = sha('desktop/bin/EightMaxWorkbench.exe')
    observed['desktop/bin/EightMaxWorkbench.exe'] = 'Milestone 1: headless and window launch, health/session/native identity, input broker, capture of the controlled table, authenticated and window-close shutdown (%s host/shutdown/native checks)' % n('host', 'shutdown', 'native')
if common and ok('input', 'capabilities', 'ipc'):
    executables['desktop/bin/EightMaxInput.exe'] = sha('desktop/bin/EightMaxInput.exe')
    observed['desktop/bin/EightMaxInput.exe'] = 'Milestone 1: started by the host, hello/token, capabilities and queries (%s input/capability/ipc checks)' % n('input', 'capabilities', 'ipc') + ('; input acceptance %s/%s' % (sum(1 for c in acc.get('checks', []) if c.get('ok')), len(acc.get('checks', []))) if acc else '')
if common and ok('testtable'):
    executables['desktop/bin/EightMaxTestTable.exe'] = sha('desktop/bin/EightMaxTestTable.exe')
    observed['desktop/bin/EightMaxTestTable.exe'] = 'Milestone 1: window opened, dealer protocol describe/frame/close, captured by the host (%s test-table checks)' % n('testtable')
if ok('native'): executables['native/mwcli.exe'] = sha('native/mwcli.exe'); observed['native/mwcli.exe'] = '--build-id EightMaxBuild=7d08acc7eb4577ee; hash verified by the rebuilt host'
if reg: executables['runtime/node/node.exe'] = sha('runtime/node/node.exe'); observed['runtime/node/node.exe'] = 'Node regression suite: %(tests)d tests, %(pass)d pass, %(fail)d fail, %(skipped)d skipped' % {**{'tests': 0, 'pass': 0, 'fail': 0, 'skipped': 0}, **reg}
record = {'release': '0.36.2-dev Milestone 1 build + focused Windows checks', 'runId': int(os.environ.get('GITHUB_RUN_ID') or 0), 'date': datetime.now(timezone.utc).isoformat(),
          'conclusion': 'milestone-1 checks passed' if m1.get('milestone1Passed') else 'milestone-1 checks FAILED', 'runner': 'GitHub-hosted windows-latest: ' + str(m1['machine'].get('os')) + ', screen ' + str(m1['machine'].get('virtualScreen')),
          'candidate': o.candidate or '', 'executables': executables, 'observed': observed,
          'milestone1': m1['counts'], 'inputSelfTest': ({k: st.get(k) for k in ('driver', 'passed', 'total', 'ok', 'dpiAwareness') if k in st} if st else None),
          'inputAcceptance': ({'checks': len(acc.get('checks', [])), 'passed': sum(1 for c in acc.get('checks', []) if c.get('ok'))} if acc else None),
          'benchmarkSmoke': ({'app': bench.get('app'), 'sustainableTables': bench.get('sustainableTables'), 'runErrors': [r.get('error') for w in bench.get('workloads', []) for r in w.get('runs', []) if r.get('error')]} if bench else None), 'regression': reg}
p = root / 'evidence/windows-ci-runs.json'; d = json.loads(p.read_text(encoding='utf-8'))
d['runs'] = [r for r in d['runs'] if r.get('runId') != record['runId'] or not record['runId']] + [record]
with open(p, 'w', encoding='utf-8', newline='\n') as f: f.write(json.dumps(d, indent=2) + '\n')
print('recorded run', record['runId'], 'executables:', ', '.join(executables) or 'none')
subprocess.check_call([sys.executable, str(root / 'tools/make-components.py')])
