import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { sanitizeResponsesPayload, startProxy } from "../src/proxy.ts";

test("sanitizeResponsesPayload strips encrypted_content and include reasoning.encrypted_content", () => {
	const body: Record<string, unknown> = {
		model: "muse-spark-1.3-contributor-free",
		include: ["reasoning.encrypted_content"],
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: "hello" }],
			},
			{
				type: "reasoning",
				summary: [],
				encrypted_content: "Q-PaDgHpvwaxu5slUxQGQ4REqthROwnTx4zyy1J9zQCqUBQnYyb2EIitzOBfaoQq",
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
			},
		],
	};

	const modified = sanitizeResponsesPayload(body);
	assert.equal(modified, true, "must return true when modifications occur");
	assert.equal(body.include, undefined, "include array containing only reasoning.encrypted_content must be deleted");

	const reasoningItem = (body.input as Array<Record<string, unknown>>)[1];
	assert.equal(reasoningItem.type, "reasoning");
	assert.equal("encrypted_content" in reasoningItem, false, "encrypted_content must be stripped");
});

test("sanitizeResponsesPayload handles partial include and nested content parts", () => {
	const body: Record<string, unknown> = {
		model: "muse-spark-1.3-contributor-free",
		include: ["reasoning.encrypted_content", "other_field"],
		input: [
			{
				role: "assistant",
				content: [
					{
						type: "reasoning",
						encrypted_content: "secret_nested_token",
						text: "thinking...",
					},
				],
			},
		],
	};

	const modified = sanitizeResponsesPayload(body);
	assert.equal(modified, true);
	assert.deepEqual(body.include, ["other_field"], "other include entries must be preserved");

	const assistantTurn = (body.input as Array<Record<string, unknown>>)[0];
	const part = (assistantTurn.content as Array<Record<string, unknown>>)[0];
	assert.equal("encrypted_content" in part, false, "nested encrypted_content must be deleted");
	assert.equal(part.text, "thinking...", "other properties must be intact");
});

test("sanitizeResponsesPayload returns false for clean payloads without mutating", () => {
	const body: Record<string, unknown> = {
		model: "mimo-v2.5-free",
		input: [
			{
				role: "user",
				content: [{ type: "input_text", text: "ping" }],
			},
		],
	};

	const snapshot = JSON.stringify(body);
	const modified = sanitizeResponsesPayload(body);
	assert.equal(modified, false, "must return false when no encrypted_content is present");
	assert.equal(JSON.stringify(body), snapshot, "payload must not be altered");
});

test("proxy server sanitizes /v1/responses in-flight before forwarding direct upstream", async () => {
	// Spin up a mock upstream to capture what the proxy forwards
	let capturedBody: Record<string, unknown> | null = null;
	let capturedHeaders: http.IncomingHttpHeaders | null = null;

	const mockUpstream = http.createServer((req, res) => {
		capturedHeaders = req.headers;
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			try {
				capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: "ok" }));
		});
	});

	await new Promise<void>((resolve) => mockUpstream.listen(0, "127.0.0.1", () => resolve()));
	const mockPort = (mockUpstream.address() as { port: number }).port;

	// Start proxy on test port
	const proxyPort = 19184;
	const { server, port } = await startProxy(proxyPort);
	assert.ok(server);

	try {
		// Mock fetch globally for direct upstream call to route to our mockUpstream
		const originalFetch = globalThis.fetch;
		globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const urlStr = typeof input === "string" ? input : input.toString();
			if (urlStr.includes("opencode.ai")) {
				// Redirect to mock upstream
				const mockUrl = urlStr.replace(/https:\/\/[^/]+/, `http://127.0.0.1:${mockPort}`);
				return originalFetch(mockUrl, init);
			}
			return originalFetch(input, init);
		};

		try {
			const payload = {
				model: "muse-spark-1.3-contributor-free",
				include: ["reasoning.encrypted_content"],
				input: [
					{
						role: "user",
						content: [{ type: "input_text", text: "what is 2+2?" }],
					},
					{
						type: "reasoning",
						summary: [],
						encrypted_content: "stale_token_that_would_cause_400",
					},
				],
			};

			const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
			});

			assert.equal(res.status, 200);
			assert.ok(capturedBody, "upstream must receive a body");
			assert.equal((capturedBody as Record<string, unknown>).include, undefined, "include must be stripped");

			const items = (capturedBody as Record<string, unknown>).input as Array<Record<string, unknown>>;
			assert.equal(items.length, 2);
			assert.equal("encrypted_content" in items[1], false, "encrypted_content must not reach upstream");

			const expectedLength = Buffer.byteLength(JSON.stringify(capturedBody));
			assert.equal(
				Number(capturedHeaders?.["content-length"]),
				expectedLength,
				"content-length header must match sanitized body length",
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await new Promise<void>((resolve) => mockUpstream.close(() => resolve()));
	}
});
