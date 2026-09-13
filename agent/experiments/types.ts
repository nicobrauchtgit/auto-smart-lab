/**
 * A supervised trial fit.
 *
 * The agent holds an ID; the supervisor holds the process. That split exists
 * because a fit started inside a tool call lives and dies inside that call, and
 * the agent reaches no model-call boundary until the call returns. Nothing
 * streamed into a blocking tool call can wake it.
 */

export type ExperimentStatus = "running" | "exited" | "stopped" | "failed";

/** What the caller asks for. Persisted before the process is spawned. */
export interface ExperimentSpec {
	/** Executable and arguments. The Devbox Python, not a shell string. */
	argv: string[];
	/** Working directory the process is spawned in. */
	cwd: string;
	/** What this trial is testing. Recorded, never interpreted. */
	hypothesis: string;
	/**
	 * The deliberately reduced work this trial does: a subset, one fold, a few
	 * epochs. Recorded so a pilot result is never mistaken for full validation.
	 */
	scope: string;
	/**
	 * Longest silence a healthy fit of this shape is expected to show, measured
	 * by an earlier pilot. Silence scales with data volume -- 6.2 s on one
	 * corpus against 35.7 s on 5.5x the text -- so no constant serves both. When
	 * absent the supervisor calibrates from the gaps this run actually shows.
	 */
	expectedGapMs?: number;
}

/** Everything recorded before the spawn, so a stray process is attributable later. */
export interface ExperimentRecord extends ExperimentSpec {
	id: string;
	pid: number;
	pgid: number;
	startedAt: string;
	directory: string;
	logPath: string;
	/** Dependency identity from `readPythonEnvironment()`; not a second inventory. */
	environmentFingerprint?: string;
	pipelineRunId?: string;
	stageInvocationId?: string;
	requestedByToolCallId?: string;
}

/** One libproc reading over every live process in the group. */
export interface ResourceSample {
	at: number;
	processes: number;
	cpuSeconds: number;
	rssBytes: number;
	/** Absent on the first sample: a rate needs two readings. */
	cpuPercent?: number;
}

export interface ExperimentView {
	id: string;
	status: ExperimentStatus;
	scope: string;
	hypothesis: string;
	elapsedSeconds: number;
	linesEmitted: number;
	/** Byte offset the next `output` call resumes from. */
	cursor: number;
	exitCode?: number;
	stopReason?: string;
	lastLine?: string;
	secondsSinceOutput?: number;
	cpuPercent?: number;
	rssMb?: number;
	processes?: number;
	/** Set once the run has been quiet past its derived threshold at idle CPU. */
	stalled?: boolean;
	logPath: string;
}

/** Why the supervisor woke the agent. Routine progress is coalesced; the rest jumps the queue. */
export type UpdateKind = "progress" | "stalled" | "exited" | "diagnostic" | "memory";

export interface Update {
	kind: UpdateKind;
	id: string;
	at: number;
	/** The last few lines, not the whole tail: the log keeps the full sequence. */
	lines: string[];
	view: ExperimentView;
	note?: string;
}

export interface SupervisorLimits {
	/** At most one routine wake per interval. 152 lines in 2.9 s is 52 a second. */
	updateIntervalMs: number;
	/** Lines carried on one update. The log holds the rest. */
	linesPerUpdate: number;
	/** Silence below this never counts, whatever the derived threshold says. */
	minStallMs: number;
	/** Multiple of the observed or supplied gap before silence counts as a stall. */
	stallGapMultiple: number;
	/** Every run's first seconds are scikit-learn importing. Silent by nature. */
	importPreludeMs: number;
	/** Below this, the group is doing nothing. A pegged fit sits at 56-105%. */
	idleCpuPercent: number;
	/** Sampling is free and never spends a turn; waking is a billed model call. */
	sampleIntervalMs: number;
	maxConcurrent: number;
	/** Grace between the group's SIGTERM and its SIGKILL. */
	stopGraceMs: number;
}

export const DEFAULT_LIMITS: Readonly<SupervisorLimits> = Object.freeze({
	updateIntervalMs: 5_000,
	linesPerUpdate: 5,
	minStallMs: 15_000,
	stallGapMultiple: 4,
	// Measured at 1.6-1.9 s warm; a cold first run of the day took 8.6 s.
	importPreludeMs: 12_000,
	idleCpuPercent: 5,
	sampleIntervalMs: 250,
	maxConcurrent: 2,
	stopGraceMs: 2_000,
});

/**
 * Output that should reach the agent ahead of routine progress.
 *
 * Matched against the process's own output, and used only to decide *when* to
 * wake. The line itself is data the agent reads, never an instruction the
 * supervisor acts on.
 */
export const DIAGNOSTIC_PATTERN = /Traceback \(most recent call last\)|Warning:|MemoryError|\b(nan|inf|-inf)\b|\b\w*Error\b|error:/;
