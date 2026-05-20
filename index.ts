import {
	CustomEditor,
	getLanguageFromPath,
	highlightCode,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_CONFIG = path.join(os.homedir(), ".pi", "agent", "permissions.json");
const PROJECT_CONFIG = ".pi/permissions.json";

const DIFF_CONTEXT_LINES = 4;
const DIFF_PREVIEW_MAX_BODY_LINES = 18;
const DIFF_PREVIEW_MAX_TOTAL_LINES = 26;
const DIFF_PREVIEW_MIN_TOTAL_LINES = 8;
const DIFF_PREVIEW_TERMINAL_MARGIN_LINES = 6;
const DIFF_PREVIEW_MIN_BODY_LINES = 1;
const DIFF_CELL_THRESHOLD = 4_000_000;

type PermissionMode = "ask" | "auto";
type DiffTool = "write" | "edit";
type DiffLineKind = "added" | "removed" | "context" | "skip";
type PermissionTheme = ExtensionContext["ui"]["theme"];
type ApprovalChoice = "allow" | "changes" | "deny";
type DiffApprovalResult = { approved: true } | { approved: false; feedback?: string };

type PermissionConfig = {
	version?: number;
	mode?: PermissionMode;
	mainEditor?: {
		vimMode?: boolean;
	};
};

type EffectiveSettings = {
	version: number;
	mode: PermissionMode;
	mainEditor: {
		vimMode: boolean;
	};
};

type TextEdit = { oldText: string; newText: string };

type DiffLine = {
	kind: DiffLineKind;
	content: string;
	oldLine?: number;
	newLine?: number;
	oldIndex?: number;
	newIndex?: number;
};

type DiffPreview = {
	tool: DiffTool;
	path: string;
	language?: string;
	oldLines: string[];
	newLines: string[];
	lines: DiffLine[];
	lineNumWidth: number;
	added: number;
	removed: number;
	noChanges: boolean;
	exact: boolean;
};

type DangerousCommandClassification = {
	block?: boolean;
	confirm?: boolean;
	reason?: string;
};

const DEFAULT_CONFIG: EffectiveSettings = {
	version: 2,
	mode: "auto",
	mainEditor: { vimMode: false },
};

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

let effective: EffectiveSettings = mergeConfigs(DEFAULT_CONFIG);
let sessionModeOverride: PermissionMode | undefined;

class VimEditor extends CustomEditor {
	private mode: "normal" | "insert" = "insert";

	constructor(
		tui: ConstructorParameters<typeof CustomEditor>[0],
		editorTheme: ConstructorParameters<typeof CustomEditor>[1],
		keybindings: ConstructorParameters<typeof CustomEditor>[2],
	) {
		super(tui, editorTheme, keybindings);
	}

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

class DiffApprovalComponent {
	private selected: ApprovalChoice = "allow";
	private scrollOffset = 0;
	private pageSize = DIFF_PREVIEW_MAX_BODY_LINES;
	private highlightedOld: string[] | undefined;
	private highlightedNew: string[] | undefined;

	constructor(
		private readonly preview: DiffPreview,
		private readonly theme: PermissionTheme,
		private readonly done: (choice: ApprovalChoice) => void,
		private readonly getTerminalRows: () => number,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done("deny");
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.done(this.selected);
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.space)) {
			this.selected = this.nextChoice(this.selected);
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.selected = this.previousChoice(this.selected);
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.selected = this.nextChoice(this.selected);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
			this.scrollOffset += 1;
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset += this.pageSize;
			return;
		}
		if (matchesKey(data, "y") || matchesKey(data, "a")) this.done("allow");
		else if (matchesKey(data, "n") || matchesKey(data, "d")) this.done("deny");
		else if (matchesKey(data, "c") || matchesKey(data, "r") || matchesKey(data, "e")) this.done("changes");
	}

	private previousChoice(choice: ApprovalChoice): ApprovalChoice {
		if (choice === "allow") return "deny";
		if (choice === "changes") return "allow";
		return "changes";
	}

	private nextChoice(choice: ApprovalChoice): ApprovalChoice {
		if (choice === "allow") return "changes";
		if (choice === "changes") return "deny";
		return "allow";
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const body = this.renderBody(safeWidth);
		const headerLines = this.renderHeader(safeWidth).map((line) => truncateToWidth(line, safeWidth));
		const buttonLines = [this.renderButtons(safeWidth)];
		const helpLines = [truncateToWidth(this.theme.fg("dim", "↑/↓ scroll • ←/→ choose • c request changes • enter confirm • esc deny"), safeWidth)];
		const maxTotalLines = this.getMaxTotalLines();
		const baseChromeLines = headerLines.length + 1 + 1 + buttonLines.length + helpLines.length;
		let visibleBodyLineCount = Math.max(
			DIFF_PREVIEW_MIN_BODY_LINES,
			Math.min(DIFF_PREVIEW_MAX_BODY_LINES, maxTotalLines - baseChromeLines),
		);
		let needsScroll = body.length > visibleBodyLineCount;
		visibleBodyLineCount = Math.max(
			DIFF_PREVIEW_MIN_BODY_LINES,
			Math.min(DIFF_PREVIEW_MAX_BODY_LINES, maxTotalLines - baseChromeLines - (needsScroll ? 1 : 0)),
		);
		needsScroll = body.length > visibleBodyLineCount;
		this.pageSize = visibleBodyLineCount;
		const maxScroll = Math.max(0, body.length - visibleBodyLineCount);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + visibleBodyLineCount);
		const lines = [
			...headerLines,
			"",
			...visibleBody,
		];
		if (needsScroll) {
			lines.push(
				truncateToWidth(
					this.theme.fg(
						"dim",
						`${this.scrollOffset + 1}-${Math.min(this.scrollOffset + visibleBodyLineCount, body.length)} / ${body.length} diff lines`,
					),
					safeWidth,
				),
			);
		}
		lines.push("", ...buttonLines, ...helpLines);
		return lines.map((line) => (visibleWidth(line) > safeWidth ? truncateToWidth(line, safeWidth) : line));
	}

	private getMaxTotalLines(): number {
		const rows = Math.max(1, this.getTerminalRows());
		const available = rows - DIFF_PREVIEW_TERMINAL_MARGIN_LINES;
		if (available < DIFF_PREVIEW_MIN_TOTAL_LINES) return Math.max(1, available);
		return Math.min(DIFF_PREVIEW_MAX_TOTAL_LINES, available);
	}

	invalidate(): void {
		this.highlightedOld = undefined;
		this.highlightedNew = undefined;
	}

	private renderHeader(width: number): string[] {
		const tool = this.preview.tool === "write" ? "write" : "edit";
		const summary = this.preview.noChanges
			? this.theme.fg("muted", "No textual changes detected")
			: `${this.theme.fg("toolDiffAdded", `+${this.preview.added}`)} ${this.theme.fg("toolDiffRemoved", `-${this.preview.removed}`)}`;
		const precision = this.preview.exact ? "" : this.theme.fg("warning", " (large diff shown as full replacement)");
		return [
			this.theme.fg("accent", this.theme.bold(`Approve ${tool} diff`)),
			`${this.theme.fg("muted", "File:")} ${this.theme.fg("accent", this.preview.path)}`,
			truncateToWidth(`${this.theme.fg("muted", "Changes:")} ${summary}${precision}`, width),
			this.theme.fg("dim", "Ask mode uses this read-only diff gate for write/edit. The proposed output cannot be edited."),
		];
	}

	private renderBody(width: number): string[] {
		if (this.preview.noChanges) return [this.theme.fg("muted", "No diff hunks to display.")];
		const rendered: string[] = [];
		for (const line of this.preview.lines) {
			rendered.push(...wrapTextWithAnsi(this.renderDiffLine(line), width));
		}
		return rendered.length ? rendered : [this.theme.fg("muted", "No diff hunks to display.")];
	}

	private renderDiffLine(line: DiffLine): string {
		if (line.kind === "skip") {
			return this.theme.fg("toolDiffContext", ` ${"".padStart(this.preview.lineNumWidth)} ...`);
		}
		const sign = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
		const lineNumber = line.kind === "added" ? line.newLine : line.oldLine;
		const prefix = `${sign}${String(lineNumber ?? "").padStart(this.preview.lineNumWidth, " ")} `;
		const color = line.kind === "added" ? "toolDiffAdded" : line.kind === "removed" ? "toolDiffRemoved" : "toolDiffContext";
		const content = this.renderDiffContent(line);
		const styled = this.preview.language ? this.theme.fg(color, prefix) + content : this.theme.fg(color, prefix + content);
		return this.highlightDiffLineBackground(line.kind, styled);
	}

	private highlightDiffLineBackground(kind: DiffLineKind, text: string): string {
		if (kind === "added") return this.theme.bg("toolSuccessBg", text);
		if (kind === "removed") return this.theme.bg("toolErrorBg", text);
		return text;
	}

	private renderDiffContent(line: DiffLine): string {
		if (line.kind === "added" && line.newIndex !== undefined) {
			return this.getHighlightedNew()[line.newIndex] ?? replaceTabs(line.content);
		}
		if (line.kind === "removed" && line.oldIndex !== undefined) {
			return this.getHighlightedOld()[line.oldIndex] ?? replaceTabs(line.content);
		}
		if (line.kind === "context" && line.newIndex !== undefined) {
			return this.getHighlightedNew()[line.newIndex] ?? replaceTabs(line.content);
		}
		return replaceTabs(line.content);
	}

	private getHighlightedOld(): string[] {
		this.highlightedOld ??= highlightDiffSourceLines(this.preview.oldLines, this.preview.language);
		return this.highlightedOld;
	}

	private getHighlightedNew(): string[] {
		this.highlightedNew ??= highlightDiffSourceLines(this.preview.newLines, this.preview.language);
		return this.highlightedNew;
	}

	private renderButtons(width: number): string {
		const allow = this.renderButton("allow", "Allow");
		const changes = this.renderButton("changes", "Request changes");
		const deny = this.renderButton("deny", "Deny");
		return truncateToWidth(`${allow} ${changes} ${deny}`, width);
	}

	private renderButton(choice: ApprovalChoice, label: string): string {
		const base = ` ${label} `;
		const colored = this.colorChoice(choice, this.selected === choice ? this.theme.bold(base) : base);
		return this.selected === choice ? this.theme.bg("selectedBg", colored) : colored;
	}

	private colorChoice(choice: ApprovalChoice, text: string): string {
		if (choice === "allow") return this.theme.fg("success", text);
		if (choice === "changes") return this.theme.fg("warning", text);
		return this.theme.fg("error", text);
	}
}

