/** Development-only, offline inventory. Reads only tracked, allowlisted source paths. */
import tsVersion from "typescript";
import * as ts from "typescript/unstable/ast";
import { API } from "typescript/unstable/async";
import { createVirtualFileSystem } from "typescript/unstable/fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("../", import.meta.url)));
function command(cmd: string, args: string[], input?: string): string {
 const result = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
 if (result.error || result.status !== 0) throw new Error(`${cmd} failed: ${result.error?.message ?? result.stderr}`);
 return result.stdout;
}
async function typescript(items: {path: string; text: string}[]) {
 const files = Object.fromEntries(items.map(r => [`/inventory/${r.path}`, r.text]));
 const config = "/inventory/tsconfig.json";
 files[config] = JSON.stringify({compilerOptions: {noLib: true, noResolve: true, allowJs: true, types: []}, files: Object.keys(files)});
 const virtual = createVirtualFileSystem(files);
 const api = new API({cwd: "/inventory", fs: {...virtual, readFile: path => virtual.readFile!(path) ?? null}});
 try {
  const snapshot = await api.updateSnapshot({openProjects: [config]});
  const program = snapshot.getProject(config)!.program;
  return new Map(await Promise.all(items.map(async item => {
   const path = `/inventory/${item.path}`;
   if ((await program.getSyntacticDiagnostics(path)).length) throw new Error(`Parse error: ${item.path}`);
   const source = (await program.getSourceFile(path))!;
   let functions = 0, classes = 0;
   function visit(node: ts.Node) {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
      || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.body) functions++;
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) classes++;
    node.forEachChild(visit);
   }
   visit(source); return [item.path, {functions, classes}] as const;
  })));
 } finally { await api.close(); }
}
const pythonProgram = `import ast,json,sys
out=[]
for item in json.load(sys.stdin):
 tree=ast.parse(item["text"],filename=item["path"])
 nodes=list(ast.walk(tree))
 out.append({"functions":sum(isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef,ast.Lambda)) for n in nodes),"classes":sum(isinstance(n,ast.ClassDef) for n in nodes)})
json.dump(out,sys.stdout)`;
function python(items: {path: string; text: string}[]) {
 return JSON.parse(command(`${process.env.VENV_DIR ?? "harness/finetuned/.venv"}/bin/python`, ["-c", pythonProgram], JSON.stringify(items))) as {functions: number; classes: number}[];
}
if (process.argv.includes("--self-test")) {
 const t = (await typescript([{path: "fixture.ts", text: "declare function signature(): void; class C { constructor() {} get x() { return 1 } m() { return () => function() {} } }"}])).get("fixture.ts")!;
 const [p] = python([{path: "fixture.py", text: "class C:\n def m(self):\n  async def nested(): pass\n  return lambda: 1\n"}]);
 if (t.functions !== 5 || t.classes !== 1 || p.functions !== 3 || p.classes !== 1) throw new Error("AST category regression");
 console.log("Inventory AST self-test passed"); process.exit(0);
}
const excluded = /(^|\/)(node_modules|vendor|generated|dist|build|coverage|runs|units|\.tools|\.venv|fixtures|__fixtures__)(\/|$)|\.d\.[cm]?ts$|\.generated\./;
const paths = command("git", ["ls-files", "-z"]).split("\0").filter(path =>
 /^(harness\/(minimal|finetuned)\/|experiment\/|scripts\/|docs\/redesign-[^/]+-reference\.py$)/.test(path)
 && /\.(?:[cm]?[jt]sx?|py)$/.test(path) && !excluded.test(path)).sort();
