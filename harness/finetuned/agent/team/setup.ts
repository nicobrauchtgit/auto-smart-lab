import type { SetupRequirement } from "../pipeline/setup.js";
import type { ScoutRole } from "./contracts.js";
export function scoutRequirements(role: ScoutRole): SetupRequirement[] {
 return ["scouts", "observability", "model", "python", "task", "course-resources", "solve-isolation",
  ...(role === "data" ? ["data-profile" as const] : []), ...(role === "ideas" ? ["web-search" as const] : [])];
}
