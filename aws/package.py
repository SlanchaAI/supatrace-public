#!/usr/bin/env python3
"""Package installed pinned dependencies and AWS runtime files locally. No uploads."""
import pathlib,zipfile,hashlib
root=pathlib.Path(__file__).resolve().parents[1]
out=root/'supatrace-lambda.zip'
if not (root/'node_modules/@aws-sdk/client-s3/package.json').exists():raise SystemExit('Run npm ci --omit=dev --ignore-scripts first')
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
 for directory in ['node_modules']:
  for path in sorted((root/directory).rglob('*')):
   if path.is_file():archive.write(path,path.relative_to(root))
 for name in ['aws/handler.mjs','aws/stripe-worker.mjs','aws/stripe-entitlement-worker.mjs','aws/stripe-usage-meter-worker.mjs','package.json','package-lock.json']:archive.write(root/name,name)
 for path in sorted((root/'src').rglob('*.mjs')):
  if path.is_file():archive.write(path,path.relative_to(root).as_posix())
 # The runtime bundle includes vendored parser modules; retain their license and
 # pin/adaptation record in every distributed copy even though import is local-only.
 for name in ['LICENSE','provenance.json','source-pins.json']:
  path=root/'src/importers/vendor/hue'/name
  if path.is_file():archive.write(path,path.relative_to(root).as_posix())
 for name in ['LICENSE','provenance.json','langsmith-provenance.json']:
  path=root/'src/importers/vendor/kitaru'/name
  if path.is_file():archive.write(path,path.relative_to(root).as_posix())
print(out.name, out.stat().st_size, 'bytes', hashlib.sha256(out.read_bytes()).hexdigest())