export default function permissionsExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		reloadSettings(ctx.cwd);
		if (effective.mainEditor.vimMode) {
			ctx.ui.setEditorComponent((tui, theme, kb) => new VimEditor(tui, theme, kb));
		}
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			return handleBash(event.input, ctx);
		}

		if (isToolCallEventType("write", event)) {
			return handleWrite(event.input, ctx);
		}

		if (isToolCallEventType("edit", event)) {
			return handleEdit(event.input, ctx);
		}

		// Reads and all other tools are intentionally allowed. This extension now only
		// gates dangerous bash and ask-mode write/edit diffs.
	});

	pi.registerCommand("permissions", {
		description: "Show simplified permission mode summary",
		handler: async (_args, ctx) => {
			reloadSettings(ctx.cwd);
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
			ctx.ui.notify(formatModeChange(requested), "info");
		},
	});

	pi.registerCommand("permissions-auto", {
		description: "Toggle full auto approval: /permissions-auto [on|off|toggle]",
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
			ctx.ui.notify(formatModeChange(nextMode), "info");
		},
	});

	pi.registerCommand("permissions-reload", {
		description: "Reload lightweight permission preferences",
		handler: async (_args, ctx) => {
			reloadSettings(ctx.cwd);
			updateStatus(ctx);
			ctx.ui.notify("Permissions preferences reloaded", "info");
		},
	});

	pi.registerCommand("permissions-edit", {
		description: "Edit lightweight permissions preferences: /permissions-edit global|project",
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
			const edited = await ctx.ui.editor(`Edit ${scope} permissions preferences: ${file}`, current);
			if (edited === undefined) return;
			try {
				const parsed = JSON.parse(edited) as PermissionConfig;
				assertValidPreferences(parsed);
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, edited.endsWith("\n") ? edited : `${edited}\n`, "utf8");
				reloadSettings(ctx.cwd);
				updateStatus(ctx);
				ctx.ui.notify(`Saved ${scope} permissions preferences`, "info");
			} catch (error) {
				ctx.ui.notify(`Invalid permissions preferences; not saved: ${formatError(error)}`, "error");
			}
		},
	});
}

