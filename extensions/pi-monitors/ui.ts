import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Box,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import type { PiMonitorsRuntime } from "./runtime.ts";
import type { MonitorSnapshot, MonitorView } from "./types.ts";

type MonitorTuiView = Pick<TUI, "requestRender"> & { terminal?: { rows: number } };

function monitorPanelLimit(tui: MonitorTuiView): number {
	return Math.max(1, Math.floor((tui.terminal?.rows ?? 24) * 0.85));
}

function compactPanelLines(height: number, header: string, content: string[], footer: string): string[] {
	if (height <= 1) return [footer];
	if (height === 2) return [header, footer];
	return [header, ...content.slice(0, height - 2), footer];
}

function padAnsi(value: string, width: number): string {
	const truncated = truncateToWidth(value, Math.max(1, width), "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function opaqueOverlay(lines: string[], width: number, theme: Theme): string[] {
	const box = new Box(0, 0, (text) => theme.bg("toolPendingBg", text));
	box.addChild(new Text(lines.map((line) => padAnsi(line, width)).join("\n"), 0, 0));
	return box.render(width);
}

function framedOverlay(lines: string[], width: number, theme: Theme): string[] {
	const safeWidth = Math.max(1, width);
	if (safeWidth < 3) {
		return opaqueOverlay(lines.map((line) => truncateToWidth(line, safeWidth, "")), safeWidth, theme);
	}
	const innerWidth = safeWidth - 2;
	const border = (value: string) => theme.fg("borderMuted", value);
	return opaqueOverlay([
		border(`╭${"─".repeat(innerWidth)}╮`),
		...lines.map((line) => `${border("│")}${padAnsi(line, innerWidth)}${border("│")}`),
		border(`╰${"─".repeat(innerWidth)}╯`),
	], safeWidth, theme);
}

function sizedOverlay(lines: string[], width: number, height: number, theme: Theme): string[] {
	const safeWidth = Math.max(1, width);
	const safeHeight = Math.max(1, height);
	if (safeWidth < 3) {
		const visible = lines.slice(0, safeHeight);
		return opaqueOverlay([
			...visible,
			...Array.from({ length: safeHeight - visible.length }, () => ""),
		], safeWidth, theme);
	}
	if (safeHeight < 3) {
		const compact = safeHeight === 1 ? [lines.at(-1) ?? ""] : [lines[0] ?? "", lines.at(-1) ?? ""];
		return opaqueOverlay(compact, safeWidth, theme);
	}
	const innerHeight = safeHeight - 2;
	const visible = lines.slice(0, innerHeight);
	return framedOverlay([
		...visible,
		...Array.from({ length: innerHeight - visible.length }, () => ""),
	], safeWidth, theme);
}

interface MonitorHotkeyHint {
	key: string;
	label: string;
	priority: number;
}

interface MonitorPanelOptions {
	header: string;
	chrome?: string[];
	body: (width: number, height: number) => string[];
	compactBody?: (width: number) => string[];
	footer: string;
}

function monitorHotkeyFooter(hints: MonitorHotkeyHint[], width: number, theme: Theme): string {
	const separator = theme.fg("dim", " · ");
	const rendered = hints.map((hint, index) => ({
		index,
		priority: hint.priority,
		text: `${theme.fg("accent", hint.key)} ${theme.fg("dim", hint.label)}`,
	}));
	const selected = new Set<number>();
	for (const candidate of [...rendered].sort((left, right) => left.priority - right.priority || left.index - right.index)) {
		const next = rendered
			.filter((item) => selected.has(item.index) || item.index === candidate.index)
			.map((item) => item.text)
			.join(separator);
		if (visibleWidth(next) <= width || selected.size === 0) selected.add(candidate.index);
	}
	return truncateToWidth(
		rendered.filter((item) => selected.has(item.index)).map((item) => item.text).join(separator),
		width,
		"",
	);
}

function renderMonitorPanel(width: number, tui: MonitorTuiView, theme: Theme, options: MonitorPanelOptions): string[] {
	const safeWidth = Math.max(1, width);
	const innerWidth = Math.max(1, safeWidth - 2);
	const maxPanelHeight = monitorPanelLimit(tui);
	const maxInnerHeight = Math.max(0, maxPanelHeight - 2);
	const header = truncateToWidth(options.header, innerWidth, "");
	const chrome = (options.chrome ?? []).map((line) => truncateToWidth(line, innerWidth, ""));
	const footer = truncateToWidth(options.footer, innerWidth, "");
	const bodyHeight = Math.max(0, maxInnerHeight - chrome.length - 2);
	if (bodyHeight < 1) {
		const compactBody = options.compactBody?.(innerWidth) ?? options.body(innerWidth, 1);
		return sizedOverlay(compactPanelLines(maxInnerHeight, header, compactBody, footer), safeWidth, maxPanelHeight, theme);
	}
	const body = options.body(innerWidth, bodyHeight).slice(0, bodyHeight);
	const lines = [header, ...chrome, ...body, footer];
	return sizedOverlay(lines, safeWidth, Math.min(maxPanelHeight, lines.length + 2), theme);
}

function monitorSelectionKey(monitor: MonitorView): string {
	return monitor.lifecycle === "completed" ? `completed:${monitor.id}:${monitor.completedAt ?? "unknown"}` : `active:${monitor.id}`;
}

function monitorIcon(monitor: MonitorView, theme: Theme): string {
	if (monitor.lifecycle === "completed") return theme.fg(monitor.health === "degraded" ? "error" : "success", monitor.health === "degraded" ? "✗" : "✓");
	return theme.fg(monitor.health === "degraded" ? "error" : "accent", monitor.health === "degraded" ? "!" : "◐");
}

interface DisplayLine {
	text: string;
	monitor?: MonitorView;
}

export class MonitorOverlayComponent implements Component {
	private readonly runtime: PiMonitorsRuntime;
	private readonly tui: MonitorTuiView;
	private readonly theme: Theme;
	private readonly done: () => void;
	private readonly unsubscribe: () => void;
	private selectedKey: string | undefined;
	private detail = false;
	private pending: "refresh" | "stop" | "dismiss" | undefined;
	private error: string | undefined;
	private disposed = false;

	constructor(
		runtime: PiMonitorsRuntime,
		tui: MonitorTuiView,
		theme: Theme,
		done: () => void,
	) {
		this.runtime = runtime;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.reconcileSelection();
		this.unsubscribe = runtime.subscribe(() => {
			this.reconcileSelection();
			this.tui.requestRender();
		});
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (matchesKey(data, "escape") || data === "q") {
			if (this.detail) {
				this.detail = false;
				this.tui.requestRender();
			} else {
				this.done();
			}
			return;
		}
		if (this.pending) return;
		const monitors = this.monitors();
		const selectedIndex = monitors.findIndex((monitor) => monitorSelectionKey(monitor) === this.selectedKey);
		if ((matchesKey(data, "up") || data === "k") && selectedIndex > 0) {
			this.selectedKey = monitors[selectedIndex - 1] ? monitorSelectionKey(monitors[selectedIndex - 1]!) : undefined;
			this.detail = false;
			this.tui.requestRender();
			return;
		}
		if ((matchesKey(data, "down") || data === "j") && selectedIndex >= 0 && selectedIndex < monitors.length - 1) {
			this.selectedKey = monitors[selectedIndex + 1] ? monitorSelectionKey(monitors[selectedIndex + 1]!) : undefined;
			this.detail = false;
			this.tui.requestRender();
			return;
		}
		if ((matchesKey(data, "return") || matchesKey(data, "right")) && selectedIndex >= 0) {
			this.detail = true;
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") void this.refresh();
		if (data === "s") void this.stopSelected();
		if (data === "d") this.dismissSelected();
	}

	render(width: number): string[] {
		const snapshot = this.runtime.snapshot();
		const selected = this.monitors(snapshot).find((monitor) => monitorSelectionKey(monitor) === this.selectedKey);
		return this.detail && selected
			? this.renderDetail(selected, width)
			: this.renderList(snapshot, width);
	}

	invalidate(): void {}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}

	private monitors(snapshot = this.runtime.snapshot()): MonitorView[] {
		return [...snapshot.active, ...snapshot.recent];
	}

	private reconcileSelection(): void {
		const monitors = this.monitors();
		if (!monitors.some((monitor) => monitorSelectionKey(monitor) === this.selectedKey)) {
			this.selectedKey = monitors[0] ? monitorSelectionKey(monitors[0]) : undefined;
			this.detail = false;
		}
	}

	private displayLines(snapshot: MonitorSnapshot): DisplayLine[] {
		const lines: DisplayLine[] = [];
		lines.push({ text: this.theme.fg("muted", "ACTIVE MONITORS") });
		if (snapshot.active.length === 0) lines.push({ text: this.theme.fg("dim", "  No active monitors.") });
		for (const monitor of snapshot.active) lines.push({ text: this.monitorLine(monitor), monitor });
		lines.push({ text: "" }, { text: this.theme.fg("muted", "RECENT OUTCOMES") });
		if (snapshot.recent.length === 0) lines.push({ text: this.theme.fg("dim", "  No recent outcomes.") });
		for (const monitor of snapshot.recent) lines.push({ text: this.monitorLine(monitor), monitor });
		return lines;
	}

	private monitorLine(monitor: MonitorView): string {
		const selected = monitorSelectionKey(monitor) === this.selectedKey;
		const marker = selected ? this.theme.fg("accent", "›") : " ";
		const label = selected ? this.theme.fg("accent", monitor.label) : monitor.label;
		return `${marker} ${monitorIcon(monitor, this.theme)} ${label} ${this.theme.fg("dim", `· ${monitor.status}`)}`;
	}

	private renderList(snapshot: MonitorSnapshot, width: number): string[] {
		const summary = `${snapshot.summary.active} active${snapshot.summary.degraded > 0 ? ` · ${snapshot.summary.degraded} degraded` : ""}${snapshot.summary.recent > 0 ? ` · ${snapshot.summary.recent} recent` : ""}`;
		const selected = this.monitors(snapshot).find((monitor) => monitorSelectionKey(monitor) === this.selectedKey);
		const pendingLabel = this.pending === "refresh" ? "Refreshing" : this.pending === "stop" ? "Stopping" : "Dismissing";
		const pending = this.pending ? this.theme.fg("warning", `${pendingLabel}…`) : undefined;
		const hints: MonitorHotkeyHint[] = [
			{ key: "↑/↓ j/k", label: "select", priority: 3 },
			{ key: "Enter", label: "details", priority: 1 },
			...(selected?.lifecycle === "active" ? [{ key: "s", label: "stop", priority: 2 }] : []),
			...(selected?.lifecycle === "completed" ? [{ key: "d", label: "dismiss", priority: 2 }] : []),
			{ key: "r", label: "refresh", priority: 4 },
			{ key: "q/Esc", label: "close", priority: 0 },
		];
		return renderMonitorPanel(width, this.tui, this.theme, {
			header: `${this.theme.bold("Monitors")} ${this.theme.fg("dim", `· ${summary}`)}`,
			chrome: [this.theme.fg("borderMuted", "─".repeat(Math.max(1, width - 2)))],
			body: (bodyWidth, bodyHeight) => this.visibleDisplayLines(snapshot, bodyWidth, bodyHeight),
			compactBody: (bodyWidth) => this.visibleDisplayLines(snapshot, bodyWidth, 1),
			footer: this.error
				? this.theme.fg("error", this.error)
				: pending ?? monitorHotkeyFooter(hints, Math.max(1, width - 2), this.theme),
		});
	}

	private visibleDisplayLines(snapshot: MonitorSnapshot, width: number, height: number): string[] {
		const display = this.displayLines(snapshot);
		const selectedLine = Math.max(0, display.findIndex((line) => line.monitor && monitorSelectionKey(line.monitor) === this.selectedKey));
		const start = Math.min(
			Math.max(0, selectedLine - Math.floor(height / 2)),
			Math.max(0, display.length - height),
		);
		return display.slice(start, start + height).map((line) => truncateToWidth(line.text, width, ""));
	}

	private renderDetail(monitor: MonitorView, width: number): string[] {
		const hints = monitorHotkeyFooter([{ key: "q/Esc", label: "monitors", priority: 0 }], Math.max(1, width - 2), this.theme);
		return renderMonitorPanel(width, this.tui, this.theme, {
			header: `${monitorIcon(monitor, this.theme)} ${this.theme.bold(monitor.label)} ${this.theme.fg("dim", `· ${monitor.status}`)}`,
			chrome: [this.theme.fg("borderMuted", "─".repeat(Math.max(1, width - 2)))],
			body: (bodyWidth) => monitor.detail.map((line) => truncateToWidth(line, bodyWidth, "")),
			footer: hints,
		});
	}

	private async refresh(): Promise<void> {
		this.pending = "refresh";
		this.error = undefined;
		this.tui.requestRender();
		try {
			await this.runtime.refresh();
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = undefined;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private dismissSelected(): void {
		const monitor = this.runtime.snapshot().recent.find((candidate) => monitorSelectionKey(candidate) === this.selectedKey);
		if (!monitor) return;
		this.pending = "dismiss";
		this.error = undefined;
		try {
			this.runtime.dismiss(monitor.id);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = undefined;
			if (!this.disposed) this.tui.requestRender();
		}
	}

	private async stopSelected(): Promise<void> {
		const monitor = this.runtime.snapshot().active.find((candidate) => monitorSelectionKey(candidate) === this.selectedKey);
		if (!monitor) return;
		this.pending = "stop";
		this.error = undefined;
		this.tui.requestRender();
		try {
			await this.runtime.stop(monitor.id);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.pending = undefined;
			if (!this.disposed) this.tui.requestRender();
		}
	}
}

export interface MonitorUi {
	open(context: ExtensionContext): Promise<void>;
	dispose(): void;
}

export function createMonitorUi(runtime: PiMonitorsRuntime): MonitorUi {
	let closeActiveOverlay: (() => void) | undefined;
	return {
		async open(context) {
			if (context.mode !== "tui") throw new Error("Monitor management is available only in interactive TUI mode");
			closeActiveOverlay?.();
			let component: MonitorOverlayComponent | undefined;
			let ownedClose: (() => void) | undefined;
			try {
				await context.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						let closed = false;
						ownedClose = () => {
							if (closed) return;
							closed = true;
							component?.dispose();
							if (closeActiveOverlay === ownedClose) closeActiveOverlay = undefined;
							done();
						};
						component = new MonitorOverlayComponent(runtime, tui, theme, ownedClose);
						closeActiveOverlay = ownedClose;
						return component;
					},
					{
						overlay: true,
						overlayOptions: { anchor: "bottom-center", width: "90%", maxHeight: "85%", margin: 1 },
					},
				);
			} finally {
				component?.dispose();
				if (closeActiveOverlay === ownedClose) closeActiveOverlay = undefined;
			}
		},
		dispose() {
			const close = closeActiveOverlay;
			closeActiveOverlay = undefined;
			close?.();
		},
	};
}
