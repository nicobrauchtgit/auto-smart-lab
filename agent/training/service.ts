/**
 * Adapter from an agent-authored experiment request to the one fixed training
 * worker the harness owns. The generic process supervisor remains reusable,
 * but the solve agent never chooses an executable, cwd, output directory, or
 * seed through this boundary.
 *
 * With a solutions repository configured, every trial runs from a detached
 * worktree of the commit it records, so later edits and branch switches never
 * change what a running or finished trial measured.
 */

import { selectionSummary } from "./selection_summary.js";
import { assertDevelopmentCandidate, isTerminalCandidate, selectionClaimAsync } from "./terminal.js";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { mkdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { atomicJson, claimWorkspace, liveGroup, ownedProcessAlive, type ProcessIdentity } from "../experiments/ownership.js";
import type { ExperimentRecord } from "../experiments/types.js";
import type { ExperimentSupervisor } from "../experiments/supervisor.js";
import { ExperimentRequestError, validateExperimentRequest } from "./contract.js";
import {
	addWorktree,
	git,
	isRepositoryRoot,
	removeWorktree,
	resolveCommit,
	tagCommit,
	tagMessage,
	uncommittedFiles,
	type SourceIdentity,
} from "./git.js";
import { pairedPromotion } from "./promotion.js";
import { runPipelineValidation, type PipelineValidator } from "./pipeline_validation.js";
import { collectTrainingResults } from "./results.js";
import { createSeedPlan, deriveTrialSeed, writeSeedPlan } from "./seeds.js";
import type { ExperimentRequest, JsonValue, MeasurementConfig, ValidationIssue } from "./types.js";

const PYTHON_ROOT = join(dirname(fileURLToPath(import.meta.url)), "python");
import { championTag } from "./development_selection.js";
export { championTag };

export interface SearchSettings {
	confirmAboveSeconds: number;
	overrunFactor: number;
	maxSeconds: number;
	validationTimeoutSeconds: number;
}

export interface TrainingServiceOptions {
	supervisor: Pick<ExperimentSupervisor, "start"> & Partial<Pick<ExperimentSupervisor, "attach" | "status" | "notify">>;
	recoveryRoots?: readonly string[];
	environmentFingerprint?: string;
	pipelineRunId?: string;
	stageInvocationId?: string;
	pythonExecutable: string;
	projectRoot: string;
	trainingRoot: string;
	taskId: string;
	datasetSha256: string;
	rootSeed: number;
	zipPath?: string;
	labelsPath?: string;
	/** Opaque development sample metadata and task scoring, supplied by the controller. */
	measurement?: MeasurementConfig;
	/** Project-relative roots from which agent-authored Python may be loaded. */
	allowedModuleRoots?: readonly string[];
	/** Maximum trials this session may start; the agent may always stop earlier. */
	maxExperiments?: number;
	/**
	 * The agent's git repository, normally `<projectRoot>/solutions`. When set,
	 * requests must come from a clean tree, modules must live inside it, and
	 * each trial runs from a worktree of its recorded commit.
	 */
	solutionsRoot?: string;
	/** Environment for validation processes; the supervisor owns the worker's. */
	env?: Record<string, string>;
	/** Layer 2 validation; replaceable in tests that have no Python. */
	validatePipeline?: PipelineValidator;
	search?: Partial<SearchSettings>;
	/** Report text included verbatim in search reports. */
	caveats?: readonly string[];
	/** Prose explaining how to reduce a stopped search's cost, from the prompt registry. */
	runtimeGuidance?: string;
	idLeakageGuidance?: string;
	/** Called once the source of a started trial is fixed; recorded as a supplied input. */
	onTrialStarted?: (trial: StartedTrialRecord) => void;
	/** Harness decisions mirrored under the shared pipeline identity. */
	record?: (eventType: string, payload: Record<string, unknown>) => void;
	/** Defaults to the harness's own worker; tests may run a temporary project. */
	workerPath?: string;
	/** Controller-owned filesystem boundary for every process loading agent code. */
	sandboxCommand?: (command: string[], input: { directory: string; sourceRoots: readonly string[] }) => string[];
	executionBoundaryFingerprint?: string;
}

export interface StartedTrainingExperiment {
	id: string;
	directory: string;
	request: ExperimentRequest;
	source?: SourceIdentity;
	view: ReturnType<ExperimentSupervisor["start"]>;
}

export interface StartedTrialRecord {
	id: string;
	directory: string;
	request: ExperimentRequest;
	source?: SourceIdentity;
	worktrees: string[];
	startedAt: number;
	champion?: { experimentId: string; commit: string };
	measurement?: MeasurementConfig & { sampleManifestSha256: string; hasTargets: boolean; evidenceManifestSha256?: string };
}

const DEFAULT_SEARCH: SearchSettings = {
	confirmAboveSeconds: 900,
	overrunFactor: 1.5,
	maxSeconds: 7_200,
	validationTimeoutSeconds: 60,
};

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
	const search = request.search
		? `search (${request.search.sampler ?? "tpe"}${request.search.maxConfigs ? `, up to ${request.search.maxConfigs} configurations` : ""}), `
		: "";
	if (request.scope.kind === "promotion") return `${search}complete promotion validation`;
	const limits = [
		request.scope.maxRows === undefined ? undefined : `${request.scope.maxRows} rows`,
		request.scope.maxFolds === undefined ? undefined : `${request.scope.maxFolds} folds`,
	].filter(Boolean);
	return `${search}pilot${limits.length ? `: at most ${limits.join(", ")}` : ""}`;
}