async function handleBash(input: { command: string; timeout?: number }, ctx: ExtensionContext) {
	const command = input.command.trim();
	const danger = classifyDangerousCommand(command);
	if (danger.block) return { block: true, reason: danger.reason };
	if (!danger.confirm) return;

	if (!ctx.hasUI) {
		return { block: true, reason: `Dangerous bash command requires approval: ${command}` };
	}

	const approved = await requestDangerousCommandApproval(ctx, command, danger.reason);
	if (!approved) return { block: true, reason: `Denied dangerous bash command: ${command}` };
}

async function handleWrite(input: { path: string; content: string }, ctx: ExtensionContext) {
	if (currentMode() === "auto") return;
	if (!ctx.hasUI) return { block: true, reason: `Write requires ask-mode diff approval: ${input.path}` };

	let preview: DiffPreview;
	try {
		preview = buildWriteDiffPreview(input, ctx.cwd);
	} catch (error) {
		return { block: true, reason: `Could not prepare write diff for approval: ${formatError(error)}` };
	}

	const result = await requestDiffApproval(ctx, preview);
	if (!result.approved) return { block: true, reason: `Denied write after diff review: ${input.path}${formatChangeRequest(result.feedback)}` };
}

async function handleEdit(input: { path: string; edits: Array<{ oldText: string; newText: string }> }, ctx: ExtensionContext) {
	if (currentMode() === "auto") return;
	if (!ctx.hasUI) return { block: true, reason: `Edit requires ask-mode diff approval: ${input.path}` };

	let preview: DiffPreview;
	try {
		preview = buildEditDiffPreview(input, ctx.cwd);
	} catch (error) {
		return { block: true, reason: `Could not prepare edit diff for approval: ${formatError(error)}` };
	}

	const result = await requestDiffApproval(ctx, preview);
	if (!result.approved) return { block: true, reason: `Denied edit after diff review: ${input.path}${formatChangeRequest(result.feedback)}` };
}

