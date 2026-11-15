import type { SetupRequirement } from "../pipeline/setup.js";
import type { ScoutRole } from "./contracts.js";
/** Everything one scout role needs before its session starts; the lead's stage declares the union. */
export function scoutRequirements(role: ScoutRole): SetupRequirement[] {
 return ["scouts", "observability", "model", "python", "task", "solve-isolation",
  ...(role === "validation" ? ["trial-checks" as const] : ["course-resources" as const]), ...(role === "ideas" ? ["web-search" as const] : [])];
}
