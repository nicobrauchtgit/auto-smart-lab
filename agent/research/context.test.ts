import { expect, test } from "bun:test";
import { identifyResearchInputs, buildResearchContext } from "./context.js";
import { researchStage } from "../pipeline/stages/research.js";
import { setupChecks } from "../pipeline/setup.js";
import { loadPromptSnapshot } from "../prompts/loader.js";

const source = (path: string) => ({ path, bytes: 20, sha256: 'a'.repeat(64) });
test("research declares separate paired training, label and unlabeled test inputs", () => {
 const labels = '../../../units/task/data/webspam-train.labels';
 const train = source(labels.replace('.labels', '.zip'));
 const testInput = source(labels.replace('-train.labels', '-test.zip'));
 const labelSource = source(labels);
 const inputs = identifyResearchInputs([source('../../../other/test.labels'), train, testInput, labelSource], labels);
 expect(inputs).toEqual({ training: train, training_labels: labelSource, test: testInput });
 expect(inputs.test?.path).not.toEndWith('.labels');
});
test("missing test inputs stay unavailable rather than substituting training or unrelated archives", () => {
 const labels = '../data/spam-train.labels';
 const files = [source(labels), source('../data/spam-train.zip'), source('../other/spam-test.zip')];
 expect(identifyResearchInputs(files, labels).test).toBeNull();
 expect(identifyResearchInputs(files)).toEqual({ training: null, training_labels: null, test: null });
});
test("actual context pairs the test archive and retains the shared task/archive preflight", () => {
 const context = buildResearchContext('spam1').context;
 expect(context.dataset.research_inputs?.training?.path).toEndWith('spam1-train.zip');
 expect(context.dataset.research_inputs?.test?.path).toEndWith('spam1-test.zip');
 expect(context.dataset.research_inputs?.test?.sha256).toHaveLength(64);
 expect(researchStage.setupRequirements).toContain('task');
 expect(setupChecks(researchStage.setupRequirements!, { taskId: 'spam1', prompts: loadPromptSnapshot() }).some(c => c.id === 'task:spam1')).toBe(true);
});
