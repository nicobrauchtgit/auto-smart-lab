import { describe, expect, test } from "bun:test";

import {
	extractTaskDescription,
	extractUnitDescription,
	htmlToMarkdown,
} from "./fetch_unit.ts";


describe("SmartLab description extraction", () => {
	test("extracts the task description instead of the submit modal", () => {
		const page = `
			<div class="row">
				<div class="col-md-12"><ol class="breadcrumb"><li>Task</li></ol></div>
				<div class="col-md-8">
					<h1 class="bd-title mb-3">Spam Detection</h1>
					<p>Train a spam classifier with Balanced Accuracy.</p>
					<div class="codehilite"><pre><code>data/example.x;1</code></pre></div>
				</div>
				<div class="col-md-4"><p>Sidebar</p></div>
			</div>
			<div class="modal-content"><h5>Submit New Attempt</h5></div>`;

		const markdown = htmlToMarkdown(extractTaskDescription(page));
		expect(markdown).toContain("Train a spam classifier");
		expect(markdown).toContain("data/example.x;1");
		expect(markdown).toContain("```");
		expect(markdown).not.toContain("Sidebar");
		expect(markdown).not.toContain("Submit New Attempt");
	});

	test("excludes confidential unit credentials and task cards", () => {
		const page = `
			<div class="row"><div class="col-md-12">
				<h1 class="bd-title mb-3">Introduction with Spam</h1>
				<p>Welcome to the spam unit.</p>
				<div class="cards-columns">
					<button>Show Confidential Unit Information</button>
					<div id="user_info"><p>Please login with ssh user@host with the password secret.</p></div>
				</div>
				<h2>Tasks</h2><p>Task cards follow.</p>
			</div></div>`;

		const markdown = htmlToMarkdown(extractUnitDescription(page));
		expect(markdown).toContain("Welcome to the spam unit");
		expect(markdown).not.toContain("Confidential");
		expect(markdown).not.toContain("password");
		expect(markdown).not.toContain("Task cards");
	});
});