const records = paths.map(path => ({path, bytes: readFileSync(path)}));
const snapshot = createHash("sha256");
for (const r of records) snapshot.update(r.path).update("\0").update(String(r.bytes.length)).update("\0").update(r.bytes).update("\0");
const pyItems = records.filter(r => r.path.endsWith(".py"));
const pyCounts = python(pyItems.map(r => ({path: r.path, text: r.bytes.toString("utf8")})));
const pyByPath = new Map(pyItems.map((r, i) => [r.path, pyCounts[i]]));
const tsByPath = await typescript(records.filter(r => !r.path.endsWith(".py")).map(r => ({path:r.path,text:r.bytes.toString("utf8")})));
const rows = records.map(r => {
 const text = r.bytes.toString("utf8");
 const parts = r.path.split("/");
 const arm = parts[0] === "harness" ? parts[1] : "shared/development";
 const module = parts[0] === "harness" ? (parts[2] === "agent" ? `agent/${parts[3]?.includes(".") ? "entrypoints" : parts[3]}` : parts[2]) : parts[0];
 const role = /(^|\/)(__tests__|tests)(\/|$)|(^|\/)(test_[^/]+\.py|[^/]+\.(test|spec)\.[^/]+)$|(^|\/)(testing|fixture-live)\.[^/]+$/.test(r.path) ? "test/support" : "production/tooling";
 const language = r.path.endsWith(".py") ? "Python" : /\.[cm]?jsx?$/.test(r.path) ? "JavaScript" : "TypeScript";
 return {path: r.path, arm, module, role, language, lines: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
  ...(pyByPath.get(r.path) ?? tsByPath.get(r.path)!)};
});
type Total = {files: number; lines: number; functions: number; classes: number};
function total(items: typeof rows): Total {
 return items.reduce((a,r) => ({files:a.files+1,lines:a.lines+r.lines,functions:a.functions+r.functions,classes:a.classes+r.classes}), {files:0,lines:0,functions:0,classes:0});
}
const lines = ["# Generated source inventory", "", "Regenerate from the repository root: `./dev bun scripts/code-inventory.ts`.", "Check freshness: `./dev bun scripts/code-inventory.ts --check`. Category fixtures: `./dev bun scripts/code-inventory.ts --self-test`.", "", `Source snapshot SHA-256: \`${snapshot.digest("hex")}\`.`, `Generator SHA-256: \`${createHash("sha256").update(readFileSync("scripts/code-inventory.ts")).digest("hex")}\`.`, `Parser: TypeScript ${tsVersion.version}; ${command(`${process.env.VENV_DIR ?? "harness/finetuned/.venv"}/bin/python`, ["--version"]).trim()}.`, "", "## Scope and interpretation", "", "Only git-tracked TS/JS (including JSX, TSX, m/c variants) and Python under harness/, experiment/, scripts/, plus docs/redesign-*-reference.py are read. Working-tree bytes, including staged edits, are measured; add new sources to the index before regenerating. Other root code, Markdown, JSON, shell and lockfiles are outside the metrics. Excluded: node_modules, vendor, generated, dist, build, coverage, runs, units, .tools, .venv, fixtures, __fixtures__, declaration .d.ts/.d.mts/.d.cts and .generated. files. Fixtures are excluded rather than assigned to production. Historical/legacy tracked source remains included. No run data, secrets or model APIs are read.", "", "Physical lines count LF-delimited lines, including comments and blank lines; a trailing LF does not add a line, empty files count zero. CRLF counts once. TS/JS counts body-bearing function declarations, expressions, arrows, methods, constructors and get/set accessors, recursively including anonymous callbacks and nested functions. Signatures/overloads without bodies and function types are excluded; a default constructor is not invented. Python ast counts def, async def and lambda recursively, including methods and nested definitions. Classes count declarations/expressions in TS/JS and ClassDef in Python. Counts describe syntax, not unique behavior, complexity or quality.", "", "Test/support means tests/ or __tests__/ paths, test_*.py, *.test.* or *.spec.*, and testing.* or fixture-live.* helpers. All other included source is labelled production/tooling, including development scripts and hand-made references; this heuristic is not a runtime-reachability claim. Module groups are arm agent subdirectory (loose files: entrypoints) or top-level source directory.", "", "The source digest hashes sorted path + NUL + byte length + NUL + bytes + NUL per included file. The report itself and commit IDs are excluded: committing a report cannot invalidate it. Generator identity is also recorded separately. There are no timestamps or machine paths in the output; identical inputs and parser versions produce identical output.", "", "## Totals by arm, language and role", "", "| Arm | Language | Role | Files | Lines | Callables | Classes |", "| --- | --- | --- | ---: | ---: | ---: | ---: |"];
function table(keys: string[], select: (r: typeof rows[number]) => string) {
 for (const key of keys) { const t=total(rows.filter(r=>select(r)===key)); lines.push(`| ${key.replaceAll(" / "," | ")} | ${t.files} | ${t.lines} | ${t.functions} | ${t.classes} |`); }
}
const group=(r: typeof rows[number])=>`${r.arm} / ${r.language} / ${r.role}`;
table([...new Set(rows.map(group))].sort(), group);
const all=total(rows); lines.push("", `**All included source:** ${all.files} files; ${all.lines} physical lines; ${all.functions} callables; ${all.classes} classes.`, "", "## Module and language totals (both roles)", "", "| Arm | Module | Language | Files | Lines | Callables | Classes |", "| --- | --- | --- | ---: | ---: | ---: | ---: |");
const moduleGroup=(r: typeof rows[number])=>`${r.arm} / ${r.module} / ${r.language}`;
table([...new Set(rows.map(moduleGroup))].sort(),moduleGroup);
for (const role of ["production/tooling", "test/support"]) {
 lines.push("", `## Longest ${role} files (top 20)`, "", "| Path | Lines | Callables | Classes |", "| --- | ---: | ---: | ---: |");
 for (const r of rows.filter(r=>r.role===role).sort((a,b)=>b.lines-a.lines || (a.path < b.path ? -1 : 1)).slice(0,20)) lines.push(`| [${r.path}](../${r.path}) | ${r.lines} | ${r.functions} | ${r.classes} |`);
}
const output=lines.join("\n")+"\n", target="docs/code-inventory.md";
if (process.argv.includes("--check")) { if (readFileSync(target,"utf8")!==output) throw new Error("Inventory stale: regenerate"); console.log("Inventory fresh"); }
else { writeFileSync(target,output); console.log(JSON.stringify(all)); }
