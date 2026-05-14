import {
	CustomEditor,
	getLanguageFromPath,
	highlightCode,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_CONFIG = path.join(os.homedir(), ".pi", "agent", "permissions.json");
const PROJECT_CONFIG = ".pi/permissions.json";

const BUILTIN_TOOLS = new Set(["read", "bash", "write", "edit", "grep", "find", "ls"]);

type PermissionMode = "ask" | "auto";

type PermissionConfig = {
    version?: number;
    mode?: PermissionMode;
    bash?: {
		allowExact?: string[];
		allowPrefixes?: string[];
		denyPatterns?: string[];
	};
	tools?: {
		allow?: string[];
	};
	paths?: {
		denyRead?: string[];
		denyWrite?: string[];
		sensitive?: string[];
	};
	reviewEditor?: {
		vimMode?: boolean;
	};
	mainEditor?: {
		vimMode?: boolean;
	};
};

type EffectivePolicy = Required<PermissionConfig>;

type SessionPolicy = {
	bashExact: Set<string>;
	bashPrefixes: Set<string>;
	tools: Set<string>;
};

const DEFAULT_CONFIG: PermissionConfig = {
    version: 1,
    mode: "ask",
    bash: {
		allowExact: [],
		allowPrefixes: [],
		denyPatterns: [],
	},
	tools: {
		allow: [],
	},
	paths: {
		denyRead: [],
		denyWrite: [],
		sensitive: [
			".env",
			".env.*",
			"**/.env",
			"**/.env.*",
			"**/*secret*",
			"**/*credential*",
			"**/*token*",
			"**/id_rsa",
			"**/id_ed25519",
			"**/*.pem",
			"**/*.key",
		],
	},
	reviewEditor: { vimMode: false },
	mainEditor: { vimMode: false },
};

const sessionPolicy: SessionPolicy = {
	bashExact: new Set(),
	bashPrefixes: new Set(),
	tools: new Set(),
};

let globalConfig: PermissionConfig = {};
let projectConfig: PermissionConfig = {};
let effective: EffectivePolicy = mergeConfigs(DEFAULT_CONFIG, {}, {});
let sessionModeOverride: PermissionMode | undefined;

const NORMAL_KEYS: Record<string, string | null> = {
	h: "\x1b[D",
	j: "\x1b[B",
	k: "\x1b[A",
	l: "\x1b[C",
	"0": "\x01",
	$: "\x05",
	x: "\x1b[3~",
	i: null,
	a: null,
};

type ReviewHighlightMode = "write" | "edit";

class VimEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				return;
			}
			super.handleInput(data);
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		if (data in NORMAL_KEYS) {
			if (data === "i") this.mode = "insert";
			else if (data === "a") {
				this.mode = "insert";
				super.handleInput("\x1b[C");
			} else {
				const seq = NORMAL_KEYS[data];
				if (seq) super.handleInput(seq);
			}
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) return lines;
		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}
}

class SyntaxReviewEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		editorTheme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
		private readonly syntaxTheme: ExtensionContext["ui"]["theme"],
		private readonly language: string | undefined,
		private readonly highlightMode: ReviewHighlightMode,
		private readonly vimModeEnabled: boolean,
	) {
		super(tui, editorTheme, keybindings);
	}

	handleInput(data: string): void {
		if (!this.vimModeEnabled) {
			super.handleInput(data);
			return;
		}

		if (matchesKey(data, "escape")) {
			if (this.mode === "insert") {
				this.mode = "normal";
				return;
			}
			super.handleInput(data);
			return;
		}

		if (this.mode === "insert") {
			super.handleInput(data);
			return;
		}

		if (data in NORMAL_KEYS) {
			if (data === "i") this.mode = "insert";
			else if (data === "a") {
				this.mode = "insert";
				super.handleInput("\x1b[C");
			} else {
				const seq = NORMAL_KEYS[data];
				if (seq) super.handleInput(seq);
			}
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) return;
		super.handleInput(data);
	}

	render(width: number): string[] {
		const lines = super.render(width);
		if (!this.language || lines.length <= 2) return this.renderVimLabel(lines, width);

		const paddingX = this.getPaddingX?.() ?? 0;
		const layout = buildReviewLayout(this.getLines(), width, paddingX);
		const scrollOffset = (this as unknown as { scrollOffset?: number }).scrollOffset ?? 0;
		const bodyLineCount = Math.max(0, lines.length - 2);
		for (let i = 0; i < bodyLineCount; i++) {
			const layoutLine = layout[scrollOffset + i];
			if (!layoutLine) continue;
			const styled = this.styleReviewLine(layoutLine.logicalLine, layoutLine.visualIndex, layoutLine.layoutWidth);
			if (!styled || styled === layoutLine.text) continue;
			const idx = lines[i + 1]!.indexOf(layoutLine.text);
			if (idx >= 0) {
				lines[i + 1] = `${lines[i + 1]!.slice(0, idx)}${styled}${lines[i + 1]!.slice(idx + layoutLine.text.length)}`;
			}
		}
		return this.renderVimLabel(lines, width);
	}

	private renderVimLabel(lines: string[], width: number): string[] {
		if (!this.vimModeEnabled || lines.length === 0) return lines;
		const label = this.mode === "normal" ? " NORMAL " : " INSERT ";
		const last = lines.length - 1;
		if (visibleWidth(lines[last]!) >= label.length) {
			lines[last] = truncateToWidth(lines[last]!, width - label.length, "") + label;
		}
		return lines;
	}

	private styleReviewLine(logicalLine: number, visualIndex: number, layoutWidth: number): string {
		const highlighted = buildHighlightedReviewLines(this.getLines(), this.language!, this.highlightMode, this.syntaxTheme);
		const styledLine = highlighted[logicalLine] ?? this.getLines()[logicalLine] ?? "";
		return wrapTextWithAnsi(styledLine, layoutWidth)[visualIndex] ?? "";
	}
}

