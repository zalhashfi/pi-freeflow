/**
 * Tool-call audit recorder (src/toolcall-audit.ts): the classification matrix,
 * the three wire shapes, JSONL privacy, retry correlation, rotation and the
 * never-throw contract.
 *
 * Every recorder is given its own file under a temp dir, so no assertion here
 * depends on the sandbox data dir or on write order.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	classifyToolcalls,
	createToolcallRecorder,
	type ToolcallCall,
	type ToolcallRecorderOptions,
} from "../src/toolcall-audit.ts";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-freeflow-audit-"));
}

function baseOpts(
	file: string,
	overrides: Partial<ToolcallRecorderOptions> = {},
): ToolcallRecorderOptions {
	return {
		reqId: `req-${randomUUID()}`,
		model: "test-model",
		lane: "chat",
		wire: "chat",
		stream: true,
		declaredNames: ["read", "write"],
		file,
		...overrides,
	};
}

function readJsonl(file: string): Array<Record<string, any>> {
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/** One SSE block holding several `data:` events, the shape the pipe hands over. */
function block(...events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test("classifyToolcalls covers every verdict", () => {
	const ok: ToolcallCall = { name: "read", argsBytes: 2, argsValid: true, known: true };
	assert.deepEqual(classifyToolcalls([ok], "tool_calls"), { failures: [], remap: "none" });

	assert.deepEqual(classifyToolcalls([], "tool_calls"), {
		failures: ["no_tool_calls"],
		remap: "model",
	});

	assert.deepEqual(
		classifyToolcalls([{ name: "nope", argsBytes: 2, argsValid: true, known: false }], "tool_calls"),
		{ failures: ["unknown_tool_name"], remap: "tool-name" },
	);

	// Case-only drift is not the declared casing: the host rejects it, so it is
	// still a tool-name remap even though the tool obviously exists.
	assert.deepEqual(
		classifyToolcalls([{ name: "Read", argsBytes: 2, argsValid: true, known: false }], "tool_calls"),
		{ failures: ["unknown_tool_name"], remap: "tool-name" },
	);

	assert.deepEqual(
		classifyToolcalls([{ name: "read", argsBytes: 5, argsValid: false, known: true }], "tool_calls"),
		{ failures: ["malformed_arguments"], remap: "model" },
	);

	// An empty argument string is its own failure, never double-reported as malformed.
	assert.deepEqual(
		classifyToolcalls([{ name: "read", argsBytes: 0, argsValid: false, known: true }], "tool_calls"),
		{ failures: ["empty_arguments"], remap: "model" },
	);

	// A mixed turn reports every distinct failure; the name verdict wins the remap.
	assert.deepEqual(
		classifyToolcalls(
			[
				{ name: "read ghost", argsBytes: 2, argsValid: true, known: false },
				{ name: "read", argsBytes: 4, argsValid: false, known: true },
			],
			"tool_calls",
		),
		{ failures: ["unknown_tool_name", "malformed_arguments"], remap: "tool-name" },
	);
});

test("chat observe: duplicated name frame collapses, split parallel calls stay distinct", () => {
	const file = path.join(tempDir(), "chat.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file));
	// A name fragment …
	recorder.observe(
		block({
			choices: [
				{ delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: "" } }] } },
			],
		}),
	);
	// … then a frame that restates the whole name alongside the arguments.
	recorder.observe(
		block({
			choices: [
				{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: '{"path":"a"}' } }] } },
			],
		}),
	);
	// A second parallel call reuses index 0 with its own id.
	recorder.observe(
		block({
			choices: [
				{ delta: { tool_calls: [{ index: 0, id: "call_b", function: { name: "write", arguments: '{"path":"b"}' } }] } },
			],
		}),
	);
	recorder.observe(block({ choices: [{ finish_reason: "tool_calls", delta: {} }] }));
	recorder.finish();

	const summary = readJsonl(file)[0];
	assert.equal(summary.calls.length, 2);
	assert.deepEqual(
		summary.calls.map((call: Record<string, any>) => call.name),
		["read", "write"],
	);
	assert.equal(summary.calls[0].argsBytes, Buffer.byteLength('{"path":"a"}', "utf8"));
	assert.equal(
		summary.calls.every((call: Record<string, any>) => call.argsValid && call.known),
		true,
	);
	assert.equal(summary.finishReason, "tool_calls");
	assert.equal(summary.terminal, true);
	assert.deepEqual(summary.failures, []);
	assert.equal(summary.remap, "none");
});

