/**
 * Client half of the OpenCode Go usage widget.
 *
 * Renders three compact progress bars (5-hour rolling window, week, month) in
 * the sidebar footer, above the Settings button. Data comes from the Host
 * half's same-origin route; the bearer token never leaves the host process.
 */
window.__ModuleLoader__.load({
	id: "dsh-opencode-go-usage",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = "opencode-go-usage";
		/** Same-origin snapshot route registered by the Host half. */
		const ROUTE = "/opencode-go-usage/usage";
		/** Poll cadence; the Host half caches for 30 s, so this is one upstream hit per minute at most. */
		const POLL_MS = 60_000;
		/** Display order of the quota windows. */
		const WINDOW_KEYS = ["rolling", "weekly", "monthly"];

		const zh = {
			"title": "OpenCode Go",
			"window.rolling": "5 小时",
			"window.weekly": "本周",
			"window.monthly": "本月",
			"percent": "{value}%",
			"reset": "{time} 重置",
			"refresh": "刷新用量",
			"updated": "更新于 {time}",
			"loading": "正在读取用量…",
			"error.short": "用量读取失败",
			"error.noKey": "未配置 OPENCODE_GO_API_KEY",
			"error.auth": "API Key 无效或已过期",
			"retry": "重试",
			"unavailable": "—"
		};
		const en = {
			"title": "OpenCode Go",
			"window.rolling": "5 hours",
			"window.weekly": "This week",
			"window.monthly": "This month",
			"percent": "{value}%",
			"reset": "resets {time}",
			"refresh": "Refresh usage",
			"updated": "updated {time}",
			"loading": "Loading usage…",
			"error.short": "Could not load usage",
			"error.noKey": "OPENCODE_GO_API_KEY is not configured",
			"error.auth": "API key is invalid or expired",
			"retry": "Retry",
			"unavailable": "—"
		};

		const CSS = [
			".ocg{display:flex;flex-direction:column;flex:1 1 auto;gap:5px;min-width:0;padding:2px 2px 8px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.25;user-select:none}",
			".ocg-head{display:flex;align-items:center;justify-content:space-between;gap:6px;min-width:0}",
			".ocg-title{font-weight:600;font-size:10.5px;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".ocg-refresh{width:18px;height:18px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".ocg-refresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".ocg-refresh.is-spinning svg{animation:ocg-spin .9s linear infinite}",
			"@keyframes ocg-spin{to{transform:rotate(360deg)}}",
			".ocg-row{display:grid;grid-template-columns:34px minmax(0,1fr) 30px;align-items:center;gap:6px;min-width:0}",
			".ocg-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".ocg-value{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}",
			".ocg-track{position:relative;display:block;height:5px;border-radius:999px;background:var(--dsw-alias-border-l1);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 18%, transparent);overflow:hidden}",
			".ocg-fill{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-brand-primary);transition:width .35s var(--ds-ease-in-out, ease)}",
			".ocg-track.is-warn .ocg-fill{background:var(--dsw-alias-state-warn-primary)}",
			".ocg-track.is-error .ocg-fill{background:var(--dsw-alias-state-error-primary)}",
			".ocg-track.is-empty .ocg-fill{opacity:0}",
			".ocg-error{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
		].join("");

		/** Inject the widget stylesheet once per document. */
		function ensureStyle() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-opencode-go-usage/usage.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-opencode-go-usage";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/**
		 * Short percentage text: whole numbers above 10, one decimal below.
		 * @param {number} value - percent 0-100.
		 * @returns {string} display value.
		 */
		function percentText(value) {
			if (!Number.isFinite(value)) return "—";
			if (value >= 10) return String(Math.round(value));
			if (Number.isInteger(value)) return String(value);
			return value.toFixed(1);
		}

		/**
		 * Locale-aware reset time; today keeps only the clock.
		 * @param {string} iso - ISO timestamp.
		 * @returns {string} display time.
		 */
		function timeText(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return "";
			const now = new Date();
			const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
			const options = sameDay
				? { hour: "2-digit", minute: "2-digit" }
				: { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" };
			try {
				return date.toLocaleString(undefined, options);
			} catch {
				return date.toISOString().slice(11, 16);
			}
		}

		/**
		 * Track tone for one usage level.
		 * @param {number | null} percent - usage percent.
		 * @returns {string} class suffix.
		 */
		function toneOf(percent) {
			if (percent === null) return " is-empty";
			if (percent >= 95) return " is-error";
			if (percent >= 80) return " is-warn";
			return "";
		}

		/**
		 * Window rows for rendering, in display order.
		 * @param {{ windows?: Array<{ key: string, percent: number | null, resetsAt: string | null }> }} state - snapshot.
		 * @returns {Array<{ key: string, percent: number | null, resetsAt: string | null }>} rows.
		 */
		function rowsOf(state) {
			const windows = Array.isArray(state.windows) ? state.windows : [];
			return WINDOW_KEYS.map((key) => {
				const found = windows.find((item) => item !== null && item.key === key);
				return {
					key,
					percent: found !== undefined && typeof found.percent === "number" ? found.percent : null,
					resetsAt: found !== undefined && typeof found.resetsAt === "string" ? found.resetsAt : null,
				};
			});
		}

		/** The sidebar footer widget. */
		function UsageWidget(props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const wide = props.wide !== false;
			const [state, setState] = React.useState({ phase: "loading" });
			const abortRef = React.useRef(null);
			const aliveRef = React.useRef(true);

			const load = React.useCallback(async () => {
				if (abortRef.current !== null) abortRef.current.abort();
				const controller = new AbortController();
				abortRef.current = controller;
				setState((prev) => prev.phase === "ready" ? { ...prev, refreshing: true } : { phase: "loading" });
				try {
					const response = await fetch(`${ROUTE}?t=${Date.now()}`, {
						cache: "no-store",
						credentials: "same-origin",
						signal: controller.signal,
					});
					let body = null;
					try {
						body = await response.json();
					} catch {
						/* handled below as a malformed response */
					}
					if (!aliveRef.current || controller.signal.aborted) return;
					if (!response.ok || body === null || body.ok !== true) {
						const code = body !== null && body.error !== undefined && typeof body.error.code === "string" ? body.error.code : `http-${response.status}`;
						setState({ phase: "error", code });
						return;
					}
					setState({
						phase: "ready",
						windows: Array.isArray(body.windows) ? body.windows : [],
						fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : Date.now(),
						refreshing: false,
					});
				} catch {
					if (!aliveRef.current || controller.signal.aborted) return;
					setState({ phase: "error", code: "network" });
				}
			}, []);

			React.useEffect(() => {
				aliveRef.current = true;
				load();
				const timer = setInterval(() => {
					if (document.visibilityState === "visible") load();
				}, POLL_MS);
				const onVisible = () => {
					if (document.visibilityState === "visible") load();
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => {
					aliveRef.current = false;
					clearInterval(timer);
					document.removeEventListener("visibilitychange", onVisible);
					if (abortRef.current !== null) abortRef.current.abort();
				};
			}, [load]);

			const rows = rowsOf(state);
			const errorText = state.phase === "error"
				? state.code === "no-credentials"
					? t("error.noKey")
					: state.code === "unauthorized"
						? t("error.auth")
						: t("error.short")
				: "";

			/** Multi-line tooltip: every window plus the last refresh time. */
			const tooltip = [
				t("title"),
				...rows.map((row) => `${t(`window.${row.key}`)} ${row.percent === null ? t("unavailable") : t("percent", { value: percentText(row.percent) })}`),
				state.phase === "error" ? errorText : "",
				state.phase === "ready" && typeof state.fetchedAt === "number" ? t("updated", { time: timeText(new Date(state.fetchedAt).toISOString()) }) : "",
			].filter((line) => line !== "").join("\n");

			const refreshIcon = h("svg", {
				width: 12,
				height: 12,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.6,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": true,
			}, h("path", { d: "M13.2 6.6A5.4 5.4 0 1 0 13.4 9" }), h("path", { d: "M13.4 3.2v3.5H9.9" }));

			const busy = state.phase === "loading" || state.refreshing === true;
			const refreshButton = h("button", {
				type: "button",
				className: `ocg-refresh${busy ? " is-spinning" : ""}`,
				title: t("refresh"),
				"aria-label": t("refresh"),
				onClick: () => load(),
			}, refreshIcon);

			// The 56px rail cannot hold the widget next to the shipped action, and a
			// clipped gauge is worse than none: keep the rail untouched.
			if (!wide) return null;

			return h("div", { className: "ocg", title: tooltip },
				h("div", { className: "ocg-head" },
					h("span", { className: "ocg-title" }, t("title")),
					refreshButton
				),
				state.phase === "error"
					? h("div", { className: "ocg-error", title: tooltip }, errorText)
					: rows.map((row) => h("div", { key: row.key, className: "ocg-row" },
						h("span", { className: "ocg-label" }, t(`window.${row.key}`)),
						h("span", {
							className: `ocg-track${toneOf(row.percent)}`,
							role: "progressbar",
							"aria-valuemin": 0,
							"aria-valuemax": 100,
							"aria-valuenow": row.percent === null ? 0 : Math.round(row.percent),
							"aria-label": t(`window.${row.key}`),
						}, h("span", {
							className: "ocg-fill",
							style: { width: row.percent === null ? "0%" : `${Math.max(row.percent > 0 ? 1.5 : 0, row.percent)}%` },
						})),
						h("span", { className: "ocg-value" }, row.percent === null ? t("unavailable") : t("percent", { value: percentText(row.percent) }))
					))
			);
		}

		ensureStyle();

		return {
			inject: ["slots", "locale"],
			apply(ctx) {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }), "opencode-go-usage: dictionaries");
				ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
					name: "sidebar.footer.action",
					id: "opencode-go-usage",
					order: 20,
					locale: NS,
				}, UsageWidget));
			},
		};
	},
});