async function requestDangerousCommandApproval(ctx: ExtensionContext, command: string, reason: string | undefined): Promise<boolean> {
	const reasonLine = reason ? `\n\nReason: ${reason}` : "";
	const choice = await ctx.ui.select(`Dangerous bash command flagged:\n\n${command}${reasonLine}\n\nRun it anyway?`, ["Deny", "Allow"]);
	return choice === "Allow";
}

async function requestDiffApproval(ctx: ExtensionContext, preview: DiffPreview): Promise<DiffApprovalResult> {
	const choice = await ctx.ui.custom<ApprovalChoice>((tui, theme, _keybindings, done) => {
		const component = new DiffApprovalComponent(preview, theme, done, () => tui.terminal.rows);
		return {
			render: (width: number) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput: (data: string) => {
				component.handleInput(data);
				tui.requestRender();
			},
		};
	});

	if (choice === "allow") return { approved: true };
	if (choice === "changes") {
		const feedback = await ctx.ui.editor(`What should change in ${preview.path}?`, "");
		const normalized = normalizeFeedback(feedback ?? "");
		return normalized ? { approved: false, feedback: normalized } : { approved: false };
	}
	return { approved: false };
}

function buildWriteDiffPreview(input: { path: string; content: string }, cwd: string): DiffPreview {
	const absolutePath = resolveForPolicy(input.path, cwd);
	const previousContent = readTextFileIfExists(absolutePath);
	return buildDiffPreview("write", input.path, previousContent, input.content);
}

function buildEditDiffPreview(input: { path: string; edits: TextEdit[] }, cwd: string): DiffPreview {
	const absolutePath = resolveForPolicy(input.path, cwd);
	const rawContent = fs.readFileSync(absolutePath, "utf8");
	const { text: content } = stripBom(rawContent);
	const normalizedContent = normalizeToLF(content);
	const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, input.edits, input.path);
	return buildDiffPreview("edit", input.path, baseContent, newContent);
}

