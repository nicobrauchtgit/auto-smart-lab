/** Runs only inside the solve tool sandbox. Input/output stay on inherited pipes. */
import {
 createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition,
 createBashToolDefinition, createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition,
} from "@earendil-works/pi-coding-agent";
const factories = { read: createReadToolDefinition, write: createWriteToolDefinition, edit: createEditToolDefinition,
 bash: createBashToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition, ls: createLsToolDefinition };
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
 const request = JSON.parse(await Bun.stdin.text());
 const factory = factories[request.name as keyof typeof factories];
 if (!factory) throw new Error("Unknown isolated tool");
 const tool = factory(request.cwd);
 const result = await tool.execute(request.id, request.params, undefined, update => send({ update }), undefined as any);
 send({ result });
} catch (error) { send({ error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; }
