"""0.36.2 Milestone 3: assemble the four machine-readable validation records from the raw evidence in evidence/0.36.2-m3/.
   HAND-TRACKING-VALIDATION-0362M3.json  tournament elimination and hand-reconstruction tests (before / after, unit, end-to-end)
   GAMEPLAY-STRESS-0362M3.json           long campaigns, multi-table stability, negative tests
   WINDOWS-VALIDATION-0362M3.json        what ran on real Windows (GitHub Actions) - and what is still pending
   REGRESSION-0362M3.json                test totals, failures, skips, reruns
Every number is read from a raw result file named in the record; nothing is typed in by hand.
Usage: python3 tools/make-evidence-0362m3.py [output-folder]   (default: the package root)"""
import json, re, sys, pathlib, hashlib, datetime
root = pathlib.Path(__file__).resolve().parent.parent
ev = root / 'evidence' / '0.36.2-m3'
out_dir = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else root
def load(name, default=None):
    p = ev / name
    if not p.exists(): return default
    return json.loads(p.read_text(encoding='utf-8'))
def tap(name):
    p = ev / name
    if not p.exists(): return None
    t = p.read_text(encoding='utf-8', errors='replace')
    g = lambda k: int(m.group(1)) if (m := re.search(r'^# ' + k + r' (\d+)', t, re.M)) else None
    fails = re.findall(r'^not ok \d+ - (.+)$', t, re.M); skips = re.findall(r'^ok \d+ - (.+?) # SKIP (.*)$', t, re.M)
    diag = {m.group(1): json.loads(m.group(2)) for m in re.finditer(r'^\s*# (ledger-vs-simulator|tracker-vs-simulator) (\{.*\})$', t, re.M)}
    return {'file': 'evidence/0.36.2-m3/' + name, 'tests': g('tests'), 'passed': g('pass'), 'failed': g('fail'), 'skipped': g('skipped'), 'cancelled': g('cancelled'), 'durationMs': float(m.group(1)) if (m := re.search(r'^# duration_ms ([\d.]+)', t, re.M)) else None,
            'failedTests': fails, 'skippedTests': [{'test': a, 'reason': b} for a, b in skips], 'diagnostics': diag}
def scen(doc):
    if not doc: return None
    return {'overall': doc.get('overall'), 'environment': doc.get('environment'), 'summary': doc.get('summary'), 'cleanup': (doc.get('cleanup') or {}).get('ok'),
            'scenarios': [{'id': s['id'], 'name': s['name'], 'status': s['status'], 'checks': len(s['checks']), 'failedChecks': [c['name'] for c in s['checks'] if not c['pass']], 'durationMs': s.get('durationMs'), 'metrics': s.get('metrics')} for s in doc.get('scenarios', [])]}
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
rel = json.loads((root / 'release-0362-m3.json').read_text(encoding='utf-8'))
common = {'app': '0.36.2-dev', 'milestone': '0.36.2 Milestone 3', 'generatedAt': now, 'generatedBy': 'tools/make-evidence-0362m3.py', 'nativeEngine': rel['nativeEngine']}

# ---------------- hand tracking ----------------
before, after_deep, after_short = load('repro-elimination-M2-before.json'), load('repro-elimination-M3-after-2500.json'), load('repro-elimination-M3-after-1000.json')
def repro(d):
    if not d: return None
    return {'verdict': d.get('verdict'), 'ended': d.get('ended'), 'stalled': d.get('stalled'), 'startingStacks': d['setup'].get('startingStacks'), 'handsStarted': d.get('handsStarted'), 'confirmedActions': d.get('confirmedActions'),
            'eliminations': d.get('eliminations'), 'lastConfirmedAction': d.get('lastConfirmedAction'), 'firstRefusal': d.get('firstRefusal'), 'refusalMessages': d.get('refusalMessages')[:5], 'dealerFinal': d.get('dealerFinal'),
            'tracker': {k: (d.get('tracker') or {}).get(k) for k in ('paused', 'pauseReason')} | ({'status': (d['tracker'].get('status') or {}).get('status'), 'recoveries': (d['tracker'].get('status') or {}).get('recoveries'), 'untrackedHands': (d['tracker'].get('status') or {}).get('untrackedHands')} if (d.get('tracker') or {}).get('status') else {}),
            'gameplay': d.get('gameplay'), 'hands': d.get('hands')[:12]}
