import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FilesystemWatchOptions } from "./filesystem.ts";
import type { MonitorLease, MonitorLeaseOptions } from "./leases.ts";
import type { MonitorCheckScheduler, MonitorCheckSchedulerOptions } from "./scheduler.ts";

export const MONITOR_BATCH_MESSAGE_TYPE = "pi-monitors-notification-batch";
export const MONITOR_ADAPTER_DISCOVERY_EVENT = "pi-monitors:discover-adapters:v1";

export interface PiMonitorAdapterDiscovery {
	version: 1;
	register(adapter: unknown): void;
}

export type MonitorLifecycle = "active" | "completed";
export type MonitorHealth = "healthy" | "degraded";

export interface MonitorView {
	id: string;
	kind: string;
	label: string;
	lifecycle: MonitorLifecycle;
	health: MonitorHealth;
	attentionCount: number;
	status: string;
	detail: readonly string[];
	lastCheckedAt?: string;
	nextCheckAt?: string;
	completedAt?: string;
}

export interface MonitorRecord extends MonitorView {
	lifecycle: "completed";
	completedAt: string;
}

export interface PendingEventNotification {
	fingerprint: string;
	customType: string;
}

export interface ActiveMonitorRecord<T = unknown> {
	id: string;
	adapterId: string;
	adapterVersion: number;
	createdAt: string;
	state: T;
	pendingNotification?: PendingEventNotification;
	deliveredFingerprints: string[];
}

export interface EventNotification {
	fingerprint: string;
	customType: string;
	content: string;
	display?: boolean;
	details: Record<string, unknown>;
}

export interface EventDelivery {
	deliver(recordId: string, notification: EventNotification): boolean;
	acknowledge(recordId: string, message: unknown): boolean;
	hasDelivered(recordId: string, fingerprint?: string): boolean;
	hasPending(recordId: string): boolean;
}

export interface ActiveMonitorStore<T> {
	load(): readonly ActiveMonitorRecord<T>[];
	save(id: string, state: T): ActiveMonitorRecord<T>;
	remove(id: string): boolean;
}

export interface ActiveMonitorStoreOptions<T> {
	version: number;
	decodeState(value: unknown): T | undefined;
}

export interface MonitorSnapshot {
	generatedAt: string;
	summary: {
		active: number;
		degraded: number;
		attention: number;
		recent: number;
	};
	active: readonly MonitorView[];
	recent: readonly MonitorView[];
}

export interface PiMonitorSession {
	startSession(ctx: ExtensionContext): Promise<void>;
	rebindBranch(ctx: ExtensionContext): Promise<void>;
	messageEnded(message: unknown): Promise<void>;
	dispose(): Promise<void>;
	snapshot(): { active: readonly MonitorView[]; recent: readonly MonitorView[] };
	subscribe(listener: () => void): () => void;
	refresh(monitorId?: string): Promise<boolean>;
	stop(monitorId: string): Promise<boolean>;
}

export interface PiMonitorServices {
	createCheckScheduler(options: MonitorCheckSchedulerOptions): MonitorCheckScheduler;
	createActiveStore<T>(options: ActiveMonitorStoreOptions<T>): ActiveMonitorStore<T>;
	createDelivery(): EventDelivery;
	createLease(options: MonitorLeaseOptions): MonitorLease;
	watchFiles(options: FilesystemWatchOptions): () => void;
}

export interface PiMonitorAdapter {
	id: string;
	bind(pi: ExtensionAPI, services: PiMonitorServices): PiMonitorSession;
}
