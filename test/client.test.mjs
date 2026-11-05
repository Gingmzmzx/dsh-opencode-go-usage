/**
 * Offline render test for the client half.
 *
 * There is no browser on this machine, so this test loads the real
 * `lib/client.js` through a fake `window.__ModuleLoader__` and renders the
 * component with a tiny hook runtime (useState/useRef/useCallback/useEffect).
 * It covers the three visual states that matter: ready (wide + rail), error,
 * and the tone thresholds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/* ---------------------------------------------------------------- shims -- */

const hookState = [];
let hookCursor = 0;
let currentTree = null;
let scheduled = false;

function scheduleRender() {
	if (scheduled) return;
	scheduled = true;
	queueMicrotask(() => {
		scheduled = false;
		renderTree();
	});
}

function sameDeps(a, b) {
	return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

function useState(initial) {
	const index = hookCursor++;
	if (!(index in hookState)) hookState[index] = { value: typeof initial === "function" ? initial() : initial };
	const slot = hookState[index];
	const set = (next) => {
		const value = typeof next === "function" ? next(slot.value) : next;
		if (Object.is(value, slot.value)) return;
		slot.value = value;
		scheduleRender();
	};
	return [slot.value, set];
}

function useRef(initial) {
	const index = hookCursor++;
	if (!(index in hookState)) hookState[index] = { current: initial };
	return hookState[index];
}

function useCallback(fn, deps) {
	const index = hookCursor++;
	const slot = hookState[index];
	if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.fn;
	hookState[index] = { fn, deps };
	return fn;
}

function useEffect(fn, deps) {
	const index = hookCursor++;
	const slot = hookState[index];
	if (slot !== undefined && sameDeps(slot.deps, deps)) return;
	if (slot !== undefined && typeof slot.cleanup === "function") slot.cleanup();
	hookState[index] = { deps, cleanup: fn() };
}

const React = {
	createElement(type, props, ...children) {
		return { type, props: props === null || props === undefined ? {} : { ...props }, children: children.flat(Infinity) };
	},
	useState,
	useRef,
	useCallback,
	useEffect,
};

const root = { component: null, props: null };

function renderTree() {
	hookCursor = 0;
	currentTree = root.component(root.props);
}

async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Render `Component` and wait until the effect's fetch has settled. */
async function mount(Component, props, body, { ok = true, status = 200 } = {}) {
	const intervals = [];
	globalThis.fetch = async () => ({
		ok,
		status,
		async json() {
			return body;
		},
	});
	globalThis.setInterval = (fn, ms) => {
		intervals.push(ms);
		return 1;
	};
	globalThis.clearInterval = () => {};
	root.component = Component;
	root.props = props;
	hookState.length = 0;
	renderTree();
	await settle();
	await settle();
	return { tree: currentTree, intervals };
}

/* ------------------------------------------------------------- helpers --- */

function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	return (node.children ?? []).map(textOf).join(" ");
}

function walk(node, visit) {
	if (node === null || node === undefined || typeof node !== "object") return;
	if (Array.isArray(node)) {
		node.forEach((child) => walk(child, visit));
		return;
	}
	visit(node);
	(node.children ?? []).forEach((child) => walk(child, visit));
}

function findByRole(tree, role) {
	const found = [];
	walk(tree, (node) => {
		if (node.props && node.props.role === role) found.push(node);
	});
	return found;
}

/* ---------------------------------------------------------------- setup -- */

let captured = null;
globalThis.window = { __ModuleLoader__: { load(entry) { captured = entry; } } };
globalThis.document = {
	visibilityState: "visible",
	addEventListener() {},
	removeEventListener() {},
	querySelector() {
		return null;
	},
	createElement() {
		return { dataset: {}, textContent: "" };
	},
	head: { appendChild() {} },
};

await import("../lib/client.js");
assert.ok(captured !== null, "client module registered with the loader");
const mod = captured.factory((id) => {
	if (id === "react") return React;
	throw new Error(`unexpected require: ${id}`);
});

let UsageWidget = null;
mod.apply({
	effect(fn) {
		fn();
	},
	locale: {
		register() {
			return () => {};
		},
	},
	slots: {
		inject(name, cb) {
			cb();
		},
		register(options, component) {
			UsageWidget = component;
			return () => {};
		},
	},
});
assert.equal(typeof UsageWidget, "function");

