import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGithubPrMonitorAdapter } from "./adapters/github-pr.ts";
import { createPiMonitorsRuntime, type PiMonitorsRuntime } from "./runtime.ts";
import {
	MONITOR_ADAPTER_DISCOVERY_EVENT,
	type PiMonitorAdapter,
	type PiMonitorAdapterDiscovery,
} from "./types.ts";
import { createMonitorUi } from "./ui.ts";

function isPiMonitorAdapter(value: unknown): value is PiMonitorAdapter {
	if (!value || typeof value !== "object") return false;
	const adapter = value as Partial<PiMonitorAdapter>;
	return typeof adapter.id === "string" && typeof adapter.bind === "function";
}

export function createPiMonitorsExtension(
	pi: ExtensionAPI,
	adapters: readonly PiMonitorAdapter[],
): PiMonitorsRuntime {
	let runtime: PiMonitorsRuntime;
	let discoveryPending = true;
	pi.on("session_start", () => {
		if (!discoveryPending) return;
		discoveryPending = false;
		const discovery: PiMonitorAdapterDiscovery = {
			version: 1,
			register(adapter) {
				if (!isPiMonitorAdapter(adapter)) throw new Error("Discovered monitor adapters require an ID and bind function");
				runtime.addAdapter(adapter);
			},
		};
		pi.events.emit(MONITOR_ADAPTER_DISCOVERY_EVENT, discovery);
	});
	runtime = createPiMonitorsRuntime(pi, adapters);
	const ui = createMonitorUi(runtime);
	pi.registerCommand("monitors", {
		description: "Inspect and manage monitors attached to this conversation",
		async handler(_args, ctx) {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Monitor management is available only in interactive TUI mode.", "warning");
				return;
			}
			await ui.open(ctx);
		},
	});
	runtime.addCleanup(() => ui.dispose());
	return runtime;
}

export default function piMonitorsExtension(pi: ExtensionAPI): void {
	createPiMonitorsExtension(pi, [createGithubPrMonitorAdapter()]);
}
