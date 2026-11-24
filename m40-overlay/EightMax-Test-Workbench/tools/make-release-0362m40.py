"""EightMax Test Workbench 0.36.2 Milestone 4.0 - release builder (the Milestone 3.1/3.2 rules, unchanged, plus the Milestone 4.0 record).

  python3 -I tools/make-release-0362m40.py record [BUILD.json]  write the SHA-256 of every executable on disk into release-0362-m40.json
                                                                (BUILD.json: the Windows build evidence of the rebuilt executables)
  python3 -I tools/make-release-0362m40.py manifest             regenerate SHA256SUMS.txt from the immutable payload
  python3 -I tools/make-release-0362m40.py package OUT.zip      package every listed file (OUT outside the tree)
  python3 -I tools/make-release-0362m40.py verify ZIP [JSON]    extract ZIP into a NEW folder whose path has spaces, verify it

The payload is defined by release-integrity-policy.json: runtime output (test-results/), development metadata (.git) and operating-system
metadata (Thumbs.db, desktop.ini, .DS_Store) are never listed or packaged. Packaging is strict: it refuses any payload file the manifest
does not list and any listed file whose bytes differ (the conventions of the Milestone 2/3 ZIPs: manifest order, fixed timestamp, Unix mode
0644, deflate 9). Verification is strict too: every ZIP entry must be listed, every listed file must be in the ZIP with its SHA-256, and
the extracted copy must pass tools/release-integrity.cjs (run with the Node.js given by EIGHTMAX_NODE or 'node').
Milestone 4.0: the input driver (EightMaxInput.exe), the desktop host (EightMaxWorkbench.exe) and the capture tool (EightMaxCapture.exe) are
rebuilt ON WINDOWS from their changed sources (csc of the .NET Framework 4.x, windows/Build-Executables.ps1); verification checks every
executable named in release-0362-m40.json against its recorded SHA-256 and that the EightMax 5.1 engine native/mwcli.exe is byte-identical
(it is never rebuilt)."""
import hashlib, json, os, re, shutil, subprocess, sys, tempfile, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POLICY = json.loads((ROOT / 'release-integrity-policy.json').read_text(encoding='utf-8'))
STAMP = (2026, 11, 24, 18, 0, 0)


def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def classify(rel):
    parts = rel.split('/')
    if parts[0] in POLICY['developmentMetadataFolders']:
        return 'development'
    if parts[-1] in POLICY['operatingSystemMetadataFiles']:
        return 'os-metadata'
    if parts[0] in POLICY['runtimeOutputFolders'] and len(parts) > 1:
        return 'runtime-output'
    return 'payload'


def payload_files():
    out = []
    for p in ROOT.rglob('*'):
        if p.is_symlink():
            raise SystemExit('Link in the package tree: ' + str(p))
        if p.is_file():
            rel = p.relative_to(ROOT).as_posix()
            if rel != 'SHA256SUMS.txt' and classify(rel) == 'payload':
                out.append(rel)
    return sorted(out)


def manifest():
    files = payload_files()
    (ROOT / 'SHA256SUMS.txt').write_text(''.join(sha(ROOT / f) + '  ' + f + '\n' for f in files), encoding='utf-8', newline='\n')
    print(len(files), 'payload files listed in SHA256SUMS.txt')