function buildDiffPreview(tool: DiffTool, filePath: string, oldContent: string, newContent: string): DiffPreview {
	const oldNormalized = normalizeToLF(oldContent);
	const newNormalized = normalizeToLF(newContent);
	const oldLines = splitLinesForDiff(oldNormalized);
	const newLines = splitLinesForDiff(newNormalized);
	const noChanges = oldNormalized === newNormalized;
	const { lines, exact } = noChanges
		? { lines: [] as DiffLine[], exact: true }
		: buildStructuredDiff(oldLines, newLines, DIFF_CONTEXT_LINES);
	const maxLineNum = Math.max(oldLines.length, newLines.length, 1);
	return {
		tool,
		path: filePath,
		language: getLanguageFromPath(filePath),
		oldLines,
		newLines,
		lines,
		lineNumWidth: String(maxLineNum).length,
		added: lines.filter((line) => line.kind === "added").length,
		removed: lines.filter((line) => line.kind === "removed").length,
		noChanges,
		exact,
	};
}

function readTextFileIfExists(absolutePath: string): string {
	try {
		return fs.readFileSync(absolutePath, "utf8");
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return "";
		throw error;
	}
}

function splitLinesForDiff(content: string): string[] {
	const lines = content.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines;
}

type RawDiffOp = {
	type: "equal" | "added" | "removed";
	content: string;
	oldIndex?: number;
	newIndex?: number;
};

type DiffSegment = {
	type: RawDiffOp["type"];
	lines: RawDiffOp[];
};

function buildStructuredDiff(oldLines: string[], newLines: string[], contextLines: number): { lines: DiffLine[]; exact: boolean } {
	const rawOps = oldLines.length * newLines.length > DIFF_CELL_THRESHOLD
		? buildFullReplacementOps(oldLines, newLines)
		: buildLcsDiffOps(oldLines, newLines);
	const segments = groupDiffOps(rawOps);
	const result: DiffLine[] = [];
	let oldLineNum = 1;
	let newLineNum = 1;

	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const segment = segments[segmentIndex]!;
		if (segment.type === "removed") {
			for (const op of segment.lines) {
				result.push({ kind: "removed", content: op.content, oldLine: oldLineNum, oldIndex: op.oldIndex });
				oldLineNum++;
			}
			continue;
		}
		if (segment.type === "added") {
			for (const op of segment.lines) {
				result.push({ kind: "added", content: op.content, newLine: newLineNum, newIndex: op.newIndex });
				newLineNum++;
			}
			continue;
		}

		const hasLeadingChange = segmentIndex > 0 && segments[segmentIndex - 1]!.type !== "equal";
		const hasTrailingChange = segmentIndex < segments.length - 1 && segments[segmentIndex + 1]!.type !== "equal";
		const segmentOldStart = oldLineNum;
		const segmentNewStart = newLineNum;
		const length = segment.lines.length;
		const addContextRange = (start: number, end: number) => {
			for (let offset = start; offset < end; offset++) {
				const op = segment.lines[offset]!;
				result.push({
					kind: "context",
					content: op.content,
					oldLine: segmentOldStart + offset,
					newLine: segmentNewStart + offset,
					oldIndex: op.oldIndex,
					newIndex: op.newIndex,
				});
			}
		};
		const addSkip = () => result.push({ kind: "skip", content: "..." });

		if (hasLeadingChange && hasTrailingChange) {
			if (length <= contextLines * 2) {
				addContextRange(0, length);
			} else {
				addContextRange(0, contextLines);
				addSkip();
				addContextRange(length - contextLines, length);
			}
		} else if (hasLeadingChange) {
			addContextRange(0, Math.min(contextLines, length));
			if (length > contextLines) addSkip();
		} else if (hasTrailingChange) {
			if (length > contextLines) addSkip();
			addContextRange(Math.max(0, length - contextLines), length);
		}

		oldLineNum += length;
		newLineNum += length;
	}

	return { lines: result, exact: rawOps.length === 0 || oldLines.length * newLines.length <= DIFF_CELL_THRESHOLD };
}

