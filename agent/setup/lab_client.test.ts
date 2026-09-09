import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";

import { LabClient } from "./lab_client.ts";


const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function listen(server: Server): Promise<number> {
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("test server has no TCP port");
	return address.port;
}

describe("LabClient", () => {
	test("does not send host-only cookies to a different hostname", async () => {
		let receivedCookie = "";
		const server = createServer((request, response) => {
			if (request.url === "/set") {
				response.setHeader("Set-Cookie", "session=private; Path=/; HttpOnly");
				response.setHeader("Content-Type", "text/plain");
				response.end("set");
				return;
			}
			receivedCookie = request.headers.cookie ?? "";
			response.setHeader("Content-Type", "text/plain");
			response.end("checked");
		});
		const port = await listen(server);
		const client = new LabClient({ baseUrl: `http://127.0.0.1:${port}/` });

		await client.get(`http://127.0.0.1:${port}/set`);
		await client.get(`http://localhost:${port}/check`);

		expect(receivedCookie).toBe("");
	});

	test("does not decode binary archives as HTML", async () => {
		const body = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
		const server = createServer((_request, response) => {
			response.setHeader("Content-Type", "application/zip");
			response.end(body);
		});
		const port = await listen(server);
		const client = new LabClient({ baseUrl: `http://127.0.0.1:${port}/` });

		const result = await client.get("archive.zip");

		expect(result.body).toEqual(body);
		expect(result.text).toBe("");
	});

	test("does not re-login for a foreign-host 403", async () => {
		let loginRequests = 0;
		const lab = createServer((_request, response) => {
			loginRequests++;
			response.setHeader("Content-Type", "text/html");
			response.end('<form><input name="username"><input type="password" name="password"></form>');
		});
		const download = createServer((_request, response) => {
			response.statusCode = 403;
			response.setHeader("Content-Type", "text/plain");
			response.end("forbidden");
		});
		const labPort = await listen(lab);
		const downloadPort = await listen(download);
		const client = new LabClient({ baseUrl: `http://127.0.0.1:${labPort}/` });

		await expect(client.get(`http://localhost:${downloadPort}/archive.zip`)).rejects.toThrow("HTTP 403");
		expect(loginRequests).toBe(0);
	});
});
