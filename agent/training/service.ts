/**
 * Adapter from an agent-authored experiment request to the one fixed training
 * worker the harness owns. The generic process supervisor remains reusable,
 * but the solve agent never chooses an executable, cwd, output directory, or
 * seed through this boundary.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { ExperimentSupervisor } from "../experiments/supervisor.js";
import { parseExperimentRequest } from "./contract.js";
import { createSeedPlan, deriveTrialSeed, writeSeedPlan } from "./seeds.js";
import type { ExperimentRequest } from "./types.js";

export interface TrainingServiceOptions {
	supervisor: Pick<ExperimentSupervisor, "start">;
	pythonExecutable: string;
	projectRoot: string;
	trainingRoot: string;
	taskId: string;
	datasetSha256: string;
	rootSeed: number;
	zipPath: string;
	labelsPath: string;
	/** Project-relative roots from which agent-authored Python may be loaded. */
	allowedModuleRoots?: readonly string[];
	/** Maximum trials this session may start; the agent may always stop earlier. */
	maxExperiments?: number;
}

export interface StartedTrainingExperiment {
	id: string;
	directory: string;
	request: ExperimentRequest;
	view: ReturnType<ExperimentSupervisor["start"]>;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
	const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} catch (error) {
		await unlink(temporary).catch(() => undefined);
		throw error;
	}
}

function scopeSummary(request: ExperimentRequest): string {
	if (request.scope.kind === "promotion") return "complete promotion validation";
	const limits = [
		request.scope.maxRows === undefined ? undefined : `${request.scope.maxRows} rows`,
		request.scope.maxFolds === undefined ? undefined : `${request.scope.maxFolds} folds`,
	].filter(Boolean);
	return `pilot${limits.length ? `: at most ${limits.join(", ")}` : ""}`;
}

function validateModuleOwnership(
	projectRoot: string,
	module: string,
	allowedRoots: readonly string[],
	field: string,
): void {
	const absolute = resolve(projectRoot, module);
	const owned = allowedRoots.some((root) => {
		const boundary = resolve(projectRoot, root);
		return absolute === boundary || absolute.startsWith(`${boundary}${sep}`);
	});
	if (!owned) {
		throw new Error(`${field} must be under ${allowedRoots.map((root) => `${root.replace(/\/$/, "")}/`).join(" or ")}`);
	}
	if (!existsSync(absolute)) {
		throw new Error(`${field} does not exist: ${relative(projectRoot, absolute)}`);
	}
}

export class TrainingService {
	private started = 0;

	constructor(private readonly options: TrainingServiceOptions) {}

	/** Persist identity and inputs before spawning the harness-owned worker. */
	async start(raw: unknown, requestedByToolCallId?: string): Promise<StartedTrainingExperiment> {
		const request = parseExperimentRequest(raw);
		if (this.options.maxExperiments !== undefined && this.started >= this.options.maxExperiments) {
			throw new Error(`training experiment budget exhausted (${this.options.maxExperiments})`);
		}
		const allowedRoots = this.options.allowedModuleRoots ?? ["solutions"];
		validateModuleOwnership(this.options.projectRoot, request.pipeline.module, allowedRoots, "experiment.pipeline.module");
		if (request.cv.kind === "factory") {
			validateModuleOwnership(this.options.projectRoot, request.cv.module, allowedRoots, "experiment.cv.module");
		}
		const id = randomUUID();
		const directory = join(this.options.trainingRoot, id);
		await mkdir(directory, { recursive: true });

		const seedPlan = createSeedPlan({
			rootSeed: this.options.rootSeed,
			taskId: this.options.taskId,
			datasetSha256: this.options.datasetSha256,
			experimentId: id,
		});
		const requestPath = join(directory, "request.json");
		const seedPlanPath = join(directory, "seed-plan.json");
		const invocationPath = join(directory, "invocation.json");
		await writeJsonAtomic(requestPath, request);
		await writeSeedPlan(seedPlanPath, seedPlan);
		await writeJsonAtomic(invocationPath, {
			schemaVersion: 1,
			experimentId: id,
			request,
			inputs: {
				projectRoot: this.options.projectRoot,
				zipPath: this.options.zipPath,
				labelsPath: this.options.labelsPath,
				outputDir: directory,
			},
			seeds: {
				experiment: seedPlan.experimentSeed,
				// The first worker supports one candidate. Candidate/search adapters
				// will allocate further trial coordinates through the same seed plan.
				trial: deriveTrialSeed(seedPlan, 0),
			},
		});

		const worker = join(this.options.projectRoot, "agent", "training", "python", "worker.py");
		const view = this.options.supervisor.start({
			argv: [this.options.pythonExecutable, worker, "--invocation", invocationPath],
			cwd: this.options.projectRoot,
			hypothesis: request.hypothesis,
			scope: scopeSummary(request),
		}, requestedByToolCallId, id);
		this.started++;
		return { id, directory, request, view };
	}
}