function buildLcsDiffOps(oldLines: string[], newLines: string[]): RawDiffOp[] {
	const dp = Array.from({ length: oldLines.length + 1 }, () => new Uint32Array(newLines.length + 1));
	for (let i = oldLines.length - 1; i >= 0; i--) {
		for (let j = newLines.length - 1; j >= 0; j--) {
			dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
		}
	}

	const ops: RawDiffOp[] = [];
	let i = 0;
	let j = 0;
	while (i < oldLines.length || j < newLines.length) {
		if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
			ops.push({ type: "equal", content: oldLines[i]!, oldIndex: i, newIndex: j });
			i++;
			j++;
		} else if (j < newLines.length && (i >= oldLines.length || dp[i]![j + 1]! > dp[i + 1]![j]!)) {
			ops.push({ type: "added", content: newLines[j]!, newIndex: j });
			j++;
		} else if (i < oldLines.length) {
			ops.push({ type: "removed", content: oldLines[i]!, oldIndex: i });
			i++;
		}
	}
	return ops;
}

function buildFullReplacementOps(oldLines: string[], newLines: string[]): RawDiffOp[] {
	return [
		...oldLines.map((content, oldIndex) => ({ type: "removed" as const, content, oldIndex })),
		...newLines.map((content, newIndex) => ({ type: "added" as const, content, newIndex })),
	];
}

function groupDiffOps(ops: RawDiffOp[]): DiffSegment[] {
	const segments: DiffSegment[] = [];
	for (const op of ops) {
		const last = segments[segments.length - 1];
		if (last && last.type === op.type) last.lines.push(op);
		else segments.push({ type: op.type, lines: [op] });
	}
	return segments;
}

function alignHighlightedLines(sourceLines: string[], highlightedLines: string[]): string[] {
	if (highlightedLines.length === sourceLines.length) return highlightedLines;
	return sourceLines.map((line, index) => highlightedLines[index] ?? line);
}

function highlightDiffSourceLines(sourceLines: string[], language: string | undefined): string[] {
	const displayLines = sourceLines.map(replaceTabs);
	if (!language || displayLines.length === 0) return displayLines;
	return alignHighlightedLines(displayLines, highlightCode(displayLines.join("\n"), language));
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeForFuzzyMatch(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
		.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
		.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

function fuzzyFindText(content: string, oldText: string): {
	found: boolean;
	index: number;
	matchLength: number;
	usedFuzzyMatch: boolean;
	contentForReplacement: string;
} {
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return { found: true, index: exactIndex, matchLength: oldText.length, usedFuzzyMatch: false, contentForReplacement: content };
	}

	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);
	if (fuzzyIndex === -1) {
		return { found: false, index: -1, matchLength: 0, usedFuzzyMatch: false, contentForReplacement: content };
	}

	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
}

function applyEditsToNormalizedContent(normalizedContent: string, edits: TextEdit[], filePath: string): { baseContent: string; newContent: string } {
	const normalizedEdits = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i]!.oldText.length === 0) throw new Error(formatEmptyOldTextError(filePath, i, normalizedEdits.length));
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch) ? normalizeForFuzzyMatch(normalizedContent) : normalizedContent;
	const matchedEdits: Array<{ editIndex: number; matchIndex: number; matchLength: number; newText: string }> = [];

	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i]!;
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) throw new Error(formatNotFoundError(filePath, i, normalizedEdits.length));
		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) throw new Error(formatDuplicateError(filePath, i, normalizedEdits.length, occurrences));
		matchedEdits.push({ editIndex: i, matchIndex: matchResult.index, matchLength: matchResult.matchLength, newText: edit.newText });
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1]!;
		const current = matchedEdits[i]!;
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${filePath}. Merge them into one edit or target disjoint regions.`);
		}
	}

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i]!;
		newContent = newContent.substring(0, edit.matchIndex) + edit.newText + newContent.substring(edit.matchIndex + edit.matchLength);
	}
	if (baseContent === newContent) throw new Error(formatNoChangeError(filePath, normalizedEdits.length));
	return { baseContent, newContent };
}

function formatNotFoundError(filePath: string, editIndex: number, totalEdits: number): string {
	return totalEdits === 1
		? `Could not find the exact text in ${filePath}. The old text must match exactly including all whitespace and newlines.`
		: `Could not find edits[${editIndex}] in ${filePath}. The oldText must match exactly including all whitespace and newlines.`;
}

function formatDuplicateError(filePath: string, editIndex: number, totalEdits: number, occurrences: number): string {
	return totalEdits === 1
		? `Found ${occurrences} occurrences of the text in ${filePath}. The text must be unique. Please provide more context to make it unique.`
		: `Found ${occurrences} occurrences of edits[${editIndex}] in ${filePath}. Each oldText must be unique. Please provide more context to make it unique.`;
}

function formatEmptyOldTextError(filePath: string, editIndex: number, totalEdits: number): string {
	return totalEdits === 1 ? `oldText must not be empty in ${filePath}.` : `edits[${editIndex}].oldText must not be empty in ${filePath}.`;
}

function formatNoChangeError(filePath: string, totalEdits: number): string {
	return totalEdits === 1
		? `No changes made to ${filePath}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
		: `No changes made to ${filePath}. The replacements produced identical content.`;
}

