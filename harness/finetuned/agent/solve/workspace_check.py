"""Static workspace checks without importing authored code.
Input: solutions root and task; output: JSON findings and measurements.
"""
import ast
import hashlib
import json
import sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
errors, warnings, bodies, blocking = [], [], {}, []
index = (root / 'INDEX.md').read_text() if (root / 'INDEX.md').exists() else ''
files = [p for p in root.rglob('*.py') if not any(x in p.relative_to(root).parts for x in ('scratch', '.git', '__pycache__'))]
imports, loaders = 0, 0
for path in files:
    name = path.relative_to(root).as_posix()
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        # Symlinked or escaping sources cannot be frozen for a trial or refit.
        errors.append(f'{name}: unsafe source path'); blocking.append(f'{name}: unsafe source path'); continue
    if name.split('/')[0] not in ('tasks', 'lib', 'checks', 'research'):
        errors.append(f'{name}: stray Python')
    if name not in index: errors.append(f'{name}: missing index entry')
    try:
        text = path.read_text()
        tree = ast.parse(text)
    except (SyntaxError, UnicodeError) as error:
        errors.append(f'{name}: {error}'); continue
    doc = ast.get_docstring(tree)
    if not doc or len(doc.splitlines()) < 2: errors.append(f'{name}: missing two-line purpose/input-output docstring')
    if len(text.splitlines()) > 400: warnings.append(f'{name}: over 400 lines')
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            imports += 1
        if isinstance(node, ast.Call) and ('ZipFile' in ast.unparse(node.func) or 'read_csv' in ast.unparse(node.func)):
            loaders += 1
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            key = hashlib.sha256(ast.dump(ast.Module(body=node.body, type_ignores=[])).encode()).hexdigest()
            if key in bodies: warnings.append(f'{name}:{node.lineno}: duplicate function body with {bodies[key]}')
            bodies[key] = f'{name}:{node.lineno}'
import re
for name in re.findall(r'`([^`]+\.py)`', index):
    if not (root / name).is_file(): errors.append(f'{name}: indexed path does not exist')
print(json.dumps(dict(valid=not errors, errors=errors, warnings=warnings, blocking=blocking, measurements=dict(pythonFiles=len(files), imports=imports, archiveLoaders=loaders))))
