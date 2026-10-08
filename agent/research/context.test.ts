import { expect, test } from "bun:test";
import { spamConfiguration } from "../pipeline/task_configuration.testing.js";
import { identifyResearchInputs, buildResearchContext } from "./context.js";
import { listTasks } from "../pipeline/resolve_task.js";
import { researchStage } from "../pipeline/stages/research.js";
import { setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const source = (path: string) => ({ path, bytes: 20, sha256: 'a'.repeat(64) });
test("research declares separate paired training, label and unlabeled test inputs", () => {
 const labels = '../../../units/task/data/webspam-train.labels';
 const train = source(labels.replace('.labels', '.zip'));
 const testInput = source(labels.replace('-train.labels', '-test.zip'));
 const labelSource = source(labels);
 const inputs = identifyResearchInputs([source('../../../other/test.labels'), train, testInput, labelSource], { train: train.path, test: testInput.path, targets: labels });
 expect(inputs).toEqual({ training: train, training_labels: labelSource, test: testInput });
 expect(inputs.test?.path).not.toEndWith('.labels');
});
test("missing test inputs stay unavailable rather than substituting training or unrelated archives", () => {
 const labels = '../data/spam-train.labels';
 const files = [source(labels), source('../data/spam-train.zip'), source('../other/spam-test.zip')];
 expect(identifyResearchInputs(files, { train: '../data/spam-train.zip', test: '../data/spam-test.zip', targets: labels }).test).toBeNull();
 expect(identifyResearchInputs(files)).toEqual({ training: null, training_labels: null, test: null });
});
test("label-free configurations declare no targets source", () => {
 const files = [source('../data/a-train.zip'), source('../data/a-test.zip'), source('../data/a-train.labels')];
 expect(identifyResearchInputs(files, { train: '../data/a-train.zip', test: '../data/a-test.zip' }))
  .toEqual({ training: files[0], training_labels: null, test: files[1] });
});
const hasSpamData = listTasks().some(task => task.taskId === "spam1" && task.hasData);
const fetchReason = "requires fetched units/01-spam: ./dev bun run fetch-unit -- 01-spam";
test.skipIf(!hasSpamData)(`actual context pairs the test archive (${fetchReason})`, () => {
 const context = buildResearchContext('spam1', spamConfiguration()).context;
 expect(context.dataset.research_inputs?.training?.path).toEndWith('spam1-train.zip');
 expect(context.dataset.research_inputs?.test?.path).toEndWith('spam1-test.zip');
 expect(context.dataset.research_inputs?.test?.sha256).toHaveLength(64);
});
test("research retains the shared task/archive preflight without downloaded data", () => {
 expect(researchStage.setupRequirements).toContain('task');
 expect(setupChecks(researchStage.setupRequirements!, { taskId: 'spam1', prompts: loadPromptSnapshot() }).some(c => c.id === 'task:spam1')).toBe(true);
});
