/**
 * Census of agent-written Python and where data loading is implemented.
 *
 * Read-operation census: imports and path mentions alone are not evidence.
 * Unknown path provenance is reported separately from confirmed task reads.
 *
 * Attribution: task folders and solutions/ are reused between runs, so a file
 * is placed by its modification time relative to the run window: before, during
 * or after. mtime records only the last change; a file written in an earlier
 * run and edited later counts as "during" the later run.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { place, type ScorecardLayout } from "./layout.js";

export type Period = "before" | "during" | "after";
export interface PythonFile {
 /** Relative to the runs directory. */
 path: string;
 folder: string;
 role: "agent" | "shared" | "copy" | "unclassified";
 lines: number;
 modifiedAt: number;
 period: Period;
 opensData: boolean;
 uncertainDataRead: boolean;
 readsCache: boolean;
 /** Paths (runs-relative) of census files this file imports. */
 imports: string[];
}
export interface FolderTotal { folder: string; role: PythonFile["role"]; files: number; lines: number; linesDuring: number; filesDuring: number; filesAfter: number }
export interface CodeCensus {
 files: PythonFile[];
 folders: FolderTotal[];
 /** Present at the run's end as far as mtimes tell (before + during), copies excluded. */
 loaderImplementations: string[];
 uncertainLoaders: string[];
 loaderFolders: string[];
 loaderImporters: string[];
 cacheReaders: string[];
 agentPythonOutsideSolutions: { files: number; lines: number; linesDuring: number };
 /** During-run files importing a module that was last changed before the run. */
 reusedExisting: { file: string; imports: string }[];
 changedAfterRun: number;
 moduleIndex: { path: string; exists: boolean; missing: string[] };
}

