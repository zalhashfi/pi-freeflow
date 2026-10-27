/**
 * Relay attempt audit: relayFetch's optional 5th parameter reports every
 * attempt the turn abandons in favour of another — a rolled status, a header
 * deadline, a socket fault — with a 1-based attempt number, and reports
 * nothing when the first attempt serves the request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
	relayFetch,
	_resetRollNotifyForTest,
	_setAttemptHeaderTimeoutForTest,
} from "../src/relay.ts";
import { resetAllRelayHealth, setActiveRelayState } from "../src/relay-state.ts";
import type { RelayState } from "../src/types.ts";
import { withIsolatedRelayFiles } from "./_sandbox-helpers.ts";

const UPSTREAM = "https://opencode.ai/zen/v1/chat/completions";
const RELAY_A = "https://relay-a.example.com";
const RELAY_B = "https://relay-b.example.com";

interface AttemptFailure {
	attempt: number;
	status?: number;
	reason: string;
}

function poolState(urls: string[]): RelayState {
	return {
		enabled: true,
		url: urls[0] ?? "",
		relays: urls.map((url) => ({ url })),
		mode: "auto",
	} as unknown as RelayState;
}

/** Response stub with the cancelling body the roll branches expect. */
function stubResponse(status: number, body = "{}"): Response {
	return {
		status,
		ok: status >= 200 && status < 300,
		headers: new Headers({ "content-type": "application/json" }),
		body: { cancel: async () => {} },
		clone() {
			return { text: async () => body };
		},
		text: async () => body,
	} as unknown as Response;
}

function abortError(): Error {
	const err = new Error("The operation was aborted.");
	err.name = "AbortError";
	return err;
}

test("relay attempt audit: a rolled 429 reports its status once, 1-based", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		const failures: AttemptFailure[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input) === RELAY_A) return stubResponse(429, '{"error":{"message":"rate limited"}}');
			return stubResponse(200, '{"id":"served"}');
		});

		const res = await relayFetch(
			UPSTREAM,
			{ method: "POST", body: "{}" },
			"audit-429",
			{},
			(info) => failures.push(info),
		);

		assert.equal(res.status, 200, "the sibling relay must serve the turn");
		assert.equal(fetchMock.mock.callCount(), 2, "one rolled attempt, then the sibling");
		assert.deepEqual(failures, [{ attempt: 1, status: 429, reason: "rate-limited" }]);
	});
});

test("relay attempt audit: a 504 roll reports the gateway status", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		const failures: AttemptFailure[] = [];
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input) === RELAY_A) return stubResponse(504, "{}");
			return stubResponse(200, '{"id":"served"}');
		});

		const res = await relayFetch(
			UPSTREAM,
			{ method: "POST", body: "{}" },
			"audit-504",
			{},
			(info) => failures.push(info),
		);

		assert.equal(res.status, 200);
		assert.deepEqual(failures, [{ attempt: 1, status: 504, reason: "gateway-timeout" }]);
	});
});

test("relay attempt audit: a header deadline reports header-timeout with no status", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const restoreDeadline = _setAttemptHeaderTimeoutForTest(40);
	try {
		await withIsolatedRelayFiles(async () => {
			setActiveRelayState(poolState([RELAY_A]), false);
			resetAllRelayHealth();
			_resetRollNotifyForTest();
			const failures: AttemptFailure[] = [];
			const calls: string[] = [];
			t.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
				calls.push(String(input));
				if (String(input) === RELAY_A) {
					const { promise, reject } = Promise.withResolvers<Response>();
					init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
					return await promise;
				}
				return stubResponse(200, '{"id":"direct"}');
			});

			const pending = relayFetch(
				UPSTREAM,
				{ method: "POST", body: "{}" },
				"audit-timeout",
				{},
				(info) => failures.push(info),
			);
			t.mock.timers.tick(40);
			const res = await pending;

			assert.equal(res.status, 200, "the direct fallback serves after the deadline");
			assert.deepEqual(calls, [RELAY_A, UPSTREAM], "one hung relay attempt, then direct");
			assert.deepEqual(failures, [{ attempt: 1, reason: "header-timeout" }]);
		});
	} finally {
		restoreDeadline();
	}
});

test("relay attempt audit: a socket fault reports network-error", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		const failures: AttemptFailure[] = [];
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input) === RELAY_A) throw new Error("socket hang up");
			return stubResponse(200, '{"id":"direct"}');
		});

		const res = await relayFetch(
			UPSTREAM,
			{ method: "POST", body: "{}" },
			"audit-network",
			{},
			(info) => failures.push(info),
		);

		assert.equal(res.status, 200);
		assert.deepEqual(failures, [{ attempt: 1, reason: "network-error" }]);
	});
});

test("relay attempt audit: a first-try 200 reports nothing", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		const failures: AttemptFailure[] = [];
		const fetchMock = t.mock.method(globalThis, "fetch", async () => stubResponse(200, '{"id":"served"}'));

		const res = await relayFetch(
			UPSTREAM,
			{ method: "POST", body: "{}" },
			"audit-clean",
			{},
			(info) => failures.push(info),
		);

		assert.equal(res.status, 200);
		assert.equal(fetchMock.mock.callCount(), 1, "no roll happened");
		assert.deepEqual(failures, [], "a served first attempt is not an abandoned one");
	});
});

test("relay attempt audit: a throwing hook never breaks the roll", async (t) => {
	await withIsolatedRelayFiles(async () => {
		setActiveRelayState(poolState([RELAY_A, RELAY_B]), false);
		resetAllRelayHealth();
		_resetRollNotifyForTest();
		t.mock.method(globalThis, "fetch", async (input: unknown) => {
			if (String(input) === RELAY_A) return stubResponse(429, "{}");
			return stubResponse(200, '{"id":"served"}');
		});

		const res = await relayFetch(
			UPSTREAM,
			{ method: "POST", body: "{}" },
			"audit-throwing-hook",
			{},
			() => {
				throw new Error("observer exploded");
			},
		);

		assert.equal(res.status, 200, "observation is best-effort and must not disturb the turn");
	});
});
