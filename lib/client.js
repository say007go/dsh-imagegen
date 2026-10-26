// dsh-imagegen 客户端：在【插件】详情页注册配置表单（plugins.bundle.config 槽位）。
// 手工构造的 __ModuleLoader__ 模块（与官方客户端包同格式，无需构建）。
// 契约来源：catppuccin 注册块 / ui-settings ConfigFormController / dsh-settings redact。
window.__ModuleLoader__.load({
	id: "dsh-imagegen",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const { jsx, jsxs } = require("react/jsx-runtime");

		const NS = "imagegen";
		const BUNDLE = "dsh-imagegen";
		const inject = ["slots", "configForms"];

		// 控制器在 apply 里绑定；组件只经由稳定引用访问。
		let FORM = null;
		let FORMS = null;
		let SUB = null;
		let SNAP = null;

		// ---------- 样式（内联，避免 CSS 依赖） ----------
		const rowStyle = { display: "flex", alignItems: "center", gap: 12, padding: "6px 0", flexWrap: "wrap" };
		const labelStyle = { minWidth: 210, fontSize: 13, opacity: 0.8 };
		const inputStyle = {
			flex: "0 0 360px", maxWidth: "100%", padding: "6px 10px", borderRadius: 8,
			border: "1px solid rgba(128,128,128,0.35)", background: "rgba(128,128,128,0.08)",
			color: "inherit", fontSize: 13, outline: "none",
		};
		const hintStyle = { fontSize: 12, opacity: 0.55, marginTop: 2 };
		const linkStyle = { color: "#58a6ff", textDecoration: "underline", marginLeft: 4 };
		const sectionTitle = { fontSize: 15, fontWeight: 600, margin: "20px 0 4px" };

		// ---------- 文本/下拉/数字字段：本地草稿，失焦或回车提交 ----------
		function Field({ label, path, value, onCommit, type, options, hint, disabled }) {
			const initial = value === undefined || value === null ? "" : String(value);
			const [draft, setDraft] = React.useState(initial);
			React.useEffect(() => { setDraft(initial); }, [initial]);
			const commit = () => {
				if (draft === initial) return;
				if (type === "number") {
					if (draft.trim() === "") { setDraft(initial); return; }
					const n = Number(draft);
					if (!Number.isFinite(n)) { setDraft(initial); return; }
					onCommit(path, n);
					return;
				}
				onCommit(path, draft);
			};
			const common = {
				style: inputStyle, value: draft, disabled: !!disabled,
				onChange: (e) => setDraft(e.target.value),
				onBlur: commit,
				onKeyDown: (e) => { if (e.key === "Enter") e.currentTarget.blur(); },
			};
			return jsxs("div", { style: rowStyle, children: [
				jsxs("div", { style: labelStyle, children: [
					label,
					hint ? jsxs("div", { style: hintStyle, children: [hint] }) : null,
				] }),
				options
					? jsx("select", { ...common, style: { ...inputStyle, flex: "0 0 220px" }, onChange: (e) => { setDraft(e.target.value); onCommit(path, e.target.value); }, children: options.map((o) => jsx("option", { value: o, children: o }, o)) })
					: type === "textarea"
						? jsx("textarea", { ...common, rows: 3, style: { ...inputStyle, flex: "1 1 420px", resize: "vertical", lineHeight: 1.5 } })
						: jsx("input", { ...common, type: type === "number" ? "text" : type || "text", inputMode: type === "number" ? "numeric" : void 0 }),
			] });
		}

		// ---------- 勾选字段 ----------
		function Checkbox({ label, path, value, onCommit, hint, disabled }) {
			return jsxs("div", { style: rowStyle, children: [
				jsxs("div", { style: labelStyle, children: [label, hint ? jsxs("div", { style: hintStyle, children: [hint] }) : null] }),
				jsx("input", { type: "checkbox", checked: value === true, disabled: !!disabled, style: { width: 16, height: 16 }, onChange: (e) => onCommit(path, e.target.checked) }),
			] });
		}

		// ---------- 密钥字段：只写输入 + 已设置标记（值永不回传客户端） ----------
		function SecretField({ label, path, isSet, onCommit, onClear, hint, disabled }) {
			const [draft, setDraft] = React.useState("");
			const commit = () => { if (draft) { onCommit(path, draft); setDraft(""); } };
			return jsxs("div", { style: rowStyle, children: [
				jsxs("div", { style: labelStyle, children: [
					label,
					jsx("span", { style: { marginLeft: 8, fontSize: 12, color: isSet ? "#3fb950" : "#d29922" }, children: isSet ? "● 已设置" : "○ 未设置" }),
					hint ? jsxs("div", { style: hintStyle, children: [hint] }) : null,
				] }),
				jsxs("div", { style: { display: "flex", gap: 8, alignItems: "center" }, children: [
					jsx("input", {
						type: "password", autoComplete: "off", style: { ...inputStyle, flex: "0 0 300px" },
						placeholder: isSet ? "留空保持不变，输入即覆盖" : "粘贴密钥",
						value: draft, disabled: !!disabled,
						onChange: (e) => setDraft(e.target.value),
						onBlur: commit,
						onKeyDown: (e) => { if (e.key === "Enter") e.currentTarget.blur(); },
					}),
					isSet ? jsx("button", {
						style: { ...inputStyle, flex: "0 0 auto", cursor: "pointer", padding: "6px 14px" },
						disabled: !!disabled, onClick: () => onClear(path), children: "清除",
					}) : null,
				] }),
			] });
		}

		// ---------- 插件详情页配置卡片 ----------
		function ImagegenConfigCard() {
			const snap = React.useSyncExternalStore(SUB, SNAP, SNAP);
			const view = FORMS.describe().getSnapshot?.()?.view;
			const ns = (view?.namespaces ?? []).find((n) => n.ns === NS) || {};
			const value = snap.value ?? {};
			const writable = snap.writable !== false && ns.writable !== false;
			const secretSet = (path) => (ns.secrets ?? []).some((s) => s.set === true && JSON.stringify(s.path) === JSON.stringify(path));
			const get = (grp, key) => value?.[grp]?.[key];
			const set = (path, v) => { void FORM.mutate([{ op: "set", path, value: v }]); };
			const unset = (path) => { void FORM.mutate([{ op: "unset", path }]); };
			const dis = !writable;
			const F = (props) => jsx(Field, { ...props, onCommit: set, disabled: dis });

			return jsxs("section", { style: { padding: "4px 2px 28px", maxWidth: 920 }, children: [
				jsx("p", { style: hintStyle, children: "修改即时保存到 profile 并对下次调用生效。其余高级项（协议、图生图模式、轮询参数）有代码默认值，如需调整可编辑 cordis.patch.yml。" }),

				jsx("div", { style: sectionTitle, children: "生图中转站" }),
				jsx(F, { label: "Base URL", path: ["provider", "baseUrl"], value: get("provider", "baseUrl"), hint: "默认多米API，可自行更换API平台" }),
				jsx(SecretField, { label: "API Key", path: ["provider", "apiKey"], isSet: secretSet(["provider", "apiKey"]), onCommit: set, onClear: unset, disabled: dis,
					hint: jsxs("span", { children: [
						"没有Key？",
						jsx("a", { href: "https://duomiapi.com/user/register?cps=S9hKE2Oq", target: "_blank", rel: "noopener noreferrer", style: linkStyle, children: "点击注册多米API" }),
					] }) }),
				jsx(F, { label: "Model", path: ["provider", "model"], value: get("provider", "model"), hint: "输入模型ID" }),
				jsx(F, { label: "默认分辨率", path: ["provider", "defaultSize"], value: get("provider", "defaultSize"), hint: "默认4K，可自行设置" }),

				jsx("div", { style: sectionTitle, children: "腾讯云 COS（仅图生图+本地参考图需要）" }),
				jsx(Checkbox, { label: "启用 COS", path: ["cos", "enabled"], value: get("cos", "enabled"), onCommit: set, disabled: dis, hint: "文生图/URL 参考图不消耗 COS" }),
				jsx(F, { label: "Region", path: ["cos", "region"], value: get("cos", "region"), hint: "如 ap-guangzhou" }),
				jsx(F, { label: "Bucket", path: ["cos", "bucket"], value: get("cos", "bucket"), hint: "格式 name-appid" }),
				jsx(SecretField, { label: "SecretId", path: ["cos", "secretId"], isSet: secretSet(["cos", "secretId"]), onCommit: set, onClear: unset, disabled: dis }),
				jsx(SecretField, { label: "SecretKey", path: ["cos", "secretKey"], isSet: secretSet(["cos", "secretKey"]), onCommit: set, onClear: unset, disabled: dis }),

				jsx("div", { style: sectionTitle, children: "Prompt 后缀" }),
				jsx(Checkbox, { label: "启用追加", path: ["promptEnhance", "enabled"], value: get("promptEnhance", "enabled"), onCommit: set, disabled: dis, hint: "启用后，每次提交生图都会在 prompt 末尾追加下方文本" }),
				jsx(Field, { label: "后缀文本", path: ["promptEnhance", "suffix"], value: get("promptEnhance", "suffix"), onCommit: set, disabled: dis, type: "textarea" }),
			] });
		}

		// ---------- 挂载：host 服务 namespace 被托管时注册到详情页槽位 ----------
		function apply(ctx) {
			ctx.effect(() => {
				const forms = ctx.configForms;
				if (typeof forms?.whileServed !== "function" || typeof forms?.get !== "function") return;
				FORMS = forms;
				FORM = forms.get(NS);
				SUB = FORM.subscribe.bind(FORM);
				SNAP = FORM.getSnapshot.bind(FORM);
				return forms.whileServed([NS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
					name: "plugins.bundle.config",
					key: BUNDLE,
					inject: () => ({}),
				}, ImagegenConfigCard)));
			}, "dsh-imagegen: page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