type ReviewLayoutLine = { text: string; logicalLine: number; visualIndex: number; layoutWidth: number };

function buildReviewLayout(lines: string[], width: number, paddingX: number): ReviewLayoutLine[] {
	const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
	const actualPaddingX = Math.min(paddingX, maxPadding);
	const contentWidth = Math.max(1, width - actualPaddingX * 2);
	const layoutWidth = Math.max(1, contentWidth - (actualPaddingX ? 0 : 1));
	const layout: ReviewLayoutLine[] = [];
	for (let logicalLine = 0; logicalLine < lines.length; logicalLine++) {
		const chunks = wrapTextWithAnsi(lines[logicalLine] ?? "", layoutWidth);
		for (let visualIndex = 0; visualIndex < chunks.length; visualIndex++) {
			layout.push({ text: chunks[visualIndex] ?? "", logicalLine, visualIndex, layoutWidth });
		}
	}
	return layout.length ? layout : [{ text: "", logicalLine: 0, visualIndex: 0, layoutWidth }];
}

function buildHighlightedReviewLines(
	lines: string[],
	language: string,
	highlightMode: ReviewHighlightMode,
	theme: ExtensionContext["ui"]["theme"],
): string[] {
	if (highlightMode === "write") return alignHighlightedLines(lines, highlightCode(lines.join("\n"), language));

	const result = [...lines];
	const markerLine = findReplacementMarkerLine(lines);

	const originalIndexes = lines
		.map((line, index) => ({ line, index }))
		.filter(({ line }) => line.startsWith("# | "))
		.map(({ index }) => index);
	const originalHighlighted = alignHighlightedLines(
		originalIndexes.map((index) => lines[index]!.slice(4)),
		highlightCode(originalIndexes.map((index) => lines[index]!.slice(4)).join("\n"), language),
	);
	originalIndexes.forEach((lineIndex, originalIndex) => {
		result[lineIndex] = theme.fg("muted", "# | ") + (originalHighlighted[originalIndex] ?? lines[lineIndex]!.slice(4));
	});

	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.startsWith("# | ")) continue;
		if (lines[i]!.startsWith("#")) result[i] = theme.fg("muted", lines[i]!);
		else if (lines[i] === "--- replacement ---") result[i] = theme.fg("accent", lines[i]!);
	}

	if (markerLine >= 0) {
		const replacementIndexes = lines.map((_, index) => index).filter((index) => index > markerLine);
		const replacementHighlighted = alignHighlightedLines(
			replacementIndexes.map((index) => lines[index]!),
			highlightCode(replacementIndexes.map((index) => lines[index]!).join("\n"), language),
		);
		replacementIndexes.forEach((lineIndex, replacementIndex) => {
			result[lineIndex] = replacementHighlighted[replacementIndex] ?? lines[lineIndex]!;
		});
	}

	return result;
}

function alignHighlightedLines(sourceLines: string[], highlightedLines: string[]): string[] {
	if (highlightedLines.length === sourceLines.length) return highlightedLines;
	return sourceLines.map((line, index) => highlightedLines[index] ?? line);
}

function findReplacementMarkerLine(lines: string[]): number {
	return lines.findIndex((line) => line === "--- replacement ---");
}