def listed_entries(root):
    rows = []
    for line in (root / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
        if not line.strip():
            continue
        m = re.fullmatch(r'([0-9a-f]{64})  (.+)', line)
        if not m:
            raise SystemExit('Malformed manifest line: ' + line[:120])
        rows.append((m.group(1), m.group(2)))
    return rows


def package(out):
    out = Path(out).resolve()
    if ROOT == out or ROOT in out.parents:
        raise SystemExit('Write the ZIP outside the package tree')
    rows = listed_entries(ROOT)
    for h, name in rows:
        if sha(ROOT / name) != h:
            raise SystemExit('Manifest mismatch: ' + name)
    unlisted = sorted(set(payload_files()) - {n for _, n in rows})
    if unlisted:
        raise SystemExit('Payload files not in SHA256SUMS.txt: ' + ', '.join(unlisted[:10]))
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in [n for _, n in rows] + ['SHA256SUMS.txt']:
            zi = zipfile.ZipInfo(ROOT.name + '/' + name, date_time=STAMP)
            zi.compress_type = zipfile.ZIP_DEFLATED
            zi.create_system = 3
            zi.external_attr = (0o100755 if name.endswith('.sh') else 0o100644) << 16   # Linux test stubs stay executable
            z.writestr(zi, (ROOT / name).read_bytes(), compresslevel=9)
    with zipfile.ZipFile(out) as z:
        bad = z.testzip()
        n = len(z.namelist())
    if bad is not None:
        raise SystemExit('ZIP integrity failed at ' + bad)
    print(sha(out) + '  ' + out.name)
    print('entries', n, '(manifest entries', len(rows), '+ SHA256SUMS.txt)')


def verify(zip_path, json_out=None):
    zip_path = Path(zip_path).resolve()
    rec = {'format': 'eightmax-release-verification', 'version': 2, 'zip': zip_path.name, 'zipSha256': sha(zip_path), 'zipBytes': zip_path.stat().st_size}
    base = Path(tempfile.mkdtemp(prefix='em-m40-verify-'))
    dest = base / 'fresh extraction (spaces)'
    try:
        with zipfile.ZipFile(zip_path) as z:
            names = z.namelist()
            rec['entries'] = len(names)
            rec['crcOk'] = z.testzip() is None
            tops = {n.split('/')[0] for n in names}
            rec['singleTopFolder'] = len(tops) == 1
            rec['unsafePaths'] = [n for n in names if n.startswith('/') or '..' in n.split('/') or '\\' in n or ':' in n]
            z.extractall(dest)
            for zi in z.infolist():   # apply stored Unix modes as unzip does (zipfile.extractall ignores them)
                mode = (zi.external_attr >> 16) & 0o777
                if mode and not zi.is_dir():
                    os.chmod(dest / zi.filename, mode)
        root = dest / sorted(tops)[0]
        rows = listed_entries(root)
        listed = {n for _, n in rows}
        in_zip = {n.split('/', 1)[1] for n in names if '/' in n and not n.endswith('/')}
        rec['manifest'] = {
            'entries': len(rows),
            'mismatches': [n for h, n in rows if not (root / n).is_file() or sha(root / n) != h],
            'unlisted': sorted(in_zip - listed - {'SHA256SUMS.txt'}),
            'missing': sorted(listed - in_zip),
            'runtimeOutputInZip': sorted(n for n in in_zip if classify(n) != 'payload'),
        }
        node = os.environ.get('EIGHTMAX_NODE', 'node')
        p = subprocess.run([node, str(root / 'tools' / 'release-integrity.cjs'), '--root', str(root), '--json', str(base / 'integrity.json')], capture_output=True, text=True)
        rec['releaseIntegrity'] = {'exitCode': p.returncode, 'summary': p.stdout.strip().splitlines()[0] if p.stdout.strip() else p.stderr.strip()[:300]}
        mw = root / 'native' / 'mwcli.exe'
        rec['mwcliSha256'] = sha(mw) if mw.is_file() else None
        rec['mwcliUnchanged'] = rec['mwcliSha256'] == 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'
        relrec = root / 'release-0362-m40.json'
        exes = json.loads(relrec.read_text(encoding='utf-8')).get('executables', {}) if relrec.is_file() else {}
        rec['executables'] = {k: {'recorded': v.get('sha256'), 'matches': (root / k).is_file() and sha(root / k) == v.get('sha256')} for k, v in exes.items()}
        rec['executablesUnchanged'] = bool(exes) and all(x['matches'] for x in rec['executables'].values())   # every executable is exactly the recorded one
        rec['rebuiltForMilestone40'] = sorted(k for k, v in exes.items() if v.get('rebuiltForMilestone40'))
        m = rec['manifest']
        rec['ok'] = bool(rec['crcOk'] and rec['singleTopFolder'] and not rec['unsafePaths'] and not m['mismatches'] and not m['unlisted'] and not m['missing']
                         and not m['runtimeOutputInZip'] and p.returncode == 0 and rec['mwcliUnchanged'] and rec['executablesUnchanged'])
        rec['extractedTo'] = 'a new temporary folder whose path contains spaces (deleted afterwards)'
    finally:
        shutil.rmtree(base, ignore_errors=True)
    text = json.dumps(rec, indent=1)
    if json_out:
        Path(json_out).write_text(text + '\n', encoding='utf-8')
    print(text)
    if not rec['ok']:
        raise SystemExit(1)


EXECUTABLES = ['desktop/bin/EightMaxWorkbench.exe', 'desktop/bin/EightMaxInput.exe', 'desktop/bin/EightMaxTestTable.exe', 'desktop/bin/EightMaxCapture.exe', 'desktop/bin/EightMaxWgc.exe', 'native/mwcli.exe', 'runtime/node/node.exe']
REBUILT = {'desktop/bin/EightMaxInput.exe': ['desktop/input/Driver.cs', 'desktop/input/Platform.cs'], 'desktop/bin/EightMaxWorkbench.exe': ['desktop/CaptureService.cs', 'desktop/DesktopHost.cs'], 'desktop/bin/EightMaxCapture.exe': ['desktop/CaptureService.cs']}
MWCLI = 'b3e675bfe2ae231e7d637de07886af6b511905d5225db96fe12ce2c3ccab2f72'


def record(build_json=None):
    """Write the executables section of release-0362-m40.json from the files on disk (the record must describe exactly what ships)."""
    p = ROOT / 'release-0362-m40.json'
    rel = json.loads(p.read_text(encoding='utf-8'))
    m32 = json.loads((ROOT / 'release-0362-m32.json').read_text(encoding='utf-8')).get('executables', {})
    build = json.loads(Path(build_json).read_text(encoding='utf-8')) if build_json else None
    if build:   # the Milestone 3 convention: rebuilt executables take the Windows build's entry, unchanged ones keep theirs, plus a rebuild note
        ev_path = ROOT / 'evidence' / 'build-evidence.json'
        ev = json.loads(ev_path.read_text(encoding='utf-8'))
        for k in REBUILT:
            out = (build.get('outputs') or {}).get(k)
            if not out or sha(ROOT / k) != out.get('sha256'):
                raise SystemExit('The Windows build evidence does not describe the ' + k + ' on disk: refused')
            out = dict(out); out['rebuiltIn'] = {'milestone': '0.36.2-milestone-4.0', 'ci': build.get('ci'), 'builtAt': build.get('builtAt'), 'buildHost': build.get('buildHost')}
            ev['outputs'][k] = out
        notes = [r for r in ev.get('rebuilds', []) if r.get('milestone') != '0.36.2-milestone-4.0']
        notes.append({'milestone': '0.36.2-milestone-4.0', 'outputs': sorted(REBUILT), 'ci': build.get('ci'), 'builtAt': build.get('builtAt'), 'buildHost': build.get('buildHost'),
                      'note': 'Only EightMaxInput.exe, EightMaxWorkbench.exe and EightMaxCapture.exe were taken from this build (their sources changed); the test table, the WGC helper, Node.js and the EightMax 5.1 engine are unchanged and keep their records.'})
        ev['rebuilds'] = notes
        ev_path.write_text(json.dumps(ev, indent=2) + '\n', encoding='utf-8', newline='\n')
        subprocess.run([sys.executable, '-I', str(ROOT / 'tools' / 'make-components.py')], check=True)
    exes = {}
    for k in EXECUTABLES:
        f = ROOT / k
        if not f.is_file():
            raise SystemExit('Missing executable ' + k)
        h = sha(f)
        e = {'sha256': h, 'milestone32Sha256': (m32.get(k) or {}).get('sha256')}
        e['rebuiltForMilestone40'] = k in REBUILT and h != e['milestone32Sha256']
        if k in REBUILT:
            e['changedSources'] = REBUILT[k]
        if k == 'native/mwcli.exe' and h != MWCLI:
            raise SystemExit('native/mwcli.exe differs from EightMax 5.1 build 7d08acc7eb4577ee: refused')
        if k not in REBUILT and h != e['milestone32Sha256']:
            raise SystemExit(k + ' differs from Milestone 3.2 although its sources did not change: refused')
        exes[k] = e
    rel['executables'] = exes
    rel['windowsBinariesRebuilt'] = any(v['rebuiltForMilestone40'] for v in exes.values())
    # the Milestone 3 convention: what each rebuild replaced (earlier release tests follow the chain instead of the file on disk)
    run = (build or {}).get('ci', {}).get('runId') if build else (rel.get('windowsBuild') or {}).get('run')
    rel['rebuiltExecutables'] = {k: {'replaces': v['milestone32Sha256'], 'sha256': v['sha256'], 'ciRun': int(run) if str(run or '').isdigit() else run, 'sources': REBUILT[k]} for k, v in exes.items() if v['rebuiltForMilestone40']}
    if build:
        rel['windowsBuild'] = {'run': build.get('ci', {}).get('runId'), 'buildHost': build.get('buildHost'), 'compiler': build.get('compiler'), 'sourceHashes': build.get('sourceHashes'), 'outputs': build.get('outputs')}
    p.write_text(json.dumps(rel, indent=1) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps({k: (v['sha256'][:16], 'rebuilt' if v['rebuiltForMilestone40'] else 'unchanged') for k, v in exes.items()}, indent=1))


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'record' and len(sys.argv) in (2, 3):
        record(sys.argv[2] if len(sys.argv) == 3 else None)
    elif cmd == 'manifest':
        manifest()
    elif cmd == 'package' and len(sys.argv) == 3:
        package(sys.argv[2])
    elif cmd == 'verify' and len(sys.argv) in (3, 4):
        verify(sys.argv[2], sys.argv[3] if len(sys.argv) == 4 else None)
    else:
        raise SystemExit(__doc__)
