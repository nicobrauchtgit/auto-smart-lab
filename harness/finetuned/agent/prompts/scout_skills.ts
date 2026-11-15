/** Lead-only, on-demand Pi skills rendered from the run's immutable snapshot. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import type { PromptSnapshot } from "./loader.js";

export const SCOUT_SKILL_IDS = ["team.skill-data", "team.skill-ideas", "team.skill-validation"] as const;

export function stageScoutSkills(prompts: PromptSnapshot, taskRoot: string) {
 const directory = join(taskRoot, "lead-skills", prompts.fingerprint);
 mkdirSync(directory, { recursive: true });
 const rendered = SCOUT_SKILL_IDS.map(id => prompts.render(id, {}));
 const paths = rendered.map((prompt, index) => {
  const path = join(directory, `scout-${["data", "ideas", "validation"][index]}.md`);
  writeFileSync(path, prompt.text);
  return path;
 });
 const result = loadSkills({ cwd: directory, agentDir: directory, skillPaths: paths, includeDefaults: false });
 if (result.diagnostics.length || result.skills.length !== 3) throw new Error("Invalid explicit scout skills");
 return { skills: result.skills, references: rendered.map(prompt => prompt.reference) };
}
