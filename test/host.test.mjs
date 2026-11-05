/**
 * Offline host-half checks: route registration, trust gate, method handling,
 * payload normalization, and the no-credential branch.
 *
 * Run with a real key to exercise the upstream call:
 *   OPENCODE_GO_API_KEY=... node test/host.test.mjs
 */
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

/** Capture the route the plugin registers. */
function harness({ key, connection } = {}) {
	const routes = [];
	const ctx = {
		get(name) {
			return name === "connection" ? connection : undefined;
		},
		effect(fn) {
			return fn();
		},
		webServer: {
			register(route) {
				routes.push(route);
				return () => {};
			},
		},
		credentials: {
			async resolve(ref) {
				assert.equal(ref, "OPENCODE_GO_API_KEY");
				return key === undefined ? undefined : { value: key, source: "test" };
			},
		},
	};
	apply(ctx);
	assert.equal(routes.length, 1);
	assert.equal(routes[0].kind, "exact");
	assert.equal(routes[0].path, "/opencode-go-usage/usage");
	return routes[0];
}

/**
 * Invoke one route handler with a minimal request/response pair.
 * @returns {Promise<{ status: number, body: string, headers: Record<string, string> }>} response.
 */
async function call(route, { method = "GET", headers = {} } = {}) {
	const sent = { status: 0, body: "", headers: {} };
	const req = { method, headers: { host: "localhost:3080", ...headers } };
	const res = {
		set statusCode(value) {
			sent.status = value;
		},
		get statusCode() {
			return sent.status;
		},
		setHeader(name, value) {
			sent.headers[name.toLowerCase()] = value;
		},
		end(body) {
			sent.body = body ?? "";
		},
	};
	await route.handler(req, res);
	return sent;
}

// route path / registration
{
	const route = harness({ key: "fake" });
	assert.equal(route.path, "/opencode-go-usage/usage");
}

// method gate
{
	const route = harness({ key: "fake" });
	const response = await call(route, { method: "POST" });
	assert.equal(response.status, 405);
	assert.equal(JSON.parse(response.body).error.code, "method");
}

// cross-site rejection in the fallback fence (no connection service)
{
	const route = harness({ key: "fake" });
	const response = await call(route, { method: "GET", headers: { "sec-fetch-site": "cross-site" } });
	assert.equal(response.status, 403);
}

// connect-src mismatch in the fallback fence
{
	const route = harness({ key: "fake" });
	const response = await call(route, { method: "GET", headers: { origin: "https://evil.example" } });
	assert.equal(response.status, 403);
}

// delegated fence wins when present
{
	const route = harness({
		key: "fake",
		connection: {
			requestRejection() {
				return 401;
			},
		},
	});
	const response = await call(route);
	assert.equal(response.status, 401);
}

// no credentials -> config hint, not a 502
{
	const saved = process.env.OPENCODE_GO_API_KEY;
	delete process.env.OPENCODE_GO_API_KEY;
	const route = harness();
	const response = await call(route);
	if (saved !== undefined) process.env.OPENCODE_GO_API_KEY = saved;
	assert.equal(response.status, 200);
	const body = JSON.parse(response.body);
	assert.equal(body.ok, false);
	assert.equal(body.error.code, "no-credentials");
}

// live upstream (only when a real key is supplied)
if (process.env.OPENCODE_GO_API_KEY !== undefined && process.env.OPENCODE_GO_API_KEY.length > 0) {
	const route = harness({ key: process.env.OPENCODE_GO_API_KEY });
	const response = await call(route);
	assert.equal(response.status, 200);
	const body = JSON.parse(response.body);
	assert.equal(body.ok, true);
	assert.equal(body.windows.length, 3);
	assert.deepEqual(body.windows.map((w) => w.key), ["rolling", "weekly", "monthly"]);
	for (const window of body.windows) {
		assert.ok(window.percent === null || (window.percent >= 0 && window.percent <= 100), `percent out of range: ${window.percent}`);
		assert.ok(window.resetsAt === null || !Number.isNaN(Date.parse(window.resetsAt)), `bad reset: ${window.resetsAt}`);
	}
	console.log("live windows:", body.windows.map((w) => `${w.key}=${w.percent}%`).join(" "));
}

console.log("host tests passed");