test("responses observe: item name plus argument deltas and done", () => {
	const file = path.join(tempDir(), "responses.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file, { wire: "responses", lane: "responses" }));
	recorder.observe(
		block({
			type: "response.output_item.added",
			item: { type: "function_call", id: "fc_1", name: "read", arguments: "" },
		}),
	);
	recorder.observe(
		block({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' }),
	);
	recorder.observe(
		block({ type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a"}' }),
	);
	recorder.observe(
		block({
			type: "response.function_call_arguments.done",
			item_id: "fc_1",
			arguments: '{"path":"a"}',
		}),
	);
	recorder.observe(block({ type: "response.completed", response: { status: "completed" } }));
	recorder.finish();

	const summary = readJsonl(file)[0];
	assert.equal(summary.calls.length, 1);
	assert.deepEqual(summary.calls[0], {
		name: "read",
		argsBytes: 12,
		argsValid: true,
		known: true,
	});
	assert.equal(summary.finishReason, "completed");
	assert.equal(summary.terminal, true);
	assert.deepEqual(summary.failures, []);
});

test("messages observe: tool_use start plus input_json_delta accumulation", () => {
	const file = path.join(tempDir(), "messages.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file, { wire: "messages", lane: "messages" }));
	recorder.observe(
		block({
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: "toolu_1", name: "read" },
		}),
	);
	recorder.observe(
		block({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '{"path":' },
		}),
	);
	recorder.observe(
		block({
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: '"a"}' },
		}),
	);
	recorder.observe(block({ type: "content_block_stop", index: 0 }));
	recorder.observe(block({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
	recorder.finish();

	const summary = readJsonl(file)[0];
	assert.equal(summary.calls.length, 1);
	assert.deepEqual(summary.calls[0], {
		name: "read",
		argsBytes: 12,
		argsValid: true,
		known: true,
	});
	assert.equal(summary.finishReason, "tool_use");
	assert.deepEqual(summary.failures, []);
});

test("summary is private, complete and written once", () => {
	const file = path.join(tempDir(), "summary.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file, { reqId: "req-summary" }));
	const secret = "ARGUMENT-VALUE-7731-MUST-NOT-BE-LOGGED";
	recorder.observe(
		block({
			choices: [
				{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: `{"token":"${secret}"}` } }] } },
			],
		}),
	);
	recorder.repair("tool-name-case", "mapped Read -> read");
	recorder.repair("tool-name-case", "second sighting is collapsed");
	recorder.refireSkipped();
	recorder.finish({ finishReason: "tool_calls", terminal: true });
	recorder.finish({ finishReason: "stop", terminal: false });

	const raw = fs.readFileSync(file, "utf8");
	assert.equal(raw.includes(secret), false, "argument contents must never reach the audit file");
	const lines = readJsonl(file);
	assert.equal(lines.length, 1);
	const summary = lines[0];
	for (const key of [
		"ts",
		"kind",
		"reqId",
		"model",
		"lane",
		"wire",
		"stream",
		"attempt",
		"retryOf",
		"declared",
		"calls",
		"finishReason",
		"terminal",
		"refireSkipped",
		"repairs",
		"failures",
		"remap",
	]) {
		assert.equal(key in summary, true, `summary is missing ${key}`);
	}
	assert.equal(summary.kind, "summary");
	assert.equal(summary.reqId, "req-summary");
	assert.deepEqual(summary.declared, ["read", "write"]);
	assert.equal(summary.attempt, 1);
	assert.equal(summary.retryOf, null);
	assert.equal(summary.refireSkipped, true);
	assert.deepEqual(summary.repairs, [{ kind: "tool-name-case", detail: "mapped Read -> read" }]);
	assert.equal(summary.finishReason, "tool_calls");
	assert.equal(summary.terminal, true);
});

test("finishFromChat classifies an already-assembled message", () => {
	const file = path.join(tempDir(), "nonstream.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file, { stream: false }));
	recorder.finishFromChat(
		{
			tool_calls: [
				{ id: "c1", function: { name: "Read", arguments: "{}" } },
				{ id: "c2", function: { name: "read", arguments: "{oops" } },
			],
		},
		"tool_calls",
	);
	recorder.finish();

	const lines = readJsonl(file);
	assert.equal(lines.length, 1);
	assert.equal(lines[0].stream, false);
	assert.equal(lines[0].calls.length, 2);
	assert.deepEqual(lines[0].failures, ["unknown_tool_name", "malformed_arguments"]);
	assert.equal(lines[0].remap, "tool-name");
});

test("idle recorders write nothing; attempt failures are bounded", () => {
	const dir = tempDir();
	const idleFile = path.join(dir, "idle.jsonl");
	const idle = createToolcallRecorder(baseOpts(idleFile, { declaredNames: [] }));
	assert.equal(idle.active, false);
	idle.observe(
		block({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] } }] }),
	);
	idle.repair("tool-name-remap", "detail");
	idle.refireSkipped();
	idle.attemptFailure({ attempt: 1, reason: "boom" });
	idle.finish();
	idle.finishFromChat({ tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] });
	assert.equal(fs.existsSync(idleFile), false);

	const file = path.join(dir, "active.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file));
	recorder.attemptFailure({ attempt: 2, status: 503, reason: "upstream overloaded" });
	recorder.attemptFailure({ attempt: 3, reason: "no tool calls" });
	for (let i = 0; i < 100; i++) {
		recorder.attemptFailure({ attempt: 4, reason: `retry ${i}` });
	}
	const events = readJsonl(file);
	assert.equal(events[0].kind, "attempt-failure");
	assert.equal(events[0].attempt, 2);
	assert.equal(events[0].status, 503);
	assert.equal(events[0].reason, "upstream overloaded");
	assert.equal(events[1].status, undefined);
	assert.equal(events.length <= 32, true, "attempt-failure events must stay bounded");
});