function readJson(path: string): Record<string, any> | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function readJsonLines(path: string): Record<string, any>[] {
	try {
		return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const primaryScore = (result: Record<string, any> | undefined) => result?.metrics?.selectionScore ?? result?.metrics?.adjustedRandIndex ?? result?.metrics?.balancedAccuracy ?? -Infinity;

/** Compact status view; detailed batch diagnostics remain in hashed trial artifacts. */
function compactDetail(value: any): any {
	if (Array.isArray(value)) return value.map(compactDetail);
	if (!value || typeof value !== "object") return value;
	const omitted = new Set(["contingency", "contingencySparse", "families", "clusters", "clusterSizes", "perCluster", "excessMass", "bins"]);
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (omitted.has(key)) continue;
		if (key === "groups" && Array.isArray(item)) {
			result.groups = item.slice(0, 8).map(compactDetail);
			result.totalGroups = item.length;
			result.shownGroups = Math.min(item.length, 8);
		} else result[key] = compactDetail(item);
	}
	return result;
}

export function compactDiagnostics(result: Record<string, any> | undefined): Record<string, unknown> | undefined {
	const signals = result?.diagnostics;
	if (!signals) return undefined;
	return { kind: signals.kind, primaryMetric: signals.primaryMetric, proxyEvidence: signals.proxyEvidence,
		uniqueRows: signals.uniqueRows, observations: signals.observations,
		foldSpread: signals.foldSpread, ranking: signals.ranking,
		foldSpreadIsConfidenceInterval: signals.foldSpreadIsConfidenceInterval,
		rankingAggregation: signals.rankingAggregation,
		fitSeconds: signals.fitSeconds, reachedLimit: signals.reachedLimit,
		stability: signals.stability ? { available: signals.stability.available, reason: signals.stability.reason,
			summary: signals.stability.summary, measuredComparisons: signals.stability.measuredComparisons,
			eligibleComparisons: signals.stability.eligibleComparisons } : undefined,
		metrics: result?.metrics,
		folds: Array.isArray(signals.folds) ? signals.folds.slice(0, 8).map((fold: any) => {
			return { repeat: fold.repeat, fold: fold.fold, metrics: fold.metrics, searchObjective: fold.searchObjective,
				diagnostics: compactDetail(fold.diagnostics ?? {}) };
		}) : undefined,
		completedDiagnosticFolds: signals.folds?.length,
		shownDiagnosticFolds: Math.min(signals.folds?.length ?? 0, 8),
		championComparison: result?.championComparison };
}

function canonical(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

/** What makes two trials pairwise comparable: the contract, not where the manifest lives. */
function comparisonCohort(value: any): unknown {
	const declaration = measurementDeclaration(value) as Record<string, unknown> | null;
	if (!declaration) return { kind: "legacy_text_classification" };
	const { sampleManifestPath: _path, evidence: _evidence, selection: _selection, ...cohort } = declaration;
	return cohort;
}

function measurementDeclaration(value: any): unknown {
	if (!value) return null;
	const { sampleManifestSha256: _hash, hasTargets: _targets, evidenceManifestSha256: _evidenceHash, evidence: _evidence, ...declaration } = value;
	return declaration;
}

export class TrainingService {
	private started = 0;
	private readonly trials = new Map<string, StartedTrialRecord>();
	private readonly finalizing = new Map<string, Promise<void>>();
	private readonly settings: SearchSettings;
	private starting: Promise<unknown> = Promise.resolve();
    private initialization?: Promise<void>;
    private releases: (() => void)[] = [];
    private closed = false;
    private durableBudgetLimit?: number;
    private recovering = new Map<string, Promise<unknown>>();
    private measurementHash?: string;

	constructor(private readonly options: TrainingServiceOptions) {
		this.options = { ...options, ...(options.measurement ? { measurement: structuredClone(options.measurement) } : {}) };
		if (this.options.measurement && typeof this.options.measurement.sampleManifestPath === "string") {
			this.options.measurement.sampleManifestPath = resolve(options.projectRoot, this.options.measurement.sampleManifestPath);
			if (this.options.measurement.kind === "anomaly_detection" && typeof this.options.measurement.evidence?.path === "string")
				this.options.measurement.evidence.path = resolve(options.projectRoot, this.options.measurement.evidence.path);
		}
		this.settings = { ...DEFAULT_SEARCH, ...options.search };
	}

    private hashFile(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
    private dataHash(): string {
        const path = this.options.measurement?.sampleManifestPath;
        if (!path || !existsSync(path)) return "unavailable";
        return createHash("sha256").update(canonical(measurementDeclaration(this.options.measurement))).update(readFileSync(path)).digest("hex");
    }

    private runtimeDependencyHash(): string {
        const probe = spawnSync(this.options.pythonExecutable, ["-I", "-c",
            "import importlib.metadata,json,platform; print(json.dumps({'python':platform.python_version(),'packages':sorted((d.metadata['Name'],d.version) for d in importlib.metadata.distributions())},sort_keys=True))"],
            { env: this.options.env, encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
        if (probe.error || probe.status !== 0) return "unverified";
        return createHash("sha256").update(probe.stdout.trim()).digest("hex");
    }

    private frameworkHash(): string {
        const hash = createHash("sha256");
        for (const path of [join(PYTHON_ROOT, "worker.py"), join(PYTHON_ROOT, "runner.py"),
            ...readdirSync(join(PYTHON_ROOT, "smartlab_trial")).filter(n => n.endsWith(".py")).sort().map(n => join(PYTHON_ROOT, "smartlab_trial", n))]) hash.update(readFileSync(path));
        hash.update(this.options.executionBoundaryFingerprint ?? "unisolated");
        const lock = join(this.options.projectRoot, "uv.lock");
        if (existsSync(lock)) hash.update(readFileSync(lock));
        return hash.digest("hex");
    }

    /** Discover only roots in this task's explicitly supplied training workspace. */
    ready(): Promise<void> {
        return this.initialization ??= this.discover();
    }
    private async discover(): Promise<void> {
        this.checkMeasurement();
        this.releases.push(claimWorkspace(this.options.trainingRoot));
        const roots = [this.options.trainingRoot, ...(this.options.recoveryRoots ?? [])];
        for (const root of [...new Set(roots)]) {
            if (!existsSync(root)) continue;
            if (root !== this.options.trainingRoot) {
                try { this.releases.push(claimWorkspace(root)); }
                catch (error) { this.options.record?.("training_recovery_skipped", { directory: root, reason: String(error) }); continue; }
            }
            for (const name of readdirSync(root)) {
                if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) continue;
                const directory = join(root, name);
                const path = join(directory, "recovery.json");
                if (!existsSync(path)) continue;
                const meta = readJson(path);
                if (!meta || meta.schemaVersion !== 1 || meta.trial?.id !== name || meta.trial?.directory !== directory || !Array.isArray(meta.trial?.worktrees) || meta.budgetUnit !== name || !Number.isInteger(meta.attempts) || meta.attempts < 0 || !meta.trial?.request || !Number.isFinite(meta.trial?.startedAt)) {
                    this.options.record?.("training_recovery_refused", { experiment_id: name, directory, reason: "Corrupt recovery metadata. Restore recovery.json from a backup; no fit was started." });
                    throw new Error(`Corrupt training recovery metadata: ${path}; restore it from a backup before restarting solve.`);
                }
                this.trials.set(name, meta.trial);
                if (meta.budgetCharged !== false) this.started++;
                if (Number.isInteger(meta.budgetLimit) && meta.budgetLimit > 0) this.durableBudgetLimit = Math.min(this.durableBudgetLimit ?? Infinity, meta.budgetLimit);
                await this.recover(name, false);
                this.options.onTrialStarted?.(meta.trial);
                const state = readJson(join(directory, "supervisor-state.json"));
                if (state?.status !== "running") await this.finalize(name);
            }
        }
    }

    /** Same no-fit metadata/import check before readiness and every trial launch. */
    private checkMeasurement(declaration: MeasurementConfig = this.options.measurement!, requireEvidence = false): (MeasurementConfig & { sampleManifestSha256: string; hasTargets: boolean; evidenceManifestSha256?: string }) | undefined {
        if (!this.options.measurement) throw new Error("Retired decoded-text training: supply a raw development sample manifest through measurement before starting training.");
        const probe = spawnSync(this.options.pythonExecutable, [join(PYTHON_ROOT, "check_measurement.py"),
            "--config", JSON.stringify(requireEvidence ? declaration : Object.fromEntries(Object.entries(declaration).filter(([key]) => key !== "evidence")))],
            { env: this.options.env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
        let metadata: { sha256?: string; hasTargets?: boolean; evidenceManifestSha256?: string | null; error?: { message?: string } } = {};
        try { metadata = JSON.parse(probe.stdout ?? "{}"); } catch { /* Report bounded setup instructions below. */ }
        const valid = !probe.error && probe.status === 0 && typeof metadata.sha256 === "string" && typeof metadata.hasTargets === "boolean";
        this.options.record?.("training_measurement_setup", { ok: valid, kind: this.options.measurement.kind,
            sampleManifestPath: this.options.measurement.sampleManifestPath, sampleManifestSha256: metadata.sha256,
            evidenceManifestSha256: metadata.evidenceManifestSha256 });
        if (!valid) throw new Error(`Measurement setup failed: ${metadata.error?.message ?? "metadata or metric dependencies unavailable"}. Run ./dev setup and repair the development sample manifest before starting an agent.`);
        const identity = metadata.sha256!;
        if (this.measurementHash && this.measurementHash !== identity) {
            throw new Error("Development sample metadata changed after setup; create a new controller invocation with the new dataset identity.");
        }
        this.measurementHash = identity;
        return { ...declaration, sampleManifestSha256: metadata.sha256!, hasTargets: metadata.hasTargets!,
            ...(metadata.evidenceManifestSha256 ? { evidenceManifestSha256: metadata.evidenceManifestSha256 } : {}) };
    }

    private launchArguments(directory: string, worker: string, invocationPath: string): string[] {
        const path = join(directory, "recovery.json");
        const meta = readJson(path)!;
        const token = randomUUID();
        atomicJson(path, { ...meta, token, lifecycle: "active" });
        const invocation = readJson(invocationPath)!;
        const command = [this.options.pythonExecutable, worker, "--invocation", invocationPath];
        const workerCommand = this.options.sandboxCommand?.(command, { directory,
            sourceRoots: [invocation.inputs?.sourceRoot, invocation.champion?.sourceRoot].filter((path): path is string => typeof path === "string") }) ?? command;
        return [this.options.pythonExecutable, join(PYTHON_ROOT, "runner.py"), "--directory", directory,
            "--token", token, "--", ...workerCommand];
    }

    resume(id: string, acceptEstimatedSeconds?: number): Promise<unknown> {
        return this.ready().then(() => this.recover(id, true, acceptEstimatedSeconds));
    }

    private recover(id: string, explicit: boolean, acceptance?: number): Promise<unknown> {
        const pending = this.recovering.get(id);
        if (pending) return pending;
        const work = (async () => { const release = this.options.solutionsRoot ? await selectionClaimAsync(this.options.solutionsRoot) : undefined; try { return await this.recoverTrial(id, explicit, acceptance); } finally { release?.(); } })().finally(() => this.recovering.delete(id));
        this.recovering.set(id, work);
        return work;
    }

    private async recoverTrial(id: string, explicit: boolean, acceptance?: number): Promise<unknown> {
        const trial = this.trials.get(id);
        if (!trial) throw new Error(`Unknown experiment ${id}; use experiment_status to list durable trials.`);
        const path = join(trial.directory, "recovery.json");
        let meta = readJson(path);
        if (!meta) return;
        for (const name of ["supervisor-state.json", "worker-owner.json", "worker-exit.json", "worker-runtime.json", "trial-result.json", "search-report.json"]) {
            if (existsSync(join(trial.directory, name)) && !readJson(join(trial.directory, name))) {
                const reason = `Corrupt ${name}; restore its original ownership/lifecycle record before recovery. No fit started.`;
                atomicJson(path, { ...meta, lifecycle: "refused", diagnosis: reason });
                this.options.record?.("training_recovery_refused", { experiment_id: id, reason });
                if (explicit) throw new Error(reason);
                return;
            }
        }
        const state = readJson(join(trial.directory, "supervisor-state.json"));
        const owner = readJson(join(trial.directory, "worker-owner.json"));
        const identity: ProcessIdentity | undefined = owner && owner.token === meta.token ? owner.identity : state?.identity;
        let processRecord = readJson(join(trial.directory, "experiment.json")) as ExperimentRecord | undefined;
        const result = readJson(join(trial.directory, "trial-result.json"));
        const report = readJson(join(trial.directory, "search-report.json"));
        const event = (type: string, details: Record<string, unknown>) => this.options.record?.(type, {
            experiment_id: id, origin_pipeline_run_id: meta!.originPipelineRunId,
            origin_stage_invocation_id: meta!.originStageInvocationId,
            recovery_pipeline_run_id: this.options.pipelineRunId, recovery_stage_invocation_id: this.options.stageInvocationId, ...details });
        const attach = (running: boolean) => {
            if (processRecord) this.options.supervisor.attach?.(processRecord, {
                identity, status: running ? "running" : state?.stopReason ? "stopped" : "exited",
                stopReason: state?.stopReason, cursor: state?.cursor, lines: state?.lines });
        };
        if (ownedProcessAlive(identity)) {
            // The runner receipt covers a crash between spawn and the supervisor record write.
            processRecord = { ...(processRecord ?? {}), id, directory: trial.directory,
                logPath: join(trial.directory, "output.log"), pid: identity!.pid, pgid: identity!.pgid,
                argv: processRecord?.argv ?? [], cwd: this.options.projectRoot,
                hypothesis: trial.request.hypothesis, scope: scopeSummary(trial.request),
                startedAt: processRecord?.startedAt ?? new Date(trial.startedAt).toISOString() };
            if (meta.lifecycle === "active" && !state?.stopReason) atomicJson(join(trial.directory, "launch-released.json"), { token: meta.token });
            attach(true); event("training_recovery_live", { retained: this.describe(id) }); return explicit ? { id, view: this.options.supervisor.status?.(id), reattached: true, budgetConsumed: false } : undefined; }
        if (identity && liveGroup(identity.pgid).length) {
            attach(true); event("training_recovery_blocked", { reason: "Leader exited but process group still has live members; no duplicate or signal to unverified descendants." }); return;
        }
        attach(false);
        const stop = state?.stopReason;
        const pause = report?.stopReason;
        const workerExit = readJson(join(trial.directory, "worker-exit.json"));
        // A normal error exit is deterministic; only missing receipts / signals
        // are unexpected interruption evidence. Do not retry import/launch errors.
        const deterministicExit = workerExit && workerExit.token === meta.token && workerExit.exitCode > 0;
        const terminal = meta.lifecycle === "failed_start" || deterministicExit || result?.status === "completed" || result?.status === "failed" || pause === "max_seconds";
        const intentional = !!stop || meta.lifecycle !== "active" || ["acknowledgement_required", "runtime_overrun"].includes(pause);
        // All report stop reasons are intentional guard pauses except worker death.
        if (terminal || (!explicit && (intentional || pause))) {
            event("training_recovery_skipped", { reason: stop ?? pause ?? meta.lifecycle, status: result?.status, error: result?.error, exit_code: workerExit?.exitCode });
            if (explicit && terminal) throw new Error(`Experiment ${id} is terminal (${pause ?? result?.status}); it cannot resume.`);
            return;
        }
        if (this.closed) throw new Error("Training service is closed; no automatic or explicit resume can start.");
        if (meta.attempts >= 2) {
            event("training_recovery_refused", { reason: "Recovery retry limit (2) reached; inspect output.log and fix the cause before starting a new experiment." });
            if (explicit) throw new Error("Recovery retry limit (2) reached; inspect output.log.");
            return;
        }
        try {
            if (!["linux", "darwin"].includes(process.platform)) throw new Error("Durable recovery requires Linux /proc or Darwin libproc process birth identities.");
            if (meta.taskId !== this.options.taskId || meta.rootSeed !== this.options.rootSeed
                || meta.datasetSha256 !== this.options.datasetSha256 || meta.dataHash !== this.dataHash()
                || meta.environmentFingerprint !== (this.options.environmentFingerprint ?? null)
                || meta.runtimeDependencyHash === "unverified" || meta.runtimeDependencyHash !== this.runtimeDependencyHash()
                || meta.frameworkHash !== this.frameworkHash() || canonical(meta.settings) !== canonical(this.settings)
                || canonical(measurementDeclaration(meta.trial.measurement)) !== canonical(measurementDeclaration(this.options.measurement))) {
                throw new Error("Recovery inputs are incompatible: restore the original dataset, dependencies, worker code, root seed and runtime settings.");
            }
            const invocationPath = join(trial.directory, "invocation.json");
            if (meta.invocationHash !== this.hashFile(invocationPath) || meta.seedPlanHash !== this.hashFile(join(trial.directory, "seed-plan.json"))) {
                throw new Error("Invocation or seed plan changed/corrupt; restore the original files. No fit started.");
            }
            if (!trial.source || !this.options.solutionsRoot) throw new Error("Unversioned source cannot be safely recovered; start a committed trial.");
            assertDevelopmentCandidate(this.options.solutionsRoot, this.options.taskId, trial.source.commit, trial.request.pipeline);
            const runtime = readJson(join(trial.directory, "worker-runtime.json"));
            const checkpoint = readJson(join(trial.directory, "search-checkpoint.json"));
            const consumedSeconds = Math.max(checkpoint?.elapsedSeconds ?? 0, (meta.consumedSeconds ?? 0)
                + (runtime && runtime.token === meta.token ? runtime.seconds + (workerExit?.token === meta.token ? 0 : 0.25) : 0));
            if (!Number.isFinite(consumedSeconds) || consumedSeconds < 0) throw new Error("Corrupt cumulative runtime accounting; restore worker-runtime.json.");
            if (trial.request.search && consumedSeconds >= meta.settings.maxSeconds) throw new Error("Original search hard cap exhausted; resume cannot extend it.");
            atomicJson(join(trial.directory, "recovery-runtime.json"), { consumedSeconds });
            const invocation = JSON.parse(readFileSync(invocationPath, "utf8"));
            if (canonical(invocation.request) !== canonical(trial.request) || invocation.experimentId !== id
                || invocation.inputs.outputDir !== trial.directory || invocation.source?.commit !== trial.source.commit
                || invocation.source?.tree !== trial.source.tree || invocation.source?.repository !== this.options.solutionsRoot
                || (trial.champion && invocation.champion?.commit !== trial.champion.commit)) {
                throw new Error("Recovery trial metadata differs from the original frozen invocation; restore recovery.json.");
            }
            if (invocation.champion) assertDevelopmentCandidate(this.options.solutionsRoot, this.options.taskId, invocation.champion.commit, invocation.champion.pipeline);
            const prefix = relative(this.options.projectRoot, this.options.solutionsRoot);
            for (const [root, commit, tree] of [[invocation.inputs.sourceRoot, trial.source.commit, trial.source.tree],
                ...(invocation.champion ? [[invocation.champion.sourceRoot, invocation.champion.commit, undefined]] : [])]) {
                const worktree = join(root, prefix);
                if (!trial.worktrees.includes(worktree) || !resolve(worktree).startsWith(`${resolve(trial.directory)}${sep}`)) throw new Error("Unsafe recorded worktree path; restore recovery metadata.");
                const source = resolveCommit(this.options.solutionsRoot, commit);
                if (!source || (tree && source.tree !== tree)) throw new Error(`Frozen commit ${commit} unavailable or tree mismatch; restore solutions repository history.`);
                if (!existsSync(worktree)) { git(this.options.solutionsRoot, ["worktree", "prune"]); addWorktree(this.options.solutionsRoot, worktree, commit); }
                else if (resolveCommit(worktree, "HEAD")?.commit !== commit || uncommittedFiles(worktree).length) throw new Error(`Frozen worktree ${worktree} changed; restore its original clean commit without discarding unrelated work.`);
            }
            // Worker validation also checks manifest/checkpoint/journal before any fit.
            if (explicit && acceptance !== undefined) {
                if (!Number.isFinite(acceptance) || acceptance <= 0 || !trial.request.search) throw new Error("acceptEstimatedSeconds must be a positive finite search acknowledgement.");
                const projection = result?.runtimeGuard?.projectedSeconds ?? report?.runtimeGuard?.projectedSeconds;
                if (typeof projection === "number" && acceptance < projection) throw new Error(`Acknowledge at least ${projection} projected seconds, or reduce cost in a new experiment.`);
                atomicJson(join(trial.directory, "resume-acknowledgement.json"), { acceptEstimatedSeconds: acceptance });
            } else if (explicit && pause && pause !== "stop_requested" && !stop) {
                throw new Error("Runtime guard pause requires acceptEstimatedSeconds covering the reported projection.");
            }
            this.options.supervisor.notify?.(id, JSON.stringify({ diagnosis: "Owned worker/process group is gone; bounded recovery", retained: this.describe(id), attempt: meta.attempts + 1 }));
            event("training_recovery_attempt", { attempt: meta.attempts + 1, explicit, retained: this.describe(id), budget_unit: meta.budgetUnit, budget_consumed: false });
            // Keep paused outputs/history, but do not mistake them for this launch's terminal outcome.
            const history = join(trial.directory, "recovery-history", String(meta.attempts + 1));
            await mkdir(history, { recursive: true });
            for (const name of ["trial-result.json", "metrics.json", "search-report.json", "supervisor-state.json", "worker-exit.json"]) {
                const artifact = join(trial.directory, name);
                if (existsSync(artifact)) await rename(artifact, join(history, name));
            }
            meta = { ...meta, consumedSeconds, attempts: meta.attempts + 1, lifecycle: "active" };
            atomicJson(path, meta);
            this.finalizing.delete(id);
            this.options.onTrialStarted?.(trial);
            const view = this.options.supervisor.start({
                argv: this.launchArguments(trial.directory, this.options.workerPath ?? join(PYTHON_ROOT, "worker.py"), invocationPath),
                cwd: this.options.projectRoot, hypothesis: trial.request.hypothesis, scope: scopeSummary(trial.request),
            }, undefined, id, trial.directory);
            atomicJson(join(trial.directory, "launch-released.json"), { token: readJson(path)!.token });
            event("training_recovery_started", { attempt: meta.attempts, budget_unit: meta.budgetUnit, budget_consumed: false });
            return { id, view, retained: this.describe(id), budgetConsumed: false };
        } catch (error) {
            atomicJson(path, { ...readJson(path), lifecycle: "refused", diagnosis: String(error) });
            event("training_recovery_refused", { reason: String(error) });
            this.options.supervisor.notify?.(id, JSON.stringify({ recoveryRefused: String(error), retained: this.describe(id) }));
            if (explicit) throw error;
            return;
        }
    }

	private moduleRoots(): string[] {
		if (this.options.solutionsRoot) return [relative(this.options.projectRoot, this.options.solutionsRoot) || "."];
		return [...(this.options.allowedModuleRoots ?? ["solutions"])];
	}

	/** Every module must live under an allowed root and exist in the code the trial will run. */
	private moduleIssues(request: ExperimentRequest, source: SourceIdentity | undefined): ValidationIssue[] {
		const issues: ValidationIssue[] = [];
		const roots = this.moduleRoots();
		const modules: [string, string][] = [["pipeline.module", request.pipeline.module]];
		if (request.cv.kind === "factory") modules.push(["cv.module", request.cv.module]);
		for (const [path, module] of modules) {
			const absolute = resolve(this.options.projectRoot, module);
			const root = roots.find((entry) => {
				const boundary = resolve(this.options.projectRoot, entry);
				return absolute.startsWith(`${boundary}${sep}`);
			});
			if (root === undefined) {
				issues.push({ path, problem: `must be under ${roots.map((entry) => `${entry.replace(/\/$/, "")}/`).join(" or ")}`,
					received: module, expected: `a path such as ${roots[0]}/tasks/${this.options.taskId}.py`,
					hint: `Move the code under ${roots[0]}/ and commit it there.` });
				continue;
			}
			if (source && this.options.solutionsRoot) {
				const inside = relative(this.options.solutionsRoot, absolute).split(sep).join("/");
				if (git(this.options.solutionsRoot, ["cat-file", "-e", `${source.commit}:${inside}`]).status !== 0) {
					issues.push({ path, problem: `does not exist in commit ${source.commit.slice(0, 12)}`, received: module,
						expected: "a file committed at the requested commit",
						hint: `Commit it (git -C ${roots[0]} add ${inside} && git -C ${roots[0]} commit -m "<idea>"), or check the path and commit.` });
				}
			} else if (!existsSync(absolute)) {
				issues.push({ path, problem: "does not exist", received: relative(this.options.projectRoot, absolute),
					expected: "an existing project-relative .py file", hint: "Create the module first, or check the path." });
			}
		}
		return issues;
	}

	/** Clean tree and an existing commit. A rerun of committed code needs no new commit. */
	private sourceIssues(request: ExperimentRequest): { source?: SourceIdentity; issues: ValidationIssue[] } {
		const root = this.options.solutionsRoot!;
		const name = relative(this.options.projectRoot, root) || root;
		if (!isRepositoryRoot(root)) {
			return { issues: [{ path: "commit", problem: `${name}/ is not a git repository`, received: name,
				expected: "an initialized solutions repository", hint: "Solve setup creates it; restart the solve stage." }] };
		}
		const issues: ValidationIssue[] = [];
		const dirty = uncommittedFiles(root);
		if (dirty.length > 0) {
			issues.push({ path: "commit", problem: `${name}/ has uncommitted changes`, received: dirty.slice(0, 50),
				expected: "a clean working tree: no staged, unstaged, or untracked non-ignored files",
				hint: `Commit them first, e.g. git -C ${name} add -A && git -C ${name} commit -m "<what this change tries>". `
					+ `Rerunning committed code with different parameters needs no new commit.` });
		}
		const requested = request.commit ?? "HEAD";
		const source = resolveCommit(root, requested);
		if (!source) {
			issues.push({ path: "commit", problem: "no such commit", received: requested,
				expected: `a revision that exists in ${name}/`,
				hint: `Use HEAD, a branch from git -C ${name} branch, or a hash from git -C ${name} log --oneline.` });
		}
		return { source, issues };
	}

	/** The most recent measurement of fit time for the same commit and pipeline. */
	private priorMeasurement(request: ExperimentRequest, source: SourceIdentity | undefined) {
		const candidates = [...this.trials.values()]
			.filter((trial) => trial.request.scope.kind === "pilot" && !trial.request.search
				&& trial.source?.commit === source?.commit
				&& trial.request.pipeline.module === request.pipeline.module
				&& trial.request.pipeline.factory === request.pipeline.factory)
			.sort((left, right) => right.startedAt - left.startedAt);
		for (const trial of candidates) {
			// A search's fold results are its best configuration's folds.
			const rows = readJsonLines(join(trial.directory, "fold-results.jsonl"));
			const measured = rows.filter((row) => typeof row.durationSeconds === "number" && typeof row.trainRows === "number");
			if (measured.length === 0) continue;
			return {
				priorFitSeconds: Math.max(1e-3, mean(measured.map((row) => row.fitSeconds ?? row.durationSeconds))),
				priorTrainRows: Math.max(1, Math.round(mean(measured.map((row) => row.fitRows ?? row.trainRows)))),
				priorSource: trial.id,
			};
		}
		return {};
	}

	/** The current champion, read from its annotated tag so it survives across runs. */
	private champion(): { experimentId: string; commit: string; pipeline: JsonValue } | undefined {
		if (!this.options.solutionsRoot || !isRepositoryRoot(this.options.solutionsRoot)) return undefined;
		const tag = tagMessage(this.options.solutionsRoot, championTag(this.options.taskId));
		if (!tag) return undefined;
		const message = JSON.parse(tag.message) as { experimentId?: unknown; pipeline?: JsonValue; measurement?: unknown };
		if (typeof message.experimentId !== "string" || message.pipeline === undefined) throw new Error("Malformed champion tag");
		if (canonical(comparisonCohort(message.measurement)) !== canonical(comparisonCohort(this.options.measurement))) {
			// A changed task contract (kind, execution, score semantics or input frame)
			// cannot be compared pairwise. The old champion stays reachable through its
			// trial tag; the first promotion of the new cohort takes the task's tag.
			this.options.record?.("training_champion_cohort_changed", { experiment_id: message.experimentId, commit: tag.commit,
				previous: comparisonCohort(message.measurement), current: comparisonCohort(this.options.measurement) });
			return undefined;
		}
		if (isTerminalCandidate(this.options.solutionsRoot, this.options.taskId, tag.commit, message.pipeline as unknown as import("./types.js").PipelineRequest)) {
			this.options.record?.("training_terminal_champion_retained_as_history", { experiment_id: message.experimentId, commit: tag.commit, comparison_available: false });
			return undefined;
		}
		return { experimentId: message.experimentId, commit: tag.commit, pipeline: message.pipeline };
	}

	/** Persist identity and inputs before spawning the harness-owned worker. */
	start(raw: unknown, requestedByToolCallId?: string): Promise<StartedTrainingExperiment> {
		const work = this.starting.then(async () => { await this.ready(); if (this.closed) throw new Error("training service is closed"); const release = this.options.solutionsRoot ? await selectionClaimAsync(this.options.solutionsRoot) : undefined; try { return await this.startValidated(raw, requestedByToolCallId); } finally { release?.(); } });
		this.starting = work.catch(() => undefined);
		return work;
	}

	private async startValidated(raw: unknown, requestedByToolCallId?: string): Promise<StartedTrainingExperiment> {
		const structural = validateExperimentRequest(raw);
		if (!structural.request) {
			this.options.record?.("training_request_rejected", { layer: "structure", issues: structural.issues, tool_call_id: requestedByToolCallId });
			throw new ExperimentRequestError(structural.issues);
		}
		const request = structural.request;
		let measurement = this.checkMeasurement();
        if (measurement?.kind === "anomaly_detection" && measurement.selection && !measurement.evidence)
            throw new Error("Explicit evidence selection requires an evidence path and source before trial acceptance");
		if (measurement && !measurement.hasTargets && !(measurement.kind === "anomaly_detection" && measurement.selection) && request.search && !request.search.objective) {
			throw new ExperimentRequestError([{ path: "search", problem: "no trusted primary metric for label-free search",
				received: "search", expected: "an explicitly declared proxy objective", hint: "Declare search.objective metric and direction, or compare fixed trials. Label-free proxies cannot authorize promotion." }]);
		}
		const budgetLimit = Math.min(this.options.maxExperiments ?? Infinity, this.durableBudgetLimit ?? Infinity);
        if (this.started >= budgetLimit) {
            throw new Error(`training experiment budget exhausted (${budgetLimit})`);
		}
		const versioned = this.options.solutionsRoot !== undefined;
		let source: SourceIdentity | undefined;
		const issues: ValidationIssue[] = [];
		if (versioned) {
			const checked = this.sourceIssues(request);
			source = checked.source;
			issues.push(...checked.issues);
		}
		if (!versioned || source) issues.push(...this.moduleIssues(request, source));
		if (issues.length > 0) {
			this.options.record?.("training_request_rejected", { layer: "source", issues, tool_call_id: requestedByToolCallId });
			throw new ExperimentRequestError(issues);
		}

		if (source && this.options.solutionsRoot) assertDevelopmentCandidate(this.options.solutionsRoot, this.options.taskId, source.commit, request.pipeline);
		const id = randomUUID();
		const directory = join(this.options.trainingRoot, id);
		await mkdir(directory, { recursive: true });
		const worktrees: string[] = [];
		const prefix = versioned ? relative(this.options.projectRoot, this.options.solutionsRoot!) : undefined;
		const sourceRoot = versioned ? join(directory, "source") : undefined;
		let champion: ReturnType<TrainingService["champion"]>;
		try {
			if (measurement?.kind === "anomaly_detection" && measurement.evidence) {
				const evidencePath = join(directory, "evidence.json");
                const file = openSync(measurement.evidence.path, "r");
                let bytes: Buffer;
                try {
                    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
                    let length = 0;
                    while (length < buffer.length) {
                        const count = readSync(file, buffer, length, buffer.length - length, null);
                        if (!count) break;
                        length += count;
                    }
                    if (length > 8 * 1024 * 1024) throw new Error("Evidence metadata exceeds 8 MiB");
                    bytes = buffer.subarray(0, length);
                } finally { closeSync(file); }
				await writeFile(evidencePath, bytes, { flag: "wx" });
				measurement = this.checkMeasurement({ ...measurement, evidence: { ...measurement.evidence, path: evidencePath } }, true);
				this.options.record?.("training_evidence_snapshotted", { experiment_id: id, path: evidencePath, sha256: measurement?.evidenceManifestSha256, source: measurement?.kind === "anomaly_detection" ? measurement.evidence?.source : undefined, selection: measurement?.kind === "anomaly_detection" ? measurement.selection : undefined });
			}
			if (versioned) {
				const worktree = join(sourceRoot!, prefix!);
				addWorktree(this.options.solutionsRoot!, worktree, source!.commit);
				worktrees.push(worktree);
			}
			const layer2 = await (this.options.validatePipeline ?? runPipelineValidation)({
				pythonExecutable: this.options.pythonExecutable,
                command: this.options.sandboxCommand?.([this.options.pythonExecutable, join(PYTHON_ROOT, "validate.py")], { directory, sourceRoots: [sourceRoot ?? this.options.projectRoot] }),
				scriptPath: join(PYTHON_ROOT, "validate.py"),
				sourceRoot: sourceRoot ?? this.options.projectRoot,
				request,
				measurement,
				env: this.options.env,
				cwd: this.options.projectRoot,
				timeoutMs: this.settings.validationTimeoutSeconds * 1_000,
			});
			if (layer2.length > 0) throw new ExperimentRequestError(layer2);
            if (this.closed) throw new Error("Training service closed during validation; no worker started.");
			champion = versioned && (request.scope.kind === "promotion" || request.search) ? this.champion() : undefined;
			if (champion) {
                assertDevelopmentCandidate(this.options.solutionsRoot!, this.options.taskId, champion.commit, champion.pipeline as unknown as import("./types.js").PipelineRequest);
				const worktree = join(directory, "champion", "source", prefix!);
				addWorktree(this.options.solutionsRoot!, worktree, champion.commit);
				worktrees.push(worktree);
			}
		} catch (error) {
			// Rejected requests leave nothing behind and consume no budget.
			for (const worktree of worktrees) removeWorktree(this.options.solutionsRoot!, worktree);
			await rm(directory, { recursive: true, force: true });
			if (error instanceof ExperimentRequestError) {
				this.options.record?.("training_request_rejected", { stage: "pipeline", issues: error.issues });
			}
			throw error;
		}

		const searchCoordinate = request.search ? `search-v1:${createHash("sha256").update(canonical({
			commit: source?.commit ?? null, pipeline: request.pipeline, cv: request.cv, scope: request.scope,
			search: { space: request.search.space, sampler: request.search.sampler ?? "tpe",
				maxConfigs: request.search.maxConfigs ?? null, pruning: request.search.pruning ?? false },
		})).digest("hex")}` : undefined;
		const seedPlan = createSeedPlan({
			rootSeed: this.options.rootSeed,
			taskId: this.options.taskId,
			datasetSha256: this.options.datasetSha256,
			experimentId: id,
			experimentCoordinate: searchCoordinate,
		});
		const requestPath = join(directory, "request.json");
		const seedPlanPath = join(directory, "seed-plan.json");
		const invocationPath = join(directory, "invocation.json");
		const sourceRecord = source ? {
			commit: source.commit, tree: source.tree, subject: source.subject, requested: source.requested,
			...(source.branch ? { branch: source.branch } : {}),
			repository: this.options.solutionsRoot,
		} : undefined;
		await writeJsonAtomic(requestPath, request);
		await writeSeedPlan(seedPlanPath, seedPlan);
		await writeJsonAtomic(invocationPath, {
			schemaVersion: versioned || request.schemaVersion === 2 ? 2 : 1,
			experimentId: id,
			request,
			...(measurement ? { measurement } : {}),
			...(searchCoordinate ? { searchCoordinate } : {}),
			inputs: {
				projectRoot: this.options.projectRoot,
				zipPath: this.options.zipPath,
				labelsPath: this.options.labelsPath,
				outputDir: directory,
				...(sourceRoot ? { sourceRoot } : {}),
			},
			seeds: {
				experiment: seedPlan.experimentSeed,
				// Search configurations and the champion rerun derive their
				// estimator seeds from this same trial coordinate.
				trial: deriveTrialSeed(seedPlan, 0),
			},
			...(sourceRecord ? { source: sourceRecord } : {}),
			...(request.search ? {
				runtime: {
					confirmAboveSeconds: this.settings.confirmAboveSeconds,
					overrunFactor: this.settings.overrunFactor,
					maxSeconds: this.settings.maxSeconds,
					...(this.options.runtimeGuidance ? { guidance: this.options.runtimeGuidance } : {}),
					...this.priorMeasurement(request, source),
				},
				caveats: [...(this.options.caveats ?? [])],
			} : {}),
			...(champion ? {
				champion: {
					experimentId: champion.experimentId,
					commit: champion.commit,
					pipeline: champion.pipeline,
					sourceRoot: join(directory, "champion", "source"),
				},
			} : {}),
		});

		const worker = this.options.workerPath ?? join(this.options.projectRoot, "agent", "training", "python", "worker.py");
        const record: StartedTrialRecord = {
            id, directory, request, worktrees, startedAt: Date.now(),
            ...(measurement ? { measurement } : {}),
            ...(source ? { source } : {}),
            ...(champion ? { champion: { experimentId: champion.experimentId, commit: champion.commit } } : {}),
        };
        atomicJson(join(directory, "recovery.json"), {
            schemaVersion: 1, trial: record, budgetCharged: true, budgetUnit: id, budgetLimit: this.options.maxExperiments,
            taskId: this.options.taskId, rootSeed: this.options.rootSeed,
            datasetSha256: this.options.datasetSha256, dataHash: this.dataHash(),
            environmentFingerprint: this.options.environmentFingerprint ?? null,
            runtimeDependencyHash: this.runtimeDependencyHash(),
            frameworkHash: this.frameworkHash(), invocationHash: this.hashFile(invocationPath),
            seedPlanHash: this.hashFile(seedPlanPath), settings: this.settings,
            originPipelineRunId: this.options.pipelineRunId, originStageInvocationId: this.options.stageInvocationId,
            attempts: 0, lifecycle: "active",
        });
        let view: StartedTrainingExperiment["view"];
		try {
			if (this.closed) throw new Error("Training service closed before launch; no worker started.");
			view = this.options.supervisor.start({
				argv: this.launchArguments(directory, worker, invocationPath),
				cwd: this.options.projectRoot,
				hypothesis: request.hypothesis,
				scope: scopeSummary(request),
			}, requestedByToolCallId, id);
		} catch (error) {
            atomicJson(join(directory, "recovery.json"), { ...readJson(join(directory, "recovery.json")), lifecycle: "failed_start", budgetCharged: false, diagnosis: String(error) });
			for (const worktree of worktrees) removeWorktree(this.options.solutionsRoot!, worktree);
			throw error;
		}
        atomicJson(join(directory, "launch-released.json"), { token: readJson(join(directory, "recovery.json"))!.token });
		this.started++;
		this.trials.set(id, record);
		this.options.onTrialStarted?.(record);
		return { id, directory, request, ...(source ? { source } : {}), view };
	}

	/**
	 * After the worker exits: remove its worktrees, tag a completed promotion,
	 * and move `champion` to it when its paired lead over the current champion exceeds noise (or to the best open trial when there is none). Idempotent per trial.
	 */
	async workerFinished(id: string): Promise<void> {
        if (!this.closed) {
            const recovered = await this.recover(id, false);
            if (recovered) return;
        }
        await this.finalize(id);
    }

    finalize(id: string): Promise<void> {
		const existing = this.finalizing.get(id);
		if (existing) return existing;
		const trial = this.trials.get(id);
		if (!trial) return Promise.resolve();
		const work = (async () => {
			const root = this.options.solutionsRoot;
            const release = root ? await selectionClaimAsync(root) : undefined;
            try {
            if (root && trial.source) assertDevelopmentCandidate(root, this.options.taskId, trial.source.commit, trial.request.pipeline);
            const state = readJson(join(trial.directory, "supervisor-state.json"));
            if (state?.status === "running" || (state?.identity && liveGroup(state.identity.pgid).length)) return;
			const result = readJson(join(trial.directory, "trial-result.json"));
            if (result) this.options.record?.("training_trial_result", {
                experiment_id: id, status: result.status, metrics: result.metrics,
                completed_folds: result.completedFolds, requested_folds: result.requestedFolds,
                promotion_eligible: result.promotionEligible, selection: result.selection,
                dataset_sha256: this.options.datasetSha256,
                sample_manifest_sha256: trial.measurement?.sampleManifestSha256,
                fold_manifest_sha256: readJson(join(trial.directory, "fold-manifest.json"))?.sha256,
                commit: trial.source?.commit, artifact: join(trial.directory, "trial-result.json"),
            });
            if (!root) return;
			this.cleanupWorktrees(trial);
			if (result?.idLeakage && !existsSync(join(trial.directory, "id-leakage-notified.json"))) {
                atomicJson(join(trial.directory, "id-leakage-notified.json"), { experimentId: id });
                this.options.record?.("training_id_leakage", { experiment_id: id, ...result.idLeakage });
                if (this.options.idLeakageGuidance) this.options.supervisor.notify?.(id, this.options.idLeakageGuidance);
            }
			if (!trial.source || result?.status !== "completed" || result.promotionEligible !== true || trial.request.search) return;
			const collection = await collectTrainingResults(this.options.trainingRoot);
			const own = collection.trials.find((entry) => entry.experimentId === id);
			if (!own?.eligible) return;
			if (!tagMessage(root, `trial/${id}`)) tagCommit(root, `trial/${id}`, trial.source.commit,
				JSON.stringify({ experimentId: id, metrics: own.result?.metrics, balancedAccuracy: own.result?.metrics?.balancedAccuracy, subject: trial.source.subject }));
			this.options.record?.("training_trial_tagged", { experiment_id: id, tag: `trial/${id}`, commit: trial.source.commit });
			// With a champion in place, only the finishing trial is a challenger:
			// its paired comparison ran against that champion, and a higher raw
			// mean from an unpromoted trial must not block it (D7). Without one,
			// the best open trial starts the line. Frozen identities remain
			// historical evidence and cannot win a new development selection or
			// be used in a paired rerun after full refit.
			const current = this.champion();
			const selected = current ? own : collection.trials.filter(entry => entry.eligible && (entry.invocation?.source as { commit?: string } | undefined)?.commit
                && canonical((entry.invocation?.measurement as any)?.selection ?? null) === canonical((own.invocation?.measurement as any)?.selection ?? null)
                && (!(own.invocation?.measurement as any)?.selection || (entry.invocation?.measurement as any)?.evidenceManifestSha256 === (own.invocation?.measurement as any)?.evidenceManifestSha256)
				&& entry.request && !isTerminalCandidate(root, this.options.taskId, (entry.invocation!.source as { commit: string }).commit, entry.request.pipeline))
				.sort((a, b) => primaryScore(b.result) - primaryScore(a.result))[0];
			const selectedTrial = selected ? this.trials.get(selected.experimentId) : undefined;
			if (!selected || !selectedTrial?.source) return;
            assertDevelopmentCandidate(root, this.options.taskId, selectedTrial.source.commit, selectedTrial.request.pipeline);
			if (current?.experimentId === selected.experimentId) return;
			if (current) {
				const decision = pairedPromotion(selected.result?.championComparison as Record<string, unknown> | undefined, current.commit);
				if (!decision.promote) {
					this.options.record?.("training_champion_retained", { experiment_id: selected.experimentId,
						champion_experiment_id: current.experimentId, reason: decision.reason });
					return;
				}
			}
			tagCommit(root, championTag(this.options.taskId), selectedTrial.source.commit, JSON.stringify({
				experimentId: selected.experimentId,
				balancedAccuracy: selected.result?.metrics?.balancedAccuracy,
				adjustedRandIndex: selected.result?.metrics?.adjustedRandIndex,
				measurement: selectedTrial.measurement ?? null,
				selection: selected.result?.selection ?? null,
				pipeline: selectedTrial.request.pipeline,
				cv: selectedTrial.request.cv,
				subject: selectedTrial.source.subject,
				trainingRoot: this.options.trainingRoot,
			}), true);
			this.options.record?.("training_champion_tagged", {
				experiment_id: selected.experimentId, commit: selectedTrial.source.commit, previous_experiment_id: current?.experimentId,
			});
            } finally { release?.(); }
		})().catch((error) => {
			this.options.record?.("training_finalize_failed", { experiment_id: id, message: error instanceof Error ? error.message : String(error) });
		});
		this.finalizing.set(id, work);
		return work;
	}

	/** Finish pending finalization and remove any worktree a lost process left behind. */
	async close(): Promise<void> {
        this.closed = true;
        for (const trial of this.trials.values()) {
            const path = join(trial.directory, "recovery.json");
            const meta = readJson(path);
            if (meta?.lifecycle === "active") atomicJson(path, { ...meta, lifecycle: "service_closed" });
        }
        await this.initialization?.catch(() => undefined);
        await Promise.allSettled([...this.recovering.values()]);
		await Promise.all([...this.trials.keys()].map((id) => this.finalize(id)));
		if (!this.options.solutionsRoot) { this.releaseClaims(); return; }
		for (const trial of this.trials.values()) {
			const state = readJson(join(trial.directory, "supervisor-state.json"));
            if (state?.identity && liveGroup(state.identity.pgid).length) {
                this.options.record?.("training_cleanup_blocked", { experiment_id: trial.id, reason: "Live process group; source worktrees retained." });
                continue;
            }
            this.cleanupWorktrees(trial);
        }
        this.releaseClaims();
	}

    markClosing(): void { this.closed = true; }

    private cleanupWorktrees(trial: StartedTrialRecord): void {
        const root = this.options.solutionsRoot;
        if (!root) return;
        for (const path of trial.worktrees) {
            if (!existsSync(path)) continue;
            const expected = path.includes(`${sep}champion${sep}`) ? trial.champion?.commit : trial.source?.commit;
            if (!resolve(path).startsWith(`${resolve(trial.directory)}${sep}`) || !expected
                || resolveCommit(path, "HEAD")?.commit !== expected || uncommittedFiles(path).length) {
                this.options.record?.("training_cleanup_blocked", { experiment_id: trial.id, directory: path, reason: "Worktree changed or ownership unverifiable; contents retained." });
                continue;
            }
            removeWorktree(root, path);
        }
    }

    private releaseClaims(): void { for (const release of this.releases.splice(0)) release(); }

	trial(id: string): StartedTrialRecord | undefined {
		return this.trials.get(id);
	}

	/** Durable evidence for one trial, compact enough for a tool result. */
	describe(id: string): Record<string, unknown> | undefined {
		const trial = this.trials.get(id);
		if (!trial) return undefined;
		const result = readJson(join(trial.directory, "trial-result.json"));
		const source = trial.source ? {
			commit: trial.source.commit, tree: trial.source.tree, subject: trial.source.subject,
			...(trial.source.branch ? { branch: trial.source.branch } : {}),
		} : undefined;
		const recovery = readJson(join(trial.directory, "recovery.json"));
        const searchProgress = readJson(join(trial.directory, "search-checkpoint.json"));
        const singleProgress = readJson(join(trial.directory, "single-checkpoint.json"));
        const summary: Record<string, unknown> = {
            recovery: recovery ? { attempts: recovery.attempts, lifecycle: recovery.lifecycle, diagnosis: recovery.diagnosis,
                budgetUnit: recovery.budgetUnit, consumedSeconds: recovery.consumedSeconds,
                originPipelineRunId: recovery.originPipelineRunId, originStageInvocationId: recovery.originStageInvocationId } : undefined,
            retainedProgress: { configurations: Array.isArray(searchProgress?.results) ? searchProgress.results.length : undefined,
                completedConfigurations: Array.isArray(searchProgress?.results) ? searchProgress.results.filter((r: any) => r.status === "completed").length : undefined,
                completedFolds: Array.isArray(singleProgress?.completed) ? singleProgress.completed.length : undefined },
			experimentId: id,
			directory: trial.directory,
			...(source ? { source } : {}),
			hypothesis: trial.request.hypothesis,
			kind: trial.request.search ? "search" : "single",
		};
		if (!result) return { ...summary, status: "running_or_missing_result" };
		Object.assign(summary, {
			status: result.status, scope: result.scope, promotionEligible: result.promotionEligible,
			completedFolds: result.completedFolds, requestedFolds: result.requestedFolds,
			balancedAccuracy: result.metrics?.balancedAccuracy,
			adjustedRandIndex: result.metrics?.adjustedRandIndex,
            selection: selectionSummary(result),
			diagnostics: compactDiagnostics(result),
			promotionIneligibleReason: result.promotionIneligibleReason,
			...(result.error ? { error: result.error } : {}),
			...(result.search ? { search: result.search } : {}),
			...(result.runtimeGuard ? { runtimeGuard: result.runtimeGuard } : {}),
			...(result.championComparison ? { championComparison: result.championComparison } : {}),
		});
		const report = readJson(join(trial.directory, "search-report.json"));
		if (report) {
			summary.searchReport = {
				path: join(trial.directory, "search-report.json"),
				leaderboard: Array.isArray(report.leaderboard) ? report.leaderboard.slice(0, 5) : undefined,
				parameterImportance: report.parameterImportance,
				parameterEffects: report.parameterEffects?.summary,
				bestVersusRunnerUp: report.comparison?.bestVersusRunnerUp,
				bestVersusChampion: report.comparison?.bestVersusChampion,
				progress: report.progress?.summary,
				cost: report.cost,
				caveats: report.caveats,
				nextStep: report.nextStep,
			};
		}
		return summary;
	}

	/** One row per trial with its code identity: the leaderboard the agent reads. */
	leaderboard(): Record<string, unknown>[] {
		return [...this.trials.values()].map((trial) => {
			const result = readJson(join(trial.directory, "trial-result.json"));
			return {
				experimentId: trial.id,
				kind: trial.request.search ? "search" : "single",
				scope: trial.request.scope.kind,
				status: result?.status ?? "running",
				balancedAccuracy: result?.metrics?.balancedAccuracy,
				adjustedRandIndex: result?.metrics?.adjustedRandIndex,
                selection: selectionSummary(result),
				diagnostics: compactDiagnostics(result),
				promotionEligible: result?.promotionEligible ?? false,
				...(trial.source ? {
					commit: trial.source.commit.slice(0, 12), subject: trial.source.subject,
					...(trial.source.branch ? { branch: trial.source.branch } : {}),
				} : {}),
				hypothesis: trial.request.hypothesis,
			};
		});
	}
}
