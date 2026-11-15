/**
 * What data and ideas scouts find in their folder, staged from stream B's
 * TaskData before every call: task.md (unit introduction, then the task text),
 * profile.json, the unit's course resources and a research/ folder. The
 * folder lives in the shared tree's ignored scratch space (run/sandbox.ts).
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { scoutWorkspace } from "../run/sandbox.js";
import { stageCourseResources, type CourseResourceInput } from "../research/resources.js";
import type { TaskData } from "./contracts.js";

export interface ScoutInputs {
 /** The scout folder (the sandbox cwd). */
 root: string;
 /** Read-only development and test inputs, one per line, for the data prompt. */
 dataPaths: string;
 /** Staged course resources, one per line, or a line saying there are none. */
 resources: string;
}

export function stageScoutInputs(data: TaskData, resources: readonly CourseResourceInput[]): ScoutInputs {
 const root = scoutWorkspace(data);
 mkdirSync(join(root, "research"), {recursive: true});
 if (!existsSync(data.taskPath)) throw new Error("Task data has no task.md; resume task data preparation");
 if (!existsSync(data.profilePath)) throw new Error("Task data has no profile; resume task data preparation");
 copyFileSync(data.taskPath, join(root, "task.md"));
 copyFileSync(data.profilePath, join(root, "profile.json"));
 stageCourseResources(root, [...resources]);
 const inputs: [string, string | undefined][] = [
  ["development archive (training rows you may see)", data.developmentArchive ?? data.devZip],
  ["development manifest (sample IDs, archive members and targets)", data.developmentManifest ?? data.sampleManifestPath],
  ["test archive (unlabelled)", data.testArchive ?? data.testZip],
 ];
 return {
  root,
  dataPaths: inputs.filter(([, path]) => path && existsSync(path)).map(([label, path]) => `- \`${path}\`: ${label}`).join("\n"),
  resources: resources.length ? resources.map(({resource}) => `- \`${relative(root, join(root, resource.path))}\`: ${resource.title}`).join("\n")
   : "- none: this unit supplies no course material",
 };
}
