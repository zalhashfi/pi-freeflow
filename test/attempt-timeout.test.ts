/**
 * Per-attempt header-deadline behavior (offline, mocked fetch).
 *
 * The attempt deadline bounds the HEADER WAIT only: it must abort a hung
 * header wait (roll the candidate) yet not hang over the streaming body —
 * a streamed turn must survive far past the deadline as long as bytes flow.
 *
 * The body-cadence test deliberately uses a small real-timer pump (three
 * 25ms gaps over a 40ms deadline). Fake timers cannot express this failure
 * mode: the bug it guards is a deadline hanging over the body, observable
 * only once REAL time crosses the deadline while bytes still flow — and a
 * reintroduced unvirtualizable deadline (AbortSignal.timeout) would pass a
 * virtual-warped test silently. Assertions fire only after the body has
 * fully ended; there is no sleep-polling anywhere.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import { relayFetch, _setAttemptHeaderTimeoutForTest } from "../src/relay.ts";
import {
	setActiveRelayState,
	resetAllRelayHealth,
	getRelayHealth,
	isRelayHealthy,
} from "../src/relay-state.ts";

const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
const R1 = "https://deadline-a.example.com";
const R2 = "https://deadline-b.example.com";

function usePool(urls: string[]): void {
	setActiveRelayState({
		enabled: true,
		url: urls[0] ?? "",
		relays: urls.map((u) => ({ url: u })),
		mode: "auto",
	} as unknown as Parameters<typeof setActiveRelayState>[0], false);
	resetAllRelayHealth();
}

function restorePool(): void {
	try {
		setActiveRelayState({ enabled: true, url: "", relays: [], mode: "auto" } as unknown as Parameters<typeof setActiveRelayState>[0], false);
	} catch { }
	resetAllRelayHealth();
}

function abortError(): Error {
	const err = new Error("The operation was aborted.");
	err.name = "AbortError";
	return err;
}

/** Resolve after `ms` real milliseconds — modeled streaming cadence, not a poll wait. */
function pump(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

test("attempt header deadline never kills a streamed body past the deadline", async (t) => {
	const restoreDeadline = _setAttemptHeaderTimeoutForTest(40);
	try {
		usePool([R1]);
		const signals: Array<AbortSignal | undefined> = [];
		const spec = [
			'data: {"delta":"a"}\n\n',
			'data: {"delta":"b"}\n\n',
			'data: {"delta":"c"}\n\n',
			"data: [DONE]\n\n",
		];
		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
			assert.equal(url, R1);
			const signal = (init as { signal?: AbortSignal }).signal;
			signals.push(signal);
			const pt = new PassThrough();
			signal?.addEventListener("abort", () => {
				if (!pt.destroyed) pt.destroy(abortError());
			}, { once: true });
			// Headers settle IMMEDIATELY; the body streams afterwards across
			// three 25ms real-time gaps — the deadline (40ms) elapses between
			// chunk boundaries while bytes still flow. Under a whole-body
			// deadline (the old implementation) this loop dies mid-turn.
			const res = new Response(Readable.toWeb(pt) as unknown as ReadableStream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
			void (async () => {
				for (const chunk of spec) {
					pt.push(Buffer.from(chunk, "utf8"));
					await pump(25);
				}
				pt.end();
			})();
			return res;
		});
		const res = await relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "dl1");
		assert.equal(res.status, 200);
		const body = await res.text();
		assert.equal(body, spec.join(""), "the full streamed body must arrive despite the deadline elapsing");
		assert.equal(
			signals[0]?.aborted,
			false,
			"the attempt deadline must be disarmed once headers settle",
		);
		const health = getRelayHealth(R1);
		assert.ok(health, "success record exists");
		assert.equal(health.successCount ?? 0, 1, "the served relay must be marked successful");
		assert.equal(isRelayHealthy(R1), true);
	} finally {
		restoreDeadline();
		restorePool();
	}
});

test("attempt header deadline still aborts a hung header wait and rolls on", async (t) => {
	// Fully deterministic: the deadline and the hedge grace are setTimeout
	// timers, so the virtual clock drives the abort and the roll to R2.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const restoreDeadline = _setAttemptHeaderTimeoutForTest(40);
	try {
		usePool([R1, R2]);
		const signals: AbortSignal[] = [];
		const calls: string[] = [];
		t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
			calls.push(url);
			const signal = (init as { signal?: AbortSignal }).signal as AbortSignal;
			signals.push(signal);
			if (url === R1) {
				const gate = Promise.withResolvers<Response>();
				signal.addEventListener("abort", () => gate.reject(abortError()), { once: true });
				return gate.promise;
			}
			return new Response('data: {"delta":"ok"}\n\ndata: [DONE]\n\n', {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		});
		const pending = relayFetch(UPSTREAM, { method: "POST", body: "{}" }, "dl2");
		t.mock.timers.tick(40);
		const res = await pending;
		assert.equal(res.status, 200, "the sibling relay must fulfil the request");
		assert.ok(
			(await res.text()).includes('{"delta":"ok"}'),
			"the answer must come from the sibling the deadline rolled to",
		);
		assert.equal(calls.length, 2, "one candidate hung, the sibling served — no direct fallback");
		assert.equal(
			signals[0]?.aborted,
			true,
			"the hung header wait must be aborted by its own deadline",
		);
		const health = getRelayHealth(R1);
		assert.ok(health, "the hung relay must carry a failure record");
		assert.equal(health.consecutiveFailures, 1);
		assert.ok(
			(health.lastError ?? "").includes("relay header timeout"),
			`the failure must read as a header timeout: ${health.lastError}`,
		);
		assert.equal(isRelayHealthy(R1), false, "the hung header relay must be cooling");
		assert.equal(isRelayHealthy(R2), true);
	} finally {
		restoreDeadline();
		restorePool();
	}
});
