// Groups the flat run list into pipeline -> session -> subagent-session trees,
// mirroring how a pipeline row owns child agent sessions which can themselves
// spawn subagent sessions (linked via parent_agent_run_id).
export function buildTree(runs) {
	const byId = new Map(runs.map(run => [run.agent_run_id, { ...run, children: [] }]));
	const pipelines = [];
	const roots = [];
	for (const run of byId.values()) {
		if (run.kind === "pipeline") pipelines.push(run);
	}
	const pipelineIds = new Set(pipelines.map(run => run.agent_run_id));
	for (const run of byId.values()) {
		if (run.kind === "pipeline") continue;
		const parent = run.parent_agent_run_id && byId.get(run.parent_agent_run_id);
		const pipeline = run.pipeline_run_id && byId.get(run.pipeline_run_id);
		if (parent && parent.agent_run_id !== run.agent_run_id) parent.children.push(run);
		else if (pipeline && pipelineIds.has(pipeline.agent_run_id)) pipeline.children.push(run);
		else roots.push(run);
	}
	const sortByStarted = list => list.sort((left, right) => new Date(right.started_at) - new Date(left.started_at));
	for (const run of byId.values()) sortByStarted(run.children);
	return sortByStarted([...pipelines, ...roots]);
}

export function countDescendants(node) {
	return node.children.reduce((total, child) => total + 1 + countDescendants(child), 0);
}

export function findNode(tree, id) {
	for (const node of tree) {
		if (node.agent_run_id === id) return node;
		const found = findNode(node.children, id);
		if (found) return found;
	}
	return null;
}
