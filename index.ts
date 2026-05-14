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
	mainEditor?: {
		vimMode?: boolean;
	};
};

type EffectivePolicy = {
	version: number;
	mode: PermissionMode;
	bash: {
		allowExact: string[];
		allowPrefixes: string[];
		denyPatterns: string[];
	};
	tools: {
		allow: string[];
	};
	paths: {
		denyRead: string[];
		denyWrite: string[];
		sensitive: string[];
	};
	mainEditor: {
		vimMode: boolean;
	};
};

type SessionPolicy = {
	bashExact: Set<string>;
	bashPrefixes: Set<string>;
	tools: Set<string>;
};

const DEFAULT_CONFIG: PermissionConfig = {
    version: 1,
    mode: "auto",
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

const DIFF_CONTEXT_LINES = 4;
const DIFF_PREVIEW_VISIBLE_LINES = 18;
const DIFF_CELL_THRESHOLD = 4_000_000;

type DiffTool = "write" | "edit";
type DiffLineKind = "added" | "removed" | "context" | "skip";
type PermissionTheme = ExtensionContext["ui"]["theme"];
type ApprovalChoice = "allow" | "deny";

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
	private highlightedOld: string[] | undefined;
	private highlightedNew: string[] | undefined;

	constructor(
		private readonly preview: DiffPreview,
		private readonly theme: PermissionTheme,
		private readonly done: (approved: boolean) => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(false);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.done(this.selected === "allow");
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.space)) {
			this.selected = this.selected === "allow" ? "deny" : "allow";
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.selected = "allow";
			return;
		}
		if (matchesKey(data, Key.right)) {
			this.selected = "deny";
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			return;
		}
		if (matchesKey(data, Key.down) || data === "j") {
			this.scrollOffset += 1;
			return;
		}
		if (matchesKey(data, Key.pageUp)) {
			this.scrollOffset = Math.max(0, this.scrollOffset - DIFF_PREVIEW_VISIBLE_LINES);
			return;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollOffset += DIFF_PREVIEW_VISIBLE_LINES;
			return;
		}
		if (data.length === 1) {
			const normalized = data.toLowerCase();
			if (normalized === "y" || normalized === "a") this.done(true);
			else if (normalized === "n" || normalized === "d") this.done(false);
		}
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const body = this.renderBody(safeWidth);
		const maxScroll = Math.max(0, body.length - DIFF_PREVIEW_VISIBLE_LINES);
		this.scrollOffset = Math.min(this.scrollOffset, maxScroll);
		const visibleBody = body.slice(this.scrollOffset, this.scrollOffset + DIFF_PREVIEW_VISIBLE_LINES);
		const lines = [
			...this.renderHeader(safeWidth),
			"",
			...visibleBody,
		];
		if (body.length > DIFF_PREVIEW_VISIBLE_LINES) {
			lines.push(
				this.theme.fg(
					"dim",
					`Showing ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + DIFF_PREVIEW_VISIBLE_LINES, body.length)} of ${body.length} diff lines`,
				),
			);
		}
		lines.push("", this.renderButtons(safeWidth), this.theme.fg("dim", "↑/↓ scroll • ←/→ choose • enter approve/deny • esc deny • no editing"));
		return lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth));
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
			this.theme.fg("dim", "Read-only diff preview. The proposed output cannot be edited."),
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
		if (this.preview.language) return this.theme.fg(color, prefix) + content;
		return this.theme.fg(color, prefix + content);
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
		const deny = this.renderButton("deny", "Deny");
		return truncateToWidth(`${allow} ${deny}`, width);
	}

	private renderButton(choice: ApprovalChoice, label: string): string {
		const base = ` ${label} `;
		if (this.selected !== choice) {
			return choice === "allow" ? this.theme.fg("success", base) : this.theme.fg("error", base);
		}
		const colored = choice === "allow" ? this.theme.fg("success", this.theme.bold(base)) : this.theme.fg("error", this.theme.bold(base));
		return this.theme.bg("selectedBg", colored);
	}
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

async function requestDiffApproval(ctx: ExtensionContext, preview: DiffPreview): Promise<boolean> {
	return await ctx.ui.custom<boolean>((tui, theme, _keybindings, done) => {
		const component = new DiffApprovalComponent(preview, theme, done);
		return {
			render: (width: number) => component.render(width),
			invalidate: () => component.invalidate(),
			handleInput: (data: string) => {
				component.handleInput(data);
				tui.requestRender();
			},
		};
	});
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

function getErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined;
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
            ctx.ui.notify(formatModeChange(requested), "info");
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
            ctx.ui.notify(formatModeChange(nextMode), "info");
        },
    });

    pi.registerCommand("permissions-reload", {
        description: "Reload permission config files",
        handler: async (_args, ctx) => {
            reloadPolicy(ctx.cwd);
            updateStatus(ctx);
            ctx.ui.notify("Permissions reloaded", "info");
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
				ctx.ui.notify(`Saved ${scope} permissions`, "info");
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
    if (!ctx.hasUI) return { block: true, reason: `Write requires diff approval: ${input.path}` };

	let preview: DiffPreview;
	try {
		preview = buildWriteDiffPreview(input, ctx.cwd);
	} catch (error) {
		return { block: true, reason: `Could not prepare write diff for approval: ${formatError(error)}` };
	}

	const approved = await requestDiffApproval(ctx, preview);
	if (!approved) return { block: true, reason: `Denied write after diff review: ${input.path}` };
}

async function handleEdit(input: { path: string; edits: Array<{ oldText: string; newText: string }> }, ctx: ExtensionContext) {
    if (matchesAnyPath(resolveForPolicy(input.path, ctx.cwd), [...effective.paths.denyWrite, ...effective.paths.sensitive], ctx.cwd)) {
        return { block: true, reason: `Edit blocked by permissions policy: ${input.path}` };
    }
    if (currentMode() === "auto") return;
    if (!ctx.hasUI) return { block: true, reason: `Edit requires diff approval: ${input.path}` };

	let preview: DiffPreview;
	try {
		preview = buildEditDiffPreview(input, ctx.cwd);
	} catch (error) {
		return { block: true, reason: `Could not prepare edit diff for approval: ${formatError(error)}` };
	}

	const approved = await requestDiffApproval(ctx, preview);
	if (!approved) return { block: true, reason: `Denied edit after diff review: ${input.path}` };
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
        mode: "auto",
        bash: { allowExact: [], allowPrefixes: [], denyPatterns: [] },
		tools: { allow: [] },
		paths: { denyRead: [], denyWrite: [], sensitive: [] },
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
        : "Permissions ask mode enabled: read-only bash is auto-approved; mutating or unknown bash/custom tools prompt unless allowlisted, and writes/edits require read-only diff approval.";
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
        mode: cfg.mode ?? "auto",
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
		`Main editor vim: ${effective.mainEditor.vimMode ? "on" : "off"}`,
	].join("\n");
}
