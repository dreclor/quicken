# Download the two pinned evaluation candidates; verify byte count and SHA-256.
# Run from the project root: python3 scripts/download-comparison-models.py
from pathlib import Path
import json,urllib.request,hashlib,concurrent.futures,time
models=json.loads(Path('verification/model-candidates.json').read_text())
cache=Path.home()/'Library/Caches/Quicken/model-comparison';cache.mkdir(parents=True,exist_ok=True)
def get(m):
 target=cache/m['file']
 if target.exists() and target.stat().st_size==m['bytes'] and hashlib.file_digest(target.open('rb'),'sha256').hexdigest()==m['sha']:
  print(m['id']+' already verified',flush=True);return
 part=target.with_suffix('.partial');h=hashlib.sha256();size=0;last=time.monotonic()
 with urllib.request.urlopen(m['url'],timeout=60) as r,part.open('wb') as w:
  while b:=r.read(1024*1024):
   w.write(b);h.update(b);size+=len(b)
   if time.monotonic()-last>20: print(f"{m['id']} {size/m['bytes']:.0%}",flush=True);last=time.monotonic()
 if size!=m['bytes'] or h.hexdigest()!=m['sha']:raise ValueError('Download verification failed: '+m['id'])
 part.rename(target);print(m['id']+' verified',flush=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as p:list(p.map(get,models))
