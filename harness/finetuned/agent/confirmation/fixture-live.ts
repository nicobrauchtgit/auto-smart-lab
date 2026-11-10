/** Process-death regression helper; no agent or provider session. */
import { readFileSync } from "node:fs";
import { runConfirmation } from "./service.js";
import { prepareSolveSandbox, trainingSandboxCommand } from "../run/solve_sandbox.js";
import { readPythonEnvironment } from "../run/python_environment.js";
const options = JSON.parse(readFileSync(process.argv[2], "utf8"));
const policy = prepareSolveSandbox(options.workspace, readPythonEnvironment());
await runConfirmation({ ...options, sandboxCommand: (command, input) => trainingSandboxCommand(policy, command, input) });