/* ----------------------------------------------------------------- tests - */

const zh = {
	"title": "OpenCode Go",
	"window.rolling": "5 小时",
	"window.weekly": "本周",
	"window.monthly": "本月",
	"percent": "{value}%",
	"reset": "{time} 重置",
	"updated": "更新于 {time}",
	"error.short": "用量读取失败",
	"error.noKey": "未配置 OPENCODE_GO_API_KEY",
	"error.auth": "API Key 无效或已过期",
	"unavailable": "—",
};

function translate(key, params = {}) {
	const template = zh[key] ?? key;
	return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
}

const READY = {
	ok: true,
	fetchedAt: Date.parse("2026-11-05T13:30:00.000Z"),
	windows: [
		{ key: "rolling", percent: 2, resetsAt: "2026-11-05T13:41:51.000Z" },
		{ key: "weekly", percent: 1, resetsAt: "2026-11-09T00:00:00.000Z" },
		{ key: "monthly", percent: 0, resetsAt: "2026-12-05T08:14:16.000Z" },
	],
};

test("registers one locale entry and one sidebar footer action", () => {
	const effects = [];
	const registrations = [];
	mod.apply({
		effect(fn, label) {
			effects.push({ fn, label });
			fn();
		},
		locale: {
			register(ns, dict) {
				registrations.push({ kind: "locale", ns, dict });
				return () => {};
			},
		},
		slots: {
			inject(name, cb) {
				cb();
			},
			register(options, component) {
				registrations.push({ kind: "slot", options, component });
				return () => {};
			},
		},
	});
	assert.equal(effects.length, 1);
	assert.equal(registrations[0].ns, "opencode-go-usage");
	assert.ok(registrations[0].dict.zh["title"]);
	assert.ok(registrations[0].dict.en["window.weekly"]);
	const slot = registrations[1];
	assert.equal(slot.options.name, "sidebar.footer.action");
	assert.equal(slot.options.id, "opencode-go-usage");
	assert.equal(slot.options.locale, "opencode-go-usage");
	assert.equal(slot.options.order, 20);
});

test("wide mode renders three labelled progress bars from the snapshot", async () => {
	const { tree, intervals } = await mount(UsageWidget, { wide: true, t: translate }, READY);
	assert.deepEqual(intervals, [60_000]);
	const text = textOf(tree);
	assert.match(text, /OpenCode Go/);
	assert.match(text, /5 小时/);
	assert.match(text, /本周/);
	assert.match(text, /本月/);
	assert.match(text, /2%/);
	assert.match(text, /1%/);
	assert.match(text, /0%/);
	const bars = findByRole(tree, "progressbar");
	assert.equal(bars.length, 3);
	assert.deepEqual(bars.map((bar) => bar.props["aria-valuenow"]), [2, 1, 0]);
	const fills = [];
	walk(tree, (node) => {
		if (node.props && node.props.className === "ocg-fill") fills.push(node);
	});
	// Positive levels get a 1.5% floor so a 1% window is still visible.
	assert.deepEqual(fills.map((fill) => fill.props.style.width), ["2%", "1.5%", "0%"]);
	// The per-row reset time and last refresh live in the header tooltip.
	assert.match(tree.props.title, /5 小时 2%/);
	assert.match(tree.props.title, /更新于 /);
});

test("collapsed rail renders nothing instead of a clipped gauge", async () => {
	const { tree } = await mount(UsageWidget, { wide: false, t: translate }, READY);
	assert.equal(tree, null);
});

test("no-credentials error surfaces the localized key hint", async () => {
	const { tree } = await mount(UsageWidget, { wide: true, t: translate }, { ok: false, error: { code: "no-credentials" } });
	assert.match(textOf(tree), /未配置 OPENCODE_GO_API_KEY/);
});

test("tone thresholds switch warn at 80 and error at 95", async () => {
	const body = {
		...READY,
		windows: [
			{ key: "rolling", percent: 85, resetsAt: null },
			{ key: "weekly", percent: 96, resetsAt: null },
			{ key: "monthly", percent: 79, resetsAt: null },
		],
	};
	const { tree } = await mount(UsageWidget, { wide: true, t: translate }, body);
	const bars = findByRole(tree, "progressbar");
	assert.deepEqual(bars.map((bar) => bar.props.className), ["ocg-track is-warn", "ocg-track is-error", "ocg-track"]);
});