const READ = /(?:\b(?:ZipFile|read_csv|read_table|read_parquet|read_json|read_excel|read_pickle|imread|fromfile|load_npz)|\b(?:tarfile|Image|np|numpy|pickle|joblib)\.(?:open|load)|\bopen|\.read_bytes|\.read_text)\s*\(([^)\n]*)\)/g;
/** Conservative static evidence; dynamic paths cannot prove which dataset was read. */
export function dataReads(source: string, dataFiles: string[]): { confirmed: boolean; uncertain: boolean } {
 const text = source.split("\n").map(line => line.replace(/#.*$/, "").replace(/(?:^|;)\s*(?:from\s+[^;]+|import\s+[^;]+)(?=;|$)/g, "")).join("\n");
 const operations = [...text.matchAll(READ)].filter(m => !/[, ]+["'](?:w|a|x)[bt+]*["']/.test(m[1]));
 // Calls using a path variable are confirmed only when its assignment names task data.
 const assignments = new Map([...text.matchAll(/\b(\w+)\s*=\s*([^\n]+)/g)].map(m => [m[1], m[2]]));
 let confirmed = false, uncertain = false;
 for (const m of operations) {
  let argument = m[1];
  const variable = /^\s*(\w+)\s*(?:,|$)/.exec(argument)?.[1];
  if (variable && assignments.has(variable)) argument += assignments.get(variable);
  if (dataFiles.some(file => argument.includes(file))) confirmed = true;
  else uncertain = true;
 }
 return { confirmed, uncertain };
}
const CACHE = /\bnp\.load\s*\(|\bnumpy\.load\s*\(|\bpickle\.load\s*\(|\bjoblib\.load\s*\(|\bread_parquet\s*\(|\bload_npz\s*\(/;
const IMPORT = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w., ]+))/gm;

function walk(directory: string, skip: (path: string) => boolean, out: string[] = []): string[] {
 if (!existsSync(directory) || skip(directory)) return out;
 for (const entry of readdirSync(directory, { withFileTypes: true })) {
  if (entry.name === ".git" || entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "node_modules") continue;
  const path = join(directory, entry.name);
  if (entry.isDirectory()) walk(path, skip, out);
  else if (entry.isFile() && entry.name.endsWith(".py")) out.push(path);
 }
 return out;
}


export function codeCensus(options: { runsDir: string; task: string; layout: ScorecardLayout; window: { start: number; end: number }; dataFiles: string[] }): CodeCensus {
 const { runsDir, task, layout, window } = options;
 const abs = (template: string) => resolve(runsDir, place(template, { task }));
 const owned = layout.harnessOwned.map(abs);
 const skip = (path: string) => owned.some(root => path === root || path.startsWith(root + sep));
 const folders = layout.codeFolders.map(folder => ({ ...folder, abs: abs(folder.path) })).sort((a, b) => b.abs.length - a.abs.length);
 const solutionsRoot = abs(layout.solutionsRoot);
 const paths = [...new Set([...walk(resolve(runsDir, task), skip), ...walk(solutionsRoot, skip)])].sort();
 const rel = (path: string) => relative(runsDir, path);
 const texts = new Map(paths.map(path => [path, readFileSync(path, "utf8")]));

 const resolveImport = (from: string, module: string): string | undefined => {
  const parts = module.split(".");
  for (const base of [dirname(from), solutionsRoot]) {
   for (const candidate of [join(base, ...parts) + ".py", join(base, ...parts, "__init__.py")]) if (texts.has(candidate)) return candidate;
  }
  return undefined;
 };

 const files: PythonFile[] = paths.map(path => {
  const text = texts.get(path)!;
  const folder = folders.find(f => path === f.abs || path.startsWith(f.abs + sep));
  const modifiedAt = statSync(path).mtimeMs;
  const imports = new Set<string>();
  for (const match of text.matchAll(IMPORT)) {
   const modules = match[1] ? [match[1]] : match[2].split(",").map(item => item.trim().split(/\s+/)[0]);
   for (const module of modules) { const target = module && resolveImport(path, module); if (target && target !== path) imports.add(rel(target)); }
  }
  const reads = dataReads(text, options.dataFiles);
  return {
   path: rel(path), folder: folder ? folder.label : "unclassified", role: folder ? folder.role : "unclassified",
   lines: text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
   modifiedAt, period: modifiedAt < window.start ? "before" : modifiedAt <= window.end ? "during" : "after",
   opensData: reads.confirmed, uncertainDataRead: reads.uncertain, readsCache: CACHE.test(text), imports: [...imports].sort(),
  };
 });

 const atEnd = files.filter(file => file.period !== "after" && file.role !== "copy");
 const loaders = atEnd.filter(file => file.opensData);
 const loaderPaths = new Set(loaders.map(file => file.path));
 const byPath = new Map(files.map(file => [file.path, file]));
 const totals = new Map<string, FolderTotal>();
 for (const file of files) {
  const total = totals.get(file.folder) ?? { folder: file.folder, role: file.role, files: 0, lines: 0, linesDuring: 0, filesDuring: 0, filesAfter: 0 };
  total.files++; total.lines += file.lines;
  if (file.period === "during") { total.filesDuring++; total.linesDuring += file.lines; }
  if (file.period === "after") total.filesAfter++;
  totals.set(file.folder, total);
 }
 const outside = atEnd.filter(file => file.role === "agent" || file.role === "unclassified");
 const indexPath = abs(layout.moduleIndex);
 const indexText = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : undefined;
 const solutionModules = atEnd.filter(file => file.role === "shared" && basename(file.path) !== "__init__.py");
 return {
  files,
  folders: [...totals.values()],
  loaderImplementations: loaders.map(file => file.path),
  uncertainLoaders: atEnd.filter(file => file.uncertainDataRead).map(file => file.path),
  loaderFolders: [...new Set(loaders.map(file => file.folder))],
  loaderImporters: atEnd.filter(file => !file.opensData && file.imports.some(path => loaderPaths.has(path))).map(file => file.path),
  cacheReaders: atEnd.filter(file => file.readsCache && !file.opensData).map(file => file.path),
  agentPythonOutsideSolutions: { files: outside.length, lines: outside.reduce((sum, file) => sum + file.lines, 0), linesDuring: outside.filter(file => file.period === "during").reduce((sum, file) => sum + file.lines, 0) },
  reusedExisting: files.filter(file => file.period === "during").flatMap(file => file.imports.filter(path => byPath.get(path)?.period === "before").map(imports => ({ file: file.path, imports }))),
  changedAfterRun: files.filter(file => file.period === "after").length,
  moduleIndex: { path: rel(indexPath), exists: indexText !== undefined,
   missing: indexText === undefined ? [] : solutionModules.map(file => relative(solutionsRoot, resolve(runsDir, file.path)))
    .filter(module => !indexText.includes(module) && !indexText.includes(module.replace(/\.py$/, "").replaceAll("/", "."))) },
 };
}