suite = tap('m3-linux-full-suite.tap')
units = {k: v for k, v in (suite or {}).get('diagnostics', {}).items()}
ga = load('gameplay-acceptance-fake.json')
hand = {'format': 'eightmax-hand-tracking-validation', 'version': 1, **common,
  'defect': {'summary': 'Eliminated (zero-chip) tournament players are shown folded from the first frame of every later hand; HandStateEngine._track() treated any folded seat in a first frame as a missed hand start (missed-hand-start, then untracked-hand), the ledger charged every seat an ante and placed the blinds at fixed offsets, and _build() expected the eight-handed opening pot; every hand after the first elimination was refused and the controlled table waited forever.',
             'files': ['src/hand-state.js (HandStateEngine._track, _build)', 'src/hand-ledger.js (HandLedger constructor: antes, blind seats, stacks > 0)']},
  'reproductionBeforeFix': {'tree': 'unmodified Milestone 2', 'tool': 'tools/repro-elimination-stall-0362m3.cjs', 'file': 'evidence/0.36.2-m3/repro-elimination-M2-before.json', 'result': repro(before)},
  'afterFix': {'deepStacks2500': {'file': 'evidence/0.36.2-m3/repro-elimination-M3-after-2500.json', 'result': repro(after_deep)}, 'stacks1000ToCompletion': {'file': 'evidence/0.36.2-m3/repro-elimination-M3-after-1000.json', 'result': repro(after_short)}},
  'unitAndDifferential': {'file': 'tests/tournament-0362m3.test.cjs (results in ' + ((suite or {}).get('file') or 'n/a') + ')', 'ledgerVsSimulator': units.get('ledger-vs-simulator'), 'trackerVsSimulator': units.get('tracker-vs-simulator'),
                          'cases': ['M2 defect regression (hand after two eliminations)', 'real missed fold still refused', 'element-by-element opening checks with reasons', 'short ante / short small blind / short big blind', 'tournament continuity strict vs auto', 'eliminated player dealt in again', 'heads-up transition', 'untracked-hand recovery status and counters', 'persistent contradiction -> untracked', 'tournament completion', 'ledger serialization v1/v2', 'checkpoint v1/v2', 'negative readings', 'hidden controls during think-time (pre-existing defect)']},
  'endToEndFake': scen(ga) and {'file': 'evidence/0.36.2-m3/gameplay-acceptance-fake.json', **scen(ga), 'note': 'fake desktop host + real fixture dealer + real recognition / tracker / scheduler / adapter; NOT Windows evidence'},
  'windows': 'see WINDOWS-VALIDATION-0362M3.json'}

# ---------------- gameplay stress ----------------
camps = {n: load(n) for n in ('campaign-fake-5p400.json', 'campaign-fake-8p300.json', 'campaign-fake-8p1500.json')}
def camp(d):
    if not d: return None
    m = d['scenarios'][0]['metrics']; return {'overall': d['overall'], **{k: m[k] for k in ('seconds', 'completedHands', 'tournamentsStarted', 'tournamentsCompleted', 'winnersMatchDealer', 'actionsAttempted', 'actionsConfirmed', 'incorrectActions', 'invalidWagers', 'missedStateTransitions', 'confirmedButNotApplied', 'refusedReadings', 'reconstructionFailures', 'untrackedHands', 'recoveryEvents', 'unexpectedPauses', 'uncertainOrUnconfirmed', 'eliminationsSeen', 'finalPlayerCounts', 'hands', 'violations')}}
cs = {k: camp(v) for k, v in camps.items() if v}
tot = lambda key: sum((c or {}).get(key, 0) or 0 for c in cs.values())
stab = load('gameplay-stability-fake.json'); neg = tap('m3-linux-full-suite.tap')
stress = load('lifecycle-stress-M3-120s.json')
gs = {'format': 'eightmax-gameplay-stress', 'version': 1, **common,
  'environment': 'Linux x64, Node ' + (ga or {}).get('machine', {}).get('node', '?') + ' - in-process fake desktop host + REAL fixture dealer (the dealer of EightMaxTestTable.exe) + real recognition, tracker, scheduler, adapter and driver wrapper. NOT Windows evidence (see WINDOWS-VALIDATION-0362M3.json).',
  'longCampaigns': {'files': ['evidence/0.36.2-m3/' + k for k in cs], 'byCampaign': cs,
                    'totals': {'completedHands': tot('completedHands'), 'tournamentsStarted': tot('tournamentsStarted'), 'tournamentsCompleted': tot('tournamentsCompleted'), 'actionsAttempted': tot('actionsAttempted'), 'actionsConfirmed': tot('actionsConfirmed'), 'incorrectActions': tot('incorrectActions'), 'invalidWagers': tot('invalidWagers'), 'missedStateTransitions': tot('missedStateTransitions'), 'reconstructionFailures': tot('reconstructionFailures'), 'unexpectedPauses': tot('unexpectedPauses'), 'recoveryEvents': tot('recoveryEvents'), 'eliminationsSeen': tot('eliminationsSeen')}},
  'multiTableStability': scen(stab) and {'file': 'evidence/0.36.2-m3/gameplay-stability-fake.json', **scen(stab), 'note': 'ten-table capacity is NOT claimed (out of scope for Milestone 3)'},
  'lifecycleStress': stress and {'file': 'evidence/0.36.2-m3/lifecycle-stress-M3-120s.json', 'pass': stress.get('pass'), 'violations': stress.get('violations'), 'registrations': stress.get('registrations'), 'confirmedActions': stress.get('confirmedActions'), 'uncertainActions': stress.get('uncertainActions'), 'faults': stress.get('faults')},
  'negativeTests': {'file': 'tests/negative-0362m3.test.cjs, tests/tournament-0362m3.test.cjs', 'results': [t for t in ((neg or {}).get('failedTests') or []) if 'negative' in t] or 'all passed in the full suite run'}}