function classifyDangerousCommand(command: string): DangerousCommandClassification {
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

function reloadSettings(cwd: string) {
	effective = mergeConfigs(DEFAULT_CONFIG, readConfig(GLOBAL_CONFIG), readConfig(path.join(cwd, PROJECT_CONFIG)));
}

function readConfig(file: string): PermissionConfig {
	try {
		if (!fs.existsSync(file)) return {};
		return JSON.parse(fs.readFileSync(file, "utf8")) as PermissionConfig;
	} catch {
		return {};
	}
}

function ensureConfigFile(file: string) {
	if (fs.existsSync(file)) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, "utf8");
}

function mergeConfigs(...configs: PermissionConfig[]): EffectiveSettings {
	const merged: EffectiveSettings = {
		version: DEFAULT_CONFIG.version,
		mode: DEFAULT_CONFIG.mode,
		mainEditor: { vimMode: DEFAULT_CONFIG.mainEditor.vimMode },
	};
	for (const cfg of configs) {
		merged.version = cfg.version ?? merged.version;
		if (cfg.mode === "ask" || cfg.mode === "auto") merged.mode = cfg.mode;
		merged.mainEditor.vimMode = cfg.mainEditor?.vimMode ?? merged.mainEditor.vimMode;
	}
	return merged;
}

function assertValidPreferences(cfg: PermissionConfig) {
	if (cfg.mode !== undefined && cfg.mode !== "ask" && cfg.mode !== "auto") throw new Error('"mode" must be "ask" or "auto"');
	if (cfg.mainEditor?.vimMode !== undefined && typeof cfg.mainEditor.vimMode !== "boolean") throw new Error('"mainEditor.vimMode" must be a boolean');
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
		? "Permissions auto mode enabled: reads, writes/edits, non-dangerous bash, and custom tools are allowed automatically; dangerous bash still prompts or blocks."
		: "Permissions ask mode enabled: reads, non-dangerous bash, and custom tools are allowed automatically; writes/edits show a read-only diff approval; dangerous bash still prompts or blocks.";
}

function updateStatus(ctx: { ui: ExtensionContext["ui"] }) {
	ctx.ui.setStatus("permissions", `permissions: ${currentMode()}`);
}

function formatSummary(cwd: string): string {
	return [
		"Permissions guardrails",
		`Global preferences: ${GLOBAL_CONFIG}`,
		`Project preferences: ${path.join(cwd, PROJECT_CONFIG)}`,
		`Mode: ${currentMode()}${sessionModeOverride ? " (session override)" : ""}`,
		"Read/custom tools: allowed",
		"Write/edit: allowed in auto mode; read-only diff Allow/Deny in ask mode",
		"Bash: non-dangerous commands allowed; dangerous commands prompt or block in every mode",
		"Granular session/project/global allowlists, denylists, and path gates: disabled/ignored",
		`Main editor vim: ${effective.mainEditor.vimMode ? "on" : "off"}`,
	].join("\n");
}

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function normalizeFeedback(feedback: string): string {
	return feedback.trim().replace(/\s+/g, " ");
}

function formatChangeRequest(feedback: string | undefined): string {
	return feedback ? `; user requested changes: ${feedback}` : "";
}

function resolveForPolicy(filePath: string, cwd: string): string {
	return path.resolve(cwd, filePath);
}
