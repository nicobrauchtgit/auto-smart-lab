import { runPipeline, type RunPipelineOptions } from './executor.js';
/** Standalone lead uses the same whole-chain preflight, reporter and executor. */
export function runLeadStage(options: Omit<RunPipelineOptions, 'entryStage' | 'stopAfter'>) {
 return runPipeline({ ...options, entryStage: 'lead', stopAfter: 'lead', invokedBy: { kind: 'api', command: 'lead-stage' } });
}
