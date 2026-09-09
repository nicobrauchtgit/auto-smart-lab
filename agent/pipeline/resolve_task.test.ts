import { describe, expect, test } from "bun:test";

import { resolveTask, TaskNotFoundError, type TaskRef } from "./resolve_task.js";

const tasks: TaskRef[] = [
	{
		taskId: "spam1", taskTitle: "Spam Detection with Machine Learning", taskSlug: "spam-detection-with-machine-learning",
		taskNumber: 1, taskDir: "units/01-spam/spam-detection-with-machine-learning",
		unitTitle: "Introduction with Spam", unitSlug: "01-spam", unitNumber: 1, hasData: true,
	},
	{
		taskId: "spam2", taskTitle: "Spam Detection in Practice", taskSlug: "spam-detection-in-practice",
		taskNumber: 2, taskDir: "units/01-spam/spam-detection-in-practice",
		unitTitle: "Introduction with Spam", unitSlug: "01-spam", unitNumber: 1, hasData: true,
	},
	{
		taskId: "evasion1", taskTitle: "Evading a Classifier", taskSlug: "evading-a-classifier",
		taskNumber: 1, taskDir: "units/02-evasion/evading-a-classifier",
		unitTitle: "Evasion", unitSlug: "02-evasion", unitNumber: 2, hasData: false,
	},
];

describe("resolveTask", () => {
	test("resolves unit and task numbers", () => {
		expect(resolveTask({ unit: "1", task: "1" }, tasks).taskId).toBe("spam1");
		expect(resolveTask({ unit: "2", task: "1" }, tasks).taskId).toBe("evasion1");
	});

	test("resolves a canonical task ID without a unit", () => {
		expect(resolveTask({ taskId: "spam2" }, tasks).taskId).toBe("spam2");
	});

	test("resolves unit slugs and title fragments", () => {
		expect(resolveTask({ unit: "01-spam", task: "2" }, tasks).taskId).toBe("spam2");
		expect(resolveTask({ unit: "evasion", task: "1" }, tasks).taskId).toBe("evasion1");
	});

	test("reports the known tasks when nothing matches", () => {
		const failure = (() => {
			try {
				resolveTask({ unit: "9", task: "1" }, tasks);
			} catch (error) {
				return error;
			}
		})();
		expect(failure).toBeInstanceOf(TaskNotFoundError);
		expect((failure as Error).message).toContain("unit 1 task 1 → spam1");
	});

	test("rejects an ambiguous selection instead of guessing", () => {
		expect(() => resolveTask({ task: "1" }, tasks)).toThrow(/ambiguous/);
	});
});
