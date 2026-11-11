/**
 * Runs only inside the solve tool sandbox. Input/output stay on inherited pipes.
 * File tools only: an agent's shell is the supervised one (run/agent_shell.ts),
 * so this worker has no shell definition for any request to reach.
 */
import {
 createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
 createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
const factories = { read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
 grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition };
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
 const request = JSON.parse(await Bun.stdin.text());
 const factory = Object.hasOwn(factories, request.name) ? factories[request.name as keyof typeof factories] : undefined;
 if (!factory) throw new Error("Unknown isolated tool");
 const tool = factory(request.cwd);
 const result = await tool.execute(request.id, request.params, undefined, update => send({ update }), undefined as any);
 send({ result });
} catch (error) { send({ error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
