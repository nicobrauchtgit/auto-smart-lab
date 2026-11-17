import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { PYTHON } from "../training/testing.js";

test("clustering worker fits inputs only and confirms a two-row seal in both execution modes", () => {
 const output = execFileSync(PYTHON, ["-c", `
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import confirm
with tempfile.TemporaryDirectory() as temporary:
    root = Path(temporary)
    (root / 'solutions').mkdir()
    (root / 'solutions' / 'partition.py').write_text("""
class Partition:
    def fit(self, frame):
        assert frame['id'].tolist() == ['dev-a', 'dev-b']
        self.ready = True
    def predict(self, frame):
        assert self.ready and frame['id'].tolist() == ['sealed-a', 'sealed-b']
        return [-1, 4]
    def fit_predict(self, frame):
        assert frame['id'].tolist() == ['sealed-a', 'sealed-b']
        return [-1, 4]
def build_pipeline(context):
    return Partition()
""")
    dev, sealed = root / 'dev.json', root / 'sealed.json'
    dev.write_text(json.dumps({'schemaVersion': 1, 'samples': [
        {'id': 'dev-a', 'input': {}, 'target': 'alpha'},
        {'id': 'dev-b', 'input': {}, 'target': 'beta'}]}))
    sealed.write_text(json.dumps({'schemaVersion': 1, 'samples': [
        {'id': 'sealed-a', 'input': {}, 'target': 'alpha'}, {'id': 'sealed-b', 'input': {}, 'target': 'beta'}]}))
    for execution in ('batch', 'inductive'):
        directory = root / execution
        directory.mkdir()
        freeze = dict(taskId='fixture', experimentId='one', source={}, pipeline={'module': 'solutions/partition.py', 'factory': 'build_pipeline'},
            holdout={'perClass': {'alpha': 1, 'beta': 1}, 'rows': 2}, readCount=1, identity='frozen', population='tiny',
            origin={}, cvMean=.5, seed=13, bootstrapSeed=42, kind='clustering', execution=execution,
            sourceRoot=str(root), developmentManifest=str(dev), validationManifest=str(sealed), hashes={})
        (directory / 'freeze.json').write_text(json.dumps(freeze))
        confirm.run(directory)
        result = confirm.validate(directory)
        assert result['metrics']['external']['adjustedRandIndex'] == 1
        assert result['interval']['lower'] == result['interval']['upper'] == 1
print('ok')
`, join(import.meta.dir, "../training/python")], { encoding: "utf8", timeout: 30_000 });
 expect(output.trim().endsWith("ok")).toBe(true);
}, 30_000);
