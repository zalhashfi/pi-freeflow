/**
 * Regressions for the honest-failure fixes: a stream that carries no answer must
 * not be reported as one, and a body the proxy cannot aggregate must not reach
 * the client labelled as JSON.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { convertSseToJson, sseToResponsesJson } from "../src/opencode-fingerprint.ts";
import { createSseStreamCloakState, rewriteSseBlock, type StreamCloakOptions } from "../src/stream-pipe.ts";
import { buildArgRepairSchemas } from "../src/tool-args.ts";

const BAD_TODO = '{"op":"init","phases":"[{\\"phase\\":\\"R\\",\\"items\\":[\\"a\\"]}]"}';
const schemas = buildArgRepairSchemas([
	{
		type: "function",
		name: "todo",
		description: "apply a single todo operation",
		parameters: {
			type: "object",
			properties: {
				op: { type: "string" },
				list: { type: "array", items: { type: "object", properties: { phase: { type: "string" }, items: { type: "array", items: { type: "string" } } }, required: ["phase", "items"] } },
			},
			required: ["op"],
		},
	},
]);

test("a responses stream carrying no answer reports incomplete, not completed", () => {
	// A `completed` answer with zero output tells the host the model chose to
	// say nothing. That is a different — and wrong — claim than "the stream was
	// cut", and it hides a truncation as a legitimate empty turn.
	const sse = `event: response.in_progress\ndata: ${JSON.stringify({ type: "response.in_progress" })}\n\ndata: [DONE]\n\n`;
	const out = sseToResponsesJson(sse, true, undefined, undefined, undefined, schemas) as Record<string, unknown>;
	assert.equal(out.status, "incomplete", "a cut stream must not claim completion");
	assert.deepEqual(out.output, []);
});

test("SSE-shaped input always yields parseable JSON, never raw SSE bytes", () => {
	// Every caller has already committed to `content-type: application/json` by
	// the time convertSseToJson runs, so a pass-through of SSE bytes would reach
	// the client as a parse error with no diagnosis. These are the shapes an
	// aggregator can meet: unparseable frames, a wrong field type, a bare ping.
	for (const hostile of [
		"data: {not json}\n\ndata: [DONE]\n\n",
		'data: {"choices":"nope"}\n\ndata: [DONE]\n\n',
		"event: ping\ndata: \n\ndata: [DONE]\n\n",
	]) {
		const out = convertSseToJson(hostile, "/v1/chat/completions", true, undefined, undefined, undefined, schemas);
		assert.doesNotThrow(() => JSON.parse(out), `not parseable as JSON: ${hostile}`);
		assert.ok(!out.includes("data:"), "no SSE framing leaks into a JSON answer");
	}
});

test("a streamed Anthropic message frame is cloaked and repaired, not forwarded raw", () => {
	// The aggregate path already handled `type: "message"`; the streaming rewriter
	// fell through and forwarded it verbatim, so an injected placeholder call
	// could leak downstream and a malformed one reached the host unrepaired.
	const cloak: StreamCloakOptions = {
		callerHadTools: true,
		injected: ["edit"],
		caseRestore: { bash: "Bash" },
		findGlob: { renamedFindToGlob: true },
		pathname: "/v1/messages",
		argSchemas: schemas,
	};
	const frame = `data: ${JSON.stringify({
		type: "message",
		message: {
			id: "msg_1",
			role: "assistant",
			content: [
				{ type: "tool_use", id: "tu_1", name: "edit", input: { path: "a.txt" } },
				{ type: "tool_use", id: "tu_2", name: "glob", input: { pattern: "*.ts" } },
				{ type: "tool_use", id: "tu_3", name: "todo", input: { op: "init", phases: '[{"phase":"R","items":["a"]}]' } },
			],
		},
	})}\n\n`;
	const out = rewriteSseBlock(frame, createSseStreamCloakState(), cloak);
	assert.ok(out, "the frame is forwarded after cloaking");
	assert.ok(!out!.includes('"tu_1"'), "the injected placeholder block is dropped");
	assert.ok(!out!.includes('"name":"edit"'), "no injected name survives");
	assert.ok(out!.includes('"name":"find"'), "upstream glob restores to the caller's find");
	assert.ok(!out!.includes("phases"), "the malformed todo input is repaired, not passed through");
	assert.ok(out!.includes('"phase"'), "the repaired phases carry the declared shape");
});