test("retry correlation: a replayed conversation reports the first failure", () => {
	const dir = tempDir();
	const seed = { messages: [{ role: "user", content: "hi" }] };

	const firstFile = path.join(dir, "first.jsonl");
	const first = createToolcallRecorder(baseOpts(firstFile, { reqId: "req-first", conversationSeed: seed }));
	first.observe(
		block({
			choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "nope", arguments: "{}" } }] } }],
		}),
	);
	first.repair("tool-name-remap", "nope -> read");
	first.finish({ finishReason: "tool_calls", terminal: true });
	const firstSummary = readJsonl(firstFile)[0];
	assert.deepEqual(firstSummary.failures, ["unknown_tool_name"]);

	const secondFile = path.join(dir, "second.jsonl");
	const second = createToolcallRecorder(baseOpts(secondFile, { reqId: "req-second", conversationSeed: seed }));
	const retry = readJsonl(secondFile)[0];
	assert.equal(retry.kind, "retry-detected");
	assert.equal(retry.attempt, 2);
	assert.equal(retry.retryOf, "req-first");
	assert.equal(retry.firstOutcome, "failed");
	assert.deepEqual(retry.firstFailures, ["unknown_tool_name"]);
	assert.deepEqual(retry.firstRepairs, ["tool-name-remap"]);

	second.observe(
		block({
			choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: "{}" } }] } }],
		}),
	);
	second.finish({ finishReason: "tool_calls", terminal: true });
	const secondSummary = readJsonl(secondFile).find((event) => event["kind"] === "summary");
	assert.equal(secondSummary?.attempt, 2);
	assert.equal(secondSummary?.retryOf, "req-first");
	assert.deepEqual(secondSummary?.failures, []);

	// A seed older than ten minutes is a fresh conversation, not a retry.
	const staleSeed = { messages: [{ role: "user", content: "much later" }] };
	const staleFirst = createToolcallRecorder(
		baseOpts(path.join(dir, "stale-first.jsonl"), { conversationSeed: staleSeed, now: () => 1_000 }),
	);
	staleFirst.finish();
	const staleSecondFile = path.join(dir, "stale-second.jsonl");
	const staleSecond = createToolcallRecorder(
		baseOpts(staleSecondFile, { conversationSeed: staleSeed, now: () => 1_000 + 11 * 60_000 }),
	);
	staleSecond.finish();
	assert.deepEqual(
		readJsonl(staleSecondFile).map((event) => event["kind"]),
		["summary"],
	);
});

