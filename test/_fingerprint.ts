/**
 * Test adapter: the fingerprint-injection contract, expressed against the LIVE
 * implementation.
 *
 * This used to be a second implementation (`injectFingerprintTools` in
 * src/tool-translation.ts) that no production code called while six test files
 * validated it — a twin that can diverge from the code that actually runs
 * without any gate noticing. The live path is
 * `ensureChat/Responses/MessagesFingerprintTools`, which merges into a request
 * body; this wraps that in a pure array-in/array-out shape so the translation
 * tests can stay readable.
 */
import {
	ensureChatFingerprintTools,
	ensureMessagesFingerprintTools,
	ensureResponsesFingerprintTools,
} from "../src/opencode-fingerprint.ts";

export function withFingerprintTools(
	tools: Record<string, unknown>[],
	pathname: string,
	ompLike?: boolean,
): Record<string, unknown>[] {
	const body: Record<string, unknown> = { tools };
	if (pathname.endsWith("/responses")) ensureResponsesFingerprintTools(body, ompLike);
	else if (pathname.endsWith("/messages")) ensureMessagesFingerprintTools(body, ompLike);
	else ensureChatFingerprintTools(body, ompLike);
	return body.tools as Record<string, unknown>[];
}