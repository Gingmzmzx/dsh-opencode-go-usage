/**
 * Host half of the OpenCode Go usage widget.
 *
 * The OpenCode Go quota endpoint needs a bearer token, so the browser must
 * never see it. This half resolves `OPENCODE_GO_API_KEY` through the host
 * credentials service (no plugin config needed: the provider that talks to
 * OpenCode Go already declares the same env ref), queries the usage endpoint,
 * and serves a small JSON snapshot on a same-origin route that the Client half
 * polls.
 */
import process from "node:process";

/** Upstream OpenCode Go quota endpoint (verified 2026-11). */
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
/** Credential ref used by the profile's `llm-pi-ai` provider for opencode-go. */
const KEY_REF = "OPENCODE_GO_API_KEY";
/** Same-origin route consumed by the Client half. */
const ROUTE = "/opencode-go-usage/usage";
/** Success snapshots are reused for this long; concurrent readers share one fetch. */
const CACHE_MS = 30_000;
/** Upstream request budget. */
const TIMEOUT_MS = 10_000;
/** The three quota windows, in display order. */
const WINDOWS = ["rolling", "weekly", "monthly"];

/** Cordis function-plugin name. */
export const name = "opencode-go-usage";
/** The route carrier plus the credential store. */
export const inject = ["webServer", "credentials"];

/**
 * Send one JSON response without touching any request body.
 * @param {import("node:http").ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON value.
 */
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.setHeader("Cache-Control", "no-store");
	res.end(JSON.stringify(body));
}

/**
 * Percent used, clamped to the documented 0-100 range.
 * @param {unknown} value - upstream `percent` field.
 * @returns {number | null} normalized percent, or null when absent/not a number.
 */
function percentOf(value) {
	const number = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(number)) return null;
	return Math.min(100, Math.max(0, number));
}

/**
 * ISO reset timestamp, or null when the upstream field is not a string.
 * @param {unknown} value - upstream `resetsAt` field.
 * @returns {string | null} timestamp.
 */