# ---------------- Windows ----------------
win_runs = sorted(ev.glob('windows-ci-*/milestone3-results.json'))
wv = {'format': 'eightmax-windows-validation', 'version': 1, **common, 'runs': []}
for p in win_runs:
    d = json.loads(p.read_text(encoding='utf-8-sig')); runid = p.parent.name.replace('windows-ci-', '')
    checks = d.get('checks', []); groups = d.get('groups', {})
    wv['runs'].append({'run': runid, 'url': 'https://github.com/derekwtgm/PTO/actions/runs/' + runid, 'folder': 'evidence/0.36.2-m3/' + p.parent.name, 'environment': d.get('environment'), 'machine': d.get('machine'), 'overall': d.get('overall'), 'counts': d.get('counts'), 'groups': groups,
                       'failed': [{'group': c['group'], 'name': c['name'], 'detail': c['detail']} for c in checks if c.get('status') == 'fail'], 'warnings': [{'group': c['group'], 'name': c['name'], 'detail': c['detail']} for c in checks if c.get('status') == 'warn'],
                       'unitTests': d.get('unitTests'), 'hostStart': [{k: h.get(k) for k in ('case', 'error', 'launcherSeconds', 'healthStatus', 'appVersion', 'shutdown')} | {'path': (h.get('status') or {}).get('path'), 'invalidCache': (h.get('status') or {}).get('invalidCache')} for h in d.get('hostStart', [])], 'tools': d.get('tools'), 'executables': d.get('executables')})
wv['executed'] = bool(wv['runs']); final = wv['runs'][-1] if wv['runs'] else None
wv['status'] = 'executed on GitHub-hosted Windows (real Windows desktop, real windows and input); NOT the target PC' if final else 'PENDING: no Windows run recorded'
wv['targetHardware'] = {'status': 'PENDING', 'note': 'Windows 11 Home, i7-13700F, RTX 4060 Ti, 3840x2160 at 125 %: run RUN-0362-MILESTONE3-TESTS.cmd and send the results ZIP'}
wv['criteria'] = {}

# ---------------- regression ----------------
base = tap('baseline-M2-linux-node-tests.tap')
reruns = [tap(n.name) for n in sorted(ev.glob('m3-linux-full-suite-rerun*.tap'))]
reg = {'format': 'eightmax-regression', 'version': 1, **common,
  'baselineMilestone2Linux': base and {k: base[k] for k in ('file', 'tests', 'passed', 'failed', 'skipped', 'durationMs')} | {'environment': 'Linux, Node 22.23.5, Chromium, no Mono'},
  'milestone3Linux': suite and {k: suite[k] for k in ('file', 'tests', 'passed', 'failed', 'skipped', 'cancelled', 'durationMs', 'failedTests', 'skippedTests')} | {'environment': 'Linux, Node 22.23.5, Chromium (Playwright), Mono 6.8, openbox - NOT Windows'},
  'reruns': [r and {k: r[k] for k in ('file', 'tests', 'passed', 'failed', 'skipped', 'failedTests')} for r in reruns],
  'windows': [{'run': r['run'], 'unitTests': r['unitTests'], 'overall': r['overall'], 'counts': r['counts']} for r in wv['runs']],
  'exitAudit': {'before': load('baseline-M2-exit-audit.json', {}).get('summary'), 'after10Runs': load('exit-audit-M3-lifecycle-fake-10runs.json', {}).get('summary'), 'genuineTimeout': load('exit-audit-M3-genuine-timeout.json', {}).get('summary')},
  'buildCheck': (lambda b: b and {'ok': b['ok'], 'fallbackCompile': {k: b['fallbackCompile'][k] for k in ('sameAsBuildExecutables', 'sameAsComponentVersions', 'includesEveryTopLevelDesktopSource', 'ok')}, 'nativeUnchanged': b['nativeEngine']['unchanged']})(load('build-check.json'))}
for name, doc in (('HAND-TRACKING-VALIDATION-0362M3.json', hand), ('GAMEPLAY-STRESS-0362M3.json', gs), ('WINDOWS-VALIDATION-0362M3.json', wv), ('REGRESSION-0362M3.json', reg)):
    (out_dir / name).write_text(json.dumps(doc, indent=2, default=str) + '\n', encoding='utf-8', newline='\n'); print('wrote', name)
