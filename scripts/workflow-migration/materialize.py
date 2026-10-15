#!/usr/bin/env python3
"""One-time transport for the reviewed local implementation. Never deploys or merges."""
from pathlib import Path
import base64, hashlib, json, lzma, re, subprocess

HERE = Path(__file__).resolve().parent
blob = base64.b64decode(''.join((HERE / f'payload-{i}.b64').read_text().strip() for i in range(1, 7)), validate=True)
EXPECTED = 'b4e97c28fdaa27a2dc2dffc5f7a0331425c7333d72ec222520a963729d09deee'
if hashlib.sha256(blob).hexdigest() != EXPECTED:
    raise SystemExit('Transport checksum mismatch; no source changes applied.')
bundle = json.loads(lzma.decompress(blob))
allowed = {'agreement-clauses.js','agreement-defaults.json','ai-document.js','ai.js','db.js','document-extract.js','index.html','lawyer-changes.js','server.js','test/fixtures/workflow-seeds.json','test/lawyer-changes.test.js','test/upload-limits.test.js','test/workflow-api.test.js','test/workflow-core.test.js','upload-limits.js','workflow-api.js','workflow-core.js','workflow-ui.js'}
if set(bundle['patches']) | set(bundle['files']) != allowed:
    raise SystemExit('Unexpected file set; aborting.')
def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()
expected = {p: x['after'] for p, x in bundle['patches'].items()}
expected.update({p: digest(s) for p, s in bundle['files'].items()})
if all(Path(p).exists() and digest(Path(p).read_text()) == h for p, h in expected.items()):
    print('Exact implementation is already present.')
    raise SystemExit(0)
# Derive complete legal wording from the old builders, rather than transcribing it.
script = Path('.git/workflow-extract.cjs')
script.write_text(bundle['generator'])
subprocess.run(['node', str(script)], check=True)
f = Path('agreement-clauses.js')
f.write_text(re.sub(r'render:function\(data\)\{return prose\((.*)\);\}\}', r'items:function(data){return \1;},render:function(data){return prose(this.items(data));}}', f.read_text()))
changes = {}
for name, patch in bundle['patches'].items():
    text = Path(name).read_text()
    if digest(text) != patch['before']:
        raise SystemExit('Unexpected source version: ' + name)
    for start, end, replacement in reversed(patch['edits']):
        text = text[:start] + replacement + text[end:]
    if digest(text) != patch['after']:
        raise SystemExit('Result checksum mismatch: ' + name)
    changes[name] = text
changes.update(bundle['files'])
for name, text in changes.items():
    target = Path(name)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    assert digest(target.read_text()) == expected[name]
print('All 18 implementation files reproduced and checked byte for byte.')