export default function permissionsExtension(pi: ExtensionAPI) {
    pi.on("session_start", async (_event, ctx) => {
        reloadPolicy(ctx.cwd);
        if (effective.mainEditor.vimMode) {
            ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(tui, theme, kb));
        }
        updateStatus(ctx);
    });

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("read", event)) {
			return handleRead(event.input.path, ctx);
		}

		if (isToolCallEventType("bash", event)) {
			return handleBash(event.input, ctx);
		}

		if (isToolCallEventType("write", event)) {
			return handleWrite(event.input, ctx);
		}

		if (isToolCallEventType("edit", event)) {
			return handleEdit(event.input, ctx);
		}

		if (!BUILTIN_TOOLS.has(event.toolName)) {
			return handleUnknownTool(event.toolName, ctx);
		}
	});

    pi.registerCommand("permissions", {
        description: "Show effective permission policy summary",
        handler: async (_args, ctx) => {
            reloadPolicy(ctx.cwd);
            updateStatus(ctx);
            ctx.ui.notify(formatSummary(ctx.cwd), "info");
        },
    });

    pi.registerCommand("permissions-mode", {
        description: "Show or set permission mode: /permissions-mode ask|auto",
        handler: async (args, ctx) => {
            const requested = parseModeArg(args);
            if (!requested) {
                if ((args || "").trim()) ctx.ui.notify("Usage: /permissions-mode [ask|auto]", "warning");
                else ctx.ui.notify(`Permissions mode: ${currentMode()}${sessionModeOverride ? " (session override)" : ""}`, "info");
                return;
            }
            sessionModeOverride = requested;
            updateStatus(ctx);
            ctx.ui.notify(formatModeChange(requested), "success");
        },
    });

    pi.registerCommand("permissions-auto", {
        description: "Toggle Claude-Code-like auto approval: /permissions-auto [on|off|toggle]",
        handler: async (args, ctx) => {
            const action = (args || "toggle").trim().toLowerCase();
            let nextMode: PermissionMode;
            if (["on", "true", "1", "enable", "enabled", "auto"].includes(action)) nextMode = "auto";
            else if (["off", "false", "0", "disable", "disabled", "ask", "manual"].includes(action)) nextMode = "ask";
            else if (action === "" || action === "toggle") nextMode = currentMode() === "auto" ? "ask" : "auto";
            else {
                ctx.ui.notify("Usage: /permissions-auto [on|off|toggle]", "warning");
                return;
            }
            sessionModeOverride = nextMode;
            updateStatus(ctx);
            ctx.ui.notify(formatModeChange(nextMode), "success");
        },
    });

    pi.registerCommand("permissions-reload", {
        description: "Reload permission config files",
        handler: async (_args, ctx) => {
            reloadPolicy(ctx.cwd);
            updateStatus(ctx);
            ctx.ui.notify("Permissions reloaded", "success");
        },
    });

	pi.registerCommand("permissions-edit", {
		description: "Edit permission config: /permissions-edit global|project",
		handler: async (args, ctx) => {
			const scope = (args || "").trim();
			if (scope !== "global" && scope !== "project") {
				ctx.ui.notify("Usage: /permissions-edit global|project", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("Cannot edit permissions without UI", "error");
				return;
			}
			const file = scope === "global" ? GLOBAL_CONFIG : path.join(ctx.cwd, PROJECT_CONFIG);
			ensureConfigFile(file);
			const current = fs.readFileSync(file, "utf8");
			const edited = await ctx.ui.editor(`Edit ${scope} permissions: ${file}`, current);
			if (edited === undefined) return;
			try {
				JSON.parse(edited);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8");
				reloadPolicy(ctx.cwd);
				updateStatus(ctx);
				ctx.ui.notify(`Saved ${scope} permissions`, "success");
			} catch (error) {
				ctx.ui.notify(`Invalid JSON; not saved: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

async function handleRead(filePath: string, ctx: ExtensionContext) {
	const resolved = resolveForPolicy(filePath, ctx.cwd);
	if (matchesAnyPath(resolved, [...effective.paths.denyRead, ...effective.paths.sensitive], ctx.cwd)) {
		return { block: true, reason: `Read blocked by permissions policy: ${filePath}` };
	}
}

async function handleBash(input: { command: string; timeout?: number }, ctx: ExtensionContext) {
    const command = input.command.trim();
    const danger = classifyDangerousCommand(command);
    if (danger.block) return { block: true, reason: danger.reason };
    if (isBashDenied(command)) return { block: true, reason: `Bash blocked by deny pattern: ${command}` };

    if (!danger.confirm && isReadOnlyBashCommand(command)) return;
    if (isBashAllowed(command) && !danger.confirm) return;
    if (currentMode() === "auto" && !danger.confirm) return;

    if (!ctx.hasUI) return { block: true, reason: `Bash command requires approval: ${command}` };

	const choices = [
		"Deny",
		"Allow once",
		"Allow for this session",
		"Allow this exact command for this project",
		"Allow this command prefix for this project",
		"Allow this exact command globally",
	];
	const title = danger.confirm ? "Dangerous bash command requires extra approval" : "Approve bash command";
	const choice = await ctx.ui.select(`${title}:\n\n${command}\n\n${danger.reason ?? ""}`, choices);
	if (!choice || choice === "Deny") return { block: true, reason: `Denied bash command: ${command}` };

	if (danger.confirm) {
		const ok = await ctx.ui.confirm("Confirm dangerous command", `Run anyway?\n\n${command}`);
		if (!ok) return { block: true, reason: `Denied dangerous bash command: ${command}` };
	}

	if (choice === "Allow for this session") sessionPolicy.bashExact.add(command);
	else if (choice === "Allow this exact command for this project") {
		sessionPolicy.bashExact.add(command);
		addProjectRule(ctx.cwd, (cfg) => addUnique(cfg.bash!, "allowExact", command));
	} else if (choice === "Allow this command prefix for this project") {
		const prefix = await ctx.ui.input("Command prefix to allow for this project", suggestPrefix(command));
		if (!prefix) return { block: true, reason: "No prefix supplied" };
		sessionPolicy.bashPrefixes.add(prefix);
		addProjectRule(ctx.cwd, (cfg) => addUnique(cfg.bash!, "allowPrefixes", prefix));
	} else if (choice === "Allow this exact command globally") {
		sessionPolicy.bashExact.add(command);
		addGlobalRule((cfg) => addUnique(cfg.bash!, "allowExact", command));
	}
}

async function handleWrite(input: { path: string; content: string }, ctx: ExtensionContext) {
    if (matchesAnyPath(resolveForPolicy(input.path, ctx.cwd), [...effective.paths.denyWrite, ...effective.paths.sensitive], ctx.cwd)) {
        return { block: true, reason: `Write blocked by permissions policy: ${input.path}` };
    }
    if (currentMode() === "auto") return;
    if (!ctx.hasUI) return { block: true, reason: `Write requires editor review: ${input.path}` };
    const edited = await withReviewEditor(ctx, input.path, "write", () => ctx.ui.editor(`Review write: ${input.path}`, input.content));
	if (edited === undefined) return { block: true, reason: `Write review cancelled: ${input.path}` };
	input.content = edited;
}

async function handleEdit(input: { path: string; edits: Array<{ oldText: string; newText: string }> }, ctx: ExtensionContext) {
    if (matchesAnyPath(resolveForPolicy(input.path, ctx.cwd), [...effective.paths.denyWrite, ...effective.paths.sensitive], ctx.cwd)) {
        return { block: true, reason: `Edit blocked by permissions policy: ${input.path}` };
    }
    if (currentMode() === "auto") return;
    if (!ctx.hasUI) return { block: true, reason: `Edit requires editor review: ${input.path}` };

    for (let i = 0; i < input.edits.length; i++) {
		const edit = input.edits[i]!;
		const buffer = [
			`# Review edit ${i + 1}/${input.edits.length}: ${input.path}`,
			"# Lines starting with # are ignored.",
			"# Original block:",
			...edit.oldText.split("\n").map((line) => `# | ${line}`),
			"# Replacement block starts below. Edit it, then accept/save.",
			"--- replacement ---",
			edit.newText,
		].join("\n");
		const reviewed = await withReviewEditor(ctx, input.path, "edit", () => ctx.ui.editor(`Review edit: ${input.path}`, buffer));
		if (reviewed === undefined) return { block: true, reason: `Edit review cancelled: ${input.path}` };
		edit.newText = extractReplacement(reviewed);
	}
}

async function handleUnknownTool(toolName: string, ctx: ExtensionContext) {
    if (effective.tools.allow.includes(toolName) || sessionPolicy.tools.has(toolName)) return;
    if (currentMode() === "auto") return;
    if (!ctx.hasUI) return { block: true, reason: `Tool requires approval: ${toolName}` };
	const choice = await ctx.ui.select(`Approve tool call: ${toolName}`, [
		"Deny",
		"Allow once",
		"Allow this tool for this session",
		"Allow this tool by name for this project",
		"Allow this tool by name globally",
	]);
	if (!choice || choice === "Deny") return { block: true, reason: `Denied tool: ${toolName}` };
	if (choice === "Allow this tool for this session") sessionPolicy.tools.add(toolName);
	else if (choice === "Allow this tool by name for this project") {
		sessionPolicy.tools.add(toolName);
		addProjectRule(ctx.cwd, (cfg) => addUnique(cfg.tools!, "allow", toolName));
	} else if (choice === "Allow this tool by name globally") {
		sessionPolicy.tools.add(toolName);
		addGlobalRule((cfg) => addUnique(cfg.tools!, "allow", toolName));
	}
}

async function withReviewEditor<T>(
	ctx: ExtensionContext,
	filePath: string,
	highlightMode: ReviewHighlightMode,
	fn: () => Promise<T>,
): Promise<T> {
	// `ctx.ui.editor` may or may not use the app editor factory depending on pi version.
	// This enables syntax highlighting and optional vim mode where supported and leaves
	// default behavior otherwise.
	const language = getLanguageFromPath(filePath);
	if (!language && !effective.reviewEditor.vimMode) return fn();
	const previous = ctx.ui.getEditorComponent?.();
	ctx.ui.setEditorComponent?.((tui, theme, kb) =>
		language
			? new SyntaxReviewEditor(tui, theme, kb, ctx.ui.theme, language, highlightMode, effective.reviewEditor.vimMode)
			: new VimEditor(tui, theme, kb),
	);
	try {
		return await fn();
	} finally {
		ctx.ui.setEditorComponent?.(previous);
	}
}

function reloadPolicy(cwd: string) {
	globalConfig = readConfig(GLOBAL_CONFIG);
	projectConfig = readConfig(path.join(cwd, PROJECT_CONFIG));
	effective = mergeConfigs(DEFAULT_CONFIG, globalConfig, projectConfig);
}

function readConfig(file: string): PermissionConfig {
	try {
		if (!fs.existsSync(file)) return {};
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

function ensureConfigFile(file: string) {
	if (fs.existsSync(file)) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
}

function mergeConfigs(...configs: PermissionConfig[]): EffectivePolicy {
    const merged: EffectivePolicy = {
        version: 1,
        mode: "ask",
        bash: { allowExact: [], allowPrefixes: [], denyPatterns: [] },
		tools: { allow: [] },
		paths: { denyRead: [], denyWrite: [], sensitive: [] },
		reviewEditor: { vimMode: false },
		mainEditor: { vimMode: false },
	};
    for (const cfg of configs) {
        merged.version = cfg.version ?? merged.version;
        merged.mode = cfg.mode ?? merged.mode;
        pushAll(merged.bash.allowExact, cfg.bash?.allowExact);
		pushAll(merged.bash.allowPrefixes, cfg.bash?.allowPrefixes);
		pushAll(merged.bash.denyPatterns, cfg.bash?.denyPatterns);
		pushAll(merged.tools.allow, cfg.tools?.allow);
		pushAll(merged.paths.denyRead, cfg.paths?.denyRead);
		pushAll(merged.paths.denyWrite, cfg.paths?.denyWrite);
		pushAll(merged.paths.sensitive, cfg.paths?.sensitive);
		merged.reviewEditor.vimMode = cfg.reviewEditor?.vimMode ?? merged.reviewEditor.vimMode;
		merged.mainEditor.vimMode = cfg.mainEditor?.vimMode ?? merged.mainEditor.vimMode;
	}
	return merged;
}

function isBashAllowed(command: string): boolean {
    if (sessionPolicy.bashExact.has(command)) return true;
    if ([...sessionPolicy.bashPrefixes].some((prefix) => command.startsWith(prefix))) return true;
    if (isBashDenied(command)) return false;
    if (effective.bash.allowExact.includes(command)) return true;
    return effective.bash.allowPrefixes.some((prefix) => command.startsWith(prefix));
}

const READ_ONLY_SIMPLE_COMMANDS = new Set([
    "[",
    "basename",
    "cat",
    "cd",
    "cut",
    "date",
    "df",
    "dir",
    "dirname",
    "du",
    "echo",
    "expr",
    "false",
    "file",
    "grep",
    "head",
    "hostname",
    "id",
    "jq",
    "less",
    "ls",
    "more",
    "printenv",
    "printf",
    "pwd",
    "readlink",
    "realpath",
    "rg",
    "stat",
    "tail",
    "test",
    "tr",
    "true",
    "uname",
    "uniq",
    "wc",
    "where",
    "whereis",
    "which",
    "whoami",
]);

function isReadOnlyBashCommand(command: string): boolean {
    if (!command.trim()) return true;
    if (/[`]/.test(command) || command.includes("$(") || command.includes("<(") || command.includes(">(")) return false;

    const tokens = tokenizeShell(command);
    if (!tokens) return false;

    const segments: string[][] = [];
    let current: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (isOutputRedirection(token)) return false;
        if (token === "<" || token === "<<") {
            i++;
            continue;
        }
        if (isCommandSeparator(token)) {
            if (current.length === 0) return false;
            segments.push(current);
            current = [];
            continue;
        }
        if (token === "&") return false;
        current.push(token);
    }
    if (current.length) segments.push(current);
    return segments.length > 0 && segments.every(isReadOnlyCommandSegment);
}

function tokenizeShell(command: string): string[] | undefined {
    const tokens: string[] = [];
    let token = "";
    let quote: "'" | '"' | undefined;

    const pushToken = () => {
        if (token) {
            tokens.push(token);
            token = "";
        }
    };

    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!;
        if (quote) {
            if (ch === quote) quote = undefined;
            else if (quote === '"' && ch === "\\" && i + 1 < command.length) token += command[++i]!;
            else token += ch;
            continue;
        }

        if (ch === "'" || ch === '"') {
            quote = ch;
            continue;
        }
        if (ch === "\\") {
            if (i + 1 >= command.length) return undefined;
            token += command[++i]!;
            continue;
        }
        if (/\s/.test(ch)) {
            pushToken();
            continue;
        }
        if (";|&<>".includes(ch)) {
            pushToken();
            const next = command[i + 1];
            if ((ch === "&" && next === "&") || (ch === "|" && next === "|") || (ch === ">" && next === ">") || (ch === "<" && next === "<")) {
                tokens.push(`${ch}${next}`);
                i++;
            } else {
                tokens.push(ch);
            }
            continue;
        }
        token += ch;
    }

    if (quote) return undefined;
    pushToken();
    return tokens;
}

function isCommandSeparator(token: string): boolean {
    return token === "|" || token === "&&" || token === "||" || token === ";";
}

function isOutputRedirection(token: string): boolean {
    return token === ">" || token === ">>";
}

function isReadOnlyCommandSegment(tokens: string[]): boolean {
    let index = 0;
    while (isEnvAssignment(tokens[index])) index++;
    if (index >= tokens.length) return true;

    if (tokens[index] === "time") index++;
    if (tokens[index] === "command" || tokens[index] === "builtin") {
        if (tokens[index + 1] === "-v" || tokens[index + 1] === "-V") return true;
        index++;
    }

    const commandName = tokens[index]!;
    const args = tokens.slice(index + 1);

    if (commandName === "env") return isReadOnlyEnvCommand(args);
    if (commandName === "find") return isReadOnlyFindCommand(args);
    if (commandName === "git") return isReadOnlyGitCommand(args);
    if (commandName === "node" || commandName === "python" || commandName === "python3") return args.length > 0 && args.every(isVersionOrHelpFlag);
    if (commandName === "npm") return isReadOnlyNpmCommand(args);
    if (commandName === "sort") return !hasOption(args, "-o", "--output");
    if (commandName === "yq") return !hasOption(args, "-i", "--inplace");

    return READ_ONLY_SIMPLE_COMMANDS.has(commandName);
}

function isReadOnlyEnvCommand(args: string[]): boolean {
    let index = 0;
    while (index < args.length) {
        const arg = args[index]!;
        if (isEnvAssignment(arg) || arg === "-i" || arg === "--ignore-environment") {
            index++;
            continue;
        }
        if (arg === "-u" || arg === "--unset" || arg === "-C" || arg === "--chdir") {
            index += 2;
            continue;
        }
        if (arg.startsWith("--unset=") || arg.startsWith("--chdir=")) {
            index++;
            continue;
        }
        break;
    }
    return index >= args.length || isReadOnlyCommandSegment(args.slice(index));
}

function isReadOnlyFindCommand(args: string[]): boolean {
    return !args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf"].includes(arg));
}

function isReadOnlyGitCommand(args: string[]): boolean {
    const parsed = parseGitSubcommand(args);
    if (!parsed) return args.length === 0 || args.some((arg) => arg === "--version" || arg === "--help");
    const { subcommand, subArgs } = parsed;
    if (hasOption(subArgs, "-o", "--output")) return false;

    if (["blame", "describe", "diff", "grep", "log", "ls-files", "ls-tree", "rev-list", "rev-parse", "shortlog", "show", "status", "version"].includes(subcommand)) return true;
    if (subcommand === "branch") return isReadOnlyGitBranchCommand(subArgs);
    if (subcommand === "remote") return subArgs.length === 0 || subArgs[0] === "-v" || ["get-url", "show"].includes(subArgs[0]!);
    if (subcommand === "config") return isReadOnlyGitConfigCommand(subArgs);
    if (subcommand === "stash") return subArgs[0] === "list" || subArgs[0] === "show";
    return false;
}

function parseGitSubcommand(args: string[]): { subcommand: string; subArgs: string[] } | undefined {
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(arg)) {
            i++;
            continue;
        }
        if (arg.startsWith("-C") || arg.startsWith("-c") || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=") || arg.startsWith("--namespace=")) continue;
        if (arg === "--no-pager" || arg === "--paginate" || arg === "--version" || arg === "--help") continue;
        if (arg.startsWith("-")) return undefined;
        return { subcommand: arg, subArgs: args.slice(i + 1) };
    }
    return undefined;
}

function isReadOnlyGitBranchCommand(args: string[]): boolean {
    return args.every((arg) => ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "--list", "--no-color"].includes(arg) || arg.startsWith("--format=") || arg.startsWith("--sort=") || arg.startsWith("--color="));
}

function isReadOnlyGitConfigCommand(args: string[]): boolean {
    if (args.some((arg) => ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section", "add", "set", "unset", "rename-section", "remove-section"].includes(arg))) return false;
    return args.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "--name-only", "get", "list"].includes(arg));
}

function isReadOnlyNpmCommand(args: string[]): boolean {
    const command = args.find((arg) => !arg.startsWith("-"));
    return !!command && ["info", "list", "ls", "outdated", "root", "view", "why"].includes(command);
}

function isVersionOrHelpFlag(arg: string): boolean {
    return arg === "-v" || arg === "--version" || arg === "-h" || arg === "--help";
}

function hasOption(args: string[], short: string, long: string): boolean {
    return args.some((arg) => arg === short || arg.startsWith(`${short}`) || arg === long || arg.startsWith(`${long}=`));
}

function isEnvAssignment(token: string | undefined): boolean {
    return !!token && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function isBashDenied(command: string): boolean {
    return effective.bash.denyPatterns.some((pattern) => new RegExp(pattern).test(command));
}

function currentMode(): PermissionMode {
    return sessionModeOverride ?? effective.mode;
}

function parseModeArg(args: string | undefined): PermissionMode | undefined {
    const raw = (args || "").trim().toLowerCase();
    if (["auto", "on", "enable", "enabled"].includes(raw)) return "auto";
    if (["ask", "manual", "off", "disable", "disabled"].includes(raw)) return "ask";
    return undefined;
}

function formatModeChange(mode: PermissionMode): string {
    return mode === "auto"
        ? "Permissions auto mode enabled: non-sensitive writes/edits, non-dangerous bash (including read-only), and custom tools are auto-approved; dangerous bash still prompts/blocks."
        : "Permissions ask mode enabled: read-only bash is auto-approved; mutating or unknown bash/custom tools prompt unless allowlisted, and writes/edits require review.";
}

function updateStatus(ctx: { ui: ExtensionContext["ui"] }) {
    ctx.ui.setStatus("permissions", `permissions: ${currentMode()}`);
}

function classifyDangerousCommand(command: string): { block?: boolean; confirm?: boolean; reason?: string } {
    const c = command.replace(/\s+/g, " ").trim();
    if (/\brm\s+-(?=[A-Za-z]*r)(?=[A-Za-z]*f)[A-Za-z]*\s+(\/|~|\*|\.\s*$|\.\/\*)/.test(c)) {
        return { block: true, reason: "Catastrophic recursive delete blocked" };
    }
    if (/\brm\s+(?=[^;&|]*\s)(?=[^;&|]*-[A-Za-z]*[rR])/.test(c)) return { confirm: true, reason: "Recursive delete" };
    if (/\b(curl|wget)\b.*\|\s*(sh|bash|zsh)\b/.test(c)) return { confirm: true, reason: "Network pipe-to-shell" };
    if (/^\s*(sudo|su)\b/.test(c)) return { confirm: true, reason: "Privilege escalation" };
    if (/\bgit\s+clean\b.*-[^\s]*f/.test(c)) return { confirm: true, reason: "Destructive git clean" };
    if (/\bgit\s+reset\s+(--hard|--merge|--keep)\b/.test(c)) return { confirm: true, reason: "Destructive git reset" };
    if (/\bgit\s+(checkout|restore)\s+(--|\.|:\/)/.test(c)) return { confirm: true, reason: "Discarding git changes" };
    if (/\b(chmod|chown)\s+-[A-Za-z]*R[A-Za-z]*\b/.test(c)) return { confirm: true, reason: "Recursive permission/ownership change" };
    if (/\b(dd|mkfs(?:\.\w+)?|fdisk|diskpart)\b/.test(c)) return { confirm: true, reason: "Disk operation" };
    return {};
}

function addProjectRule(cwd: string, mutate: (cfg: PermissionConfig) => void) {
	const file = path.join(cwd, PROJECT_CONFIG);
	const cfg = mergeConfigForWrite(readConfig(file));
	mutate(cfg);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
	reloadPolicy(cwd);
}

function addGlobalRule(mutate: (cfg: PermissionConfig) => void) {
	const cfg = mergeConfigForWrite(readConfig(GLOBAL_CONFIG));
	mutate(cfg);
	fs.mkdirSync(path.dirname(GLOBAL_CONFIG), { recursive: true });
	fs.writeFileSync(GLOBAL_CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

function mergeConfigForWrite(cfg: PermissionConfig): PermissionConfig {
    return {
        version: cfg.version ?? 1,
        mode: cfg.mode ?? "ask",
        bash: {
			allowExact: cfg.bash?.allowExact ?? [],
			allowPrefixes: cfg.bash?.allowPrefixes ?? [],
			denyPatterns: cfg.bash?.denyPatterns ?? [],
		},
		tools: { allow: cfg.tools?.allow ?? [] },
		paths: {
			denyRead: cfg.paths?.denyRead ?? [],
			denyWrite: cfg.paths?.denyWrite ?? [],
			sensitive: cfg.paths?.sensitive ?? [],
		},
		reviewEditor: { vimMode: cfg.reviewEditor?.vimMode ?? false },
		mainEditor: { vimMode: cfg.mainEditor?.vimMode ?? false },
	};
}

function addUnique<T extends Record<string, string[]>, K extends keyof T>(obj: T, key: K, value: string) {
	obj[key] ??= [] as T[K];
	if (!obj[key].includes(value)) obj[key].push(value);
}

function pushAll(target: string[], source?: string[]) {
	for (const item of source ?? []) if (!target.includes(item)) target.push(item);
}

function resolveForPolicy(filePath: string, cwd: string): string {
	return path.resolve(cwd, filePath);
}

function matchesAnyPath(absPath: string, patterns: string[], cwd: string): boolean {
	const rel = path.relative(cwd, absPath).replace(/\\/g, "/");
	const full = absPath.replace(/\\/g, "/");
	return patterns.some((pattern) => globMatch(rel, pattern) || globMatch(full, pattern));
}

function globMatch(value: string, glob: string): boolean {
	const escaped = glob
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "@@DOUBLE_STAR@@")
		.replace(/\*/g, "[^/]*")
		.replace(/@@DOUBLE_STAR@@/g, ".*");
	return new RegExp(`^${escaped}$`).test(value);
}

function extractReplacement(buffer: string): string {
	const marker = "--- replacement ---";
	const idx = buffer.indexOf(marker);
	if (idx < 0) return buffer.split("\n").filter((line) => !line.startsWith("#")).join("\n");
	return buffer.slice(idx + marker.length).replace(/^\r?\n/, "");
}

function suggestPrefix(command: string): string {
	const parts = command.trim().split(/\s+/);
	if (parts[0] === "git" && parts[1]) return `git ${parts[1]}`;
	if (parts[0] === "npm" && parts[1]) return `npm ${parts[1]}`;
	return parts[0] ? `${parts[0]} ` : command;
}

function formatSummary(cwd: string): string {
    return [
        "Permissions policy",
        `Global: ${GLOBAL_CONFIG}`,
        `Project: ${path.join(cwd, PROJECT_CONFIG)}`,
        `Mode: ${currentMode()}${sessionModeOverride ? " (session override)" : ""}`,
        `Bash exact: ${effective.bash.allowExact.length} global/project, ${sessionPolicy.bashExact.size} session`,
		`Bash prefixes: ${effective.bash.allowPrefixes.length} global/project, ${sessionPolicy.bashPrefixes.size} session`,
		`Allowed custom tools: ${effective.tools.allow.length} global/project, ${sessionPolicy.tools.size} session`,
		`Sensitive path patterns: ${effective.paths.sensitive.length}`,
		`Review editor vim: ${effective.reviewEditor.vimMode ? "on" : "off"}`,
		`Main editor vim: ${effective.mainEditor.vimMode ? "on" : "off"}`,
	].join("\n");
}