function resetOf(value) {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Normalize the upstream payload; unknown members are dropped rather than
 * trusted, so a shape change cannot leak arbitrary fields to the browser.
 * @param {unknown} raw - parsed upstream JSON.
 * @returns {Array<{ key: string, percent: number | null, resetsAt: string | null }>} windows.
 */
function windowsOf(raw) {
	const usage = raw !== null && typeof raw === "object" && raw.usage !== null && typeof raw.usage === "object"
		? raw.usage
		: {};
	return WINDOWS.map((key) => {
		const item = usage[key] !== null && typeof usage[key] === "object" ? usage[key] : {};
		return { key, percent: percentOf(item.percent), resetsAt: resetOf(item.resetsAt) };
	});
}

/**
 * Read the bearer token: the credentials service first (profile store, then
 * env), the process environment as the last resort.
 * @param {{ resolve(ref: string): Promise<{ value: string } | undefined> }} credentials - host service.
 * @returns {Promise<string | undefined>} token.
 */
async function resolveKey(credentials) {
	try {
		const resolved = await credentials.resolve(KEY_REF);
		if (resolved !== undefined && typeof resolved.value === "string" && resolved.value.length > 0) return resolved.value;
	} catch {
		/* Missing store/service entries fall through to the process environment. */
	}
	const env = process.env[KEY_REF];
	return typeof env === "string" && env.length > 0 ? env : undefined;
}

/**
 * Fetch and normalize one snapshot.
 * @param {string | undefined} key - bearer token.
 * @returns {Promise<{ status: number, body: object }>} response to send.
 */
async function fetchSnapshot(key) {
	if (key === undefined) {
		return {
			status: 200,
			body: {
				ok: false,
				error: { code: "no-credentials", message: `no ${KEY_REF} credential is available` },
				windows: [],
			},
		};
	}
	let response;
	try {
		response = await fetch(USAGE_URL, {
			method: "GET",
			headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (error) {
		return {
			status: 502,
			body: {
				ok: false,
				error: { code: "network", message: error instanceof Error ? error.message : String(error) },
				windows: [],
			},
		};
	}
	if (!response.ok) {
		const code = response.status === 401 || response.status === 403 ? "unauthorized" : "upstream";
		return {
			status: 502,
			body: { ok: false, error: { code, message: `usage endpoint returned HTTP ${response.status}` }, windows: [] },
		};
	}
	let raw;
	try {
		raw = await response.json();
	} catch {
		return { status: 502, body: { ok: false, error: { code: "malformed", message: "usage endpoint returned non-JSON" }, windows: [] } };
	}
	return { status: 200, body: { ok: true, fetchedAt: Date.now(), windows: windowsOf(raw) } };
}

/**
 * Browser trust gate. Prefer the host's authenticated fence; when an older
 * host lacks it, fall back to rejecting cross-site requests outright.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host context.
 * @param {import("node:http").IncomingMessage} req - request.
 * @returns {number | undefined} rejection status, or undefined when allowed.
 */
function rejectionOf(ctx, req) {
	const connection = typeof ctx.get === "function" ? ctx.get("connection") : undefined;
	if (connection !== undefined && typeof connection.requestRejection === "function") {
		try {
			const rejection = connection.requestRejection(req);
			if (typeof rejection === "number") return rejection;
			return undefined;
		} catch {
			return 403;
		}
	}
	const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
	if (site === "cross-site") return 403;
	const origin = req.headers.origin;
	if (typeof origin === "string" && origin.length > 0 && origin !== "null") {
		let parsed;
		try {
			parsed = new URL(origin);
		} catch {
			return 403;
		}
		if (parsed.host.toLowerCase() !== String(req.headers.host ?? "").toLowerCase()) return 403;
	}
	return undefined;
}

/**
 * Register the usage route; the host polls upstream at most once per cache
 * window, no matter how many browser tabs are open.
 * @param {import("@deepseek-ai/cordis").Context} ctx - host context carrying webServer and credentials.
 */
export function apply(ctx) {
	/** @type {{ status: number, body: object } | undefined} */
	let cached;
	let cachedAt = 0;
	/** @type {Promise<{ status: number, body: object }> | undefined} */
	let inflight;

	/**
	 * Cached snapshot; failures are never cached so a transient error clears on the next poll.
	 * @returns {Promise<{ status: number, body: object }>} response.
	 */
	async function snapshot() {
		const now = Date.now();
		if (cached !== undefined && now - cachedAt < CACHE_MS) return cached;
		if (inflight !== undefined) return inflight;
		const key = await resolveKey(ctx.credentials);
		inflight = fetchSnapshot(key)
			.then((result) => {
				if (result.status === 200 && result.body.ok === true) {
					cached = result;
					cachedAt = Date.now();
				}
				return result;
			})
			.finally(() => {
				inflight = undefined;
			});
		return inflight;
	}

	/**
	 * Serve one usage request.
	 * @param {import("node:http").IncomingMessage} req - request.
	 * @param {import("node:http").ServerResponse} res - response.
	 */
	async function handler(req, res) {
		const rejection = rejectionOf(ctx, req);
		if (rejection !== undefined) {
			res.statusCode = rejection;
			res.end();
			return;
		}
		if (req.method !== "GET") {
			res.setHeader("Allow", "GET");
			sendJson(res, 405, { ok: false, error: { code: "method", message: "GET only" } });
			return;
		}
		try {
			const result = await snapshot();
			sendJson(res, result.status, result.body);
		} catch (error) {
			sendJson(res, 500, {
				ok: false,
				error: { code: "internal", message: error instanceof Error ? error.message : String(error) },
				windows: [],
			});
		}
	}

	ctx.effect(() => ctx.webServer.register({ kind: "exact", path: ROUTE, handler }), "opencode-go-usage: usage route");
}
