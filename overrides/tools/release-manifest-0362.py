"""Regenerate manifest; never change historical test evidence or binary identities."""
from pathlib import Path
import hashlib
root=Path(__file__).resolve().parent.parent
files=sorted(p for p in root.rglob('*') if p.is_file() and '.git' not in p.relative_to(root).parts and p.name!='SHA256SUMS.txt')
(root/'SHA256SUMS.txt').write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.relative_to(root).as_posix()+'\n' for p in files),encoding='utf-8',newline='\n')
print(f'Hashed {len(files)} files')
