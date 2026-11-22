"""0.36.2: regenerate SHA256SUMS.txt (LF line endings on every OS); never changes historical test evidence or binary identities."""
from pathlib import Path
import hashlib
root = Path(__file__).resolve().parent.parent
files = sorted(p for p in root.rglob('*') if p.is_file() and '.git' not in p.relative_to(root).parts and '__pycache__' not in p.relative_to(root).parts and p.name != 'SHA256SUMS.txt')
with open(root / 'SHA256SUMS.txt', 'w', encoding='utf-8', newline='\n') as out:
    out.write(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.relative_to(root).as_posix() + '\n' for p in files))
print(f'Hashed {len(files)} files')
