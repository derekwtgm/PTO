"""0.36.2 Milestone 3: package every SHA256SUMS.txt-listed file (plus the manifest itself) into the release ZIP, deterministically
(manifest order, fixed timestamp, Unix mode 0644, deflate 9 - the conventions of the Milestone 2 ZIP), refusing any file whose bytes
differ from the manifest and any shipped file the manifest does not list. Re-reads the written ZIP (CRC of every entry) and prints its
SHA-256.   Usage: python3 tools/package-0362m3.py OUT.zip   (OUT must be outside the package tree)"""
import hashlib, sys, zipfile
from pathlib import Path
root = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1]).resolve()
if root == out or root in out.parents: raise SystemExit('Write the ZIP outside the package tree')
listed = []
for line in (root / 'SHA256SUMS.txt').read_text(encoding='utf-8').splitlines():
    if not line.strip(): continue
    h, name = line.split('  ', 1); p = root / name
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != h: raise SystemExit('Manifest mismatch: ' + name)
    listed.append(name)
present = sorted(p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_file() and '.git' not in p.relative_to(root).parts and p.name != 'SHA256SUMS.txt')
unlisted = sorted(set(present) - set(listed))
if unlisted: raise SystemExit('Files not in SHA256SUMS.txt: ' + ', '.join(unlisted[:10]))
STAMP = (2026, 11, 23, 12, 0, 0)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for name in listed + ['SHA256SUMS.txt']:
        zi = zipfile.ZipInfo(root.name + '/' + name, date_time=STAMP); zi.compress_type = zipfile.ZIP_DEFLATED; zi.create_system = 3; zi.external_attr = 0o100644 << 16
        z.writestr(zi, (root / name).read_bytes(), compresslevel=9)
with zipfile.ZipFile(out) as z:
    bad = z.testzip(); n = len(z.namelist())
    if bad is not None: raise SystemExit('ZIP integrity failed at ' + bad)
print(hashlib.sha256(out.read_bytes()).hexdigest() + '  ' + out.name); print('entries', n, '(manifest entries', len(listed), '+ SHA256SUMS.txt)')