test("accumulation is bounded per turn", () => {
	const dir = tempDir();
	const manyFile = path.join(dir, "many.jsonl");
	const many = createToolcallRecorder(baseOpts(manyFile));
	for (let i = 0; i < 50; i++) {
		many.observe(
			block({
				choices: [
					{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: "read", arguments: "{}" } }] } },
				],
			}),
		);
	}
	many.finish({ finishReason: "tool_calls", terminal: true });
	const manySummary = readJsonl(manyFile).find((event) => event["kind"] === "summary");
	assert.equal(manySummary?.calls.length, 32);

	const bigFile = path.join(dir, "big.jsonl");
	const big = createToolcallRecorder(baseOpts(bigFile));
	const payload = `{"blob":"${"x".repeat(400 * 1024)}"}`;
	big.observe(
		block({
			choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "read", arguments: payload } }] } }],
		}),
	);
	big.finish({ finishReason: "tool_calls", terminal: true });
	const bigSummary = readJsonl(bigFile).find((event) => event["kind"] === "summary");
	// The retained copy is capped; the reported size stays truthful.
	assert.equal(bigSummary?.calls[0].argsBytes, Buffer.byteLength(payload, "utf8"));
	assert.ok(fs.statSync(bigFile).size < 20_000, "summary line stays small");
});

test("a body without an event stream is unclassifiable, not a model failure", () => {
	const file = path.join(tempDir(), "raw.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file));
	recorder.finish({ terminal: false, unclassifiable: true });
	const summary = readJsonl(file)[0];
	assert.deepEqual(summary?.failures, []);
	assert.equal(summary?.remap, "unknown");
});

test("retry correlation: a re-send racing the first turn chains to the in-flight attempt", () => {
	const dir = tempDir();
	const seed = { messages: [{ role: "user", content: "race" }] };
	const first = createToolcallRecorder(
		baseOpts(path.join(dir, "race-first.jsonl"), { reqId: "req-race-1", conversationSeed: seed }),
	);
	const secondFile = path.join(dir, "race-second.jsonl");
	const second = createToolcallRecorder(
		baseOpts(secondFile, { reqId: "req-race-2", conversationSeed: seed }),
	);
	const retry = readJsonl(secondFile)[0];
	assert.equal(retry.kind, "retry-detected");
	assert.equal(retry.attempt, 2);
	assert.equal(retry.retryOf, "req-race-1");
	assert.equal(retry.firstOutcome, "pending");

	second.finish();
	// The first turn finishing late must not overwrite the newer attempt.
	first.finish();
	const thirdFile = path.join(dir, "race-third.jsonl");
	const third = createToolcallRecorder(
		baseOpts(thirdFile, { reqId: "req-race-3", conversationSeed: seed }),
	);
	assert.equal(readJsonl(thirdFile)[0]?.attempt, 3);
	third.finish();
});

test("rotation renames the oversized file to .1 before appending", () => {
	const file = path.join(tempDir(), "rotate.jsonl");
	createToolcallRecorder(baseOpts(file, { maxBytes: 1 })).finish();
	assert.equal(fs.existsSync(file), true);
	assert.equal(fs.existsSync(`${file}.1`), false);
	const firstSize = fs.statSync(file).size;

	createToolcallRecorder(baseOpts(file, { maxBytes: 1 })).finish();
	assert.equal(fs.existsSync(`${file}.1`), true);
	assert.equal(fs.statSync(`${file}.1`).size, firstSize);
	assert.equal(readJsonl(file).length, 1);
	assert.equal(readJsonl(`${file}.1`).length, 1);
});

test("an unwritable audit path never throws", () => {
	const dir = tempDir();
	const blocker = path.join(dir, "blocker");
	fs.writeFileSync(blocker, "not a directory", "utf8");
	const file = path.join(blocker, "audit.jsonl");
	const recorder = createToolcallRecorder(baseOpts(file, { conversationSeed: { id: randomUUID() } }));
	assert.doesNotThrow(() => {
		recorder.observe(
			block({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] } }] }),
		);
		recorder.repair("tool-name-remap", "detail");
		recorder.refireSkipped();
		recorder.attemptFailure({ attempt: 1, reason: "boom" });
		recorder.finish();
		recorder.finishFromChat({ tool_calls: [{ id: "c1", function: { name: "read", arguments: "{}" } }] });
	});
	assert.equal(fs.existsSync(file), false);
});
