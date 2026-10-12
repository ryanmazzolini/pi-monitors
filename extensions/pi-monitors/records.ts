import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActiveMonitorRecord, MonitorRecord, MonitorView } from "./types.ts";

export const MONITOR_RECORDS_TYPE = "pi-monitors-records";
const RECORDS_VERSION = 1;
export const MAX_ACTIVE_MONITORS = 100;
export const MAX_ADAPTER_ID_LENGTH = 64;
export const MAX_RECENT_MONITORS = 10;
export const MAX_DISMISSED_MONITORS = 100;
const MAX_DETAIL_LINES = 20;
const MAX_ADAPTER_STATE_BYTES = 64 * 1024;
const MAX_DELIVERED_FINGERPRINTS = 100;

export interface MonitorRecordState {
	version: 1;
	active: ActiveMonitorRecord[];
	recent: MonitorRecord[];
	dismissed: string[];
}

function boundedString(value: unknown, maximum: number): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= maximum
		&& !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function validDate(value: unknown): value is string {
	return boundedString(value, 40) && Number.isFinite(Date.parse(value));
}

function cloneAdapterState(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_ADAPTER_STATE_BYTES) {
		throw new Error("Monitor adapter state exceeds its durable record limit");
	}
	return JSON.parse(serialized) as unknown;
}

function isActiveMonitorRecord(value: unknown): value is ActiveMonitorRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ActiveMonitorRecord>;
	if (!boundedString(record.id, 512)
		|| !boundedString(record.adapterId, MAX_ADAPTER_ID_LENGTH)
		|| !Number.isSafeInteger(record.adapterVersion)
		|| (record.adapterVersion ?? 0) <= 0
		|| !validDate(record.createdAt)
		|| !Array.isArray(record.deliveredFingerprints)
		|| record.deliveredFingerprints.length > MAX_DELIVERED_FINGERPRINTS
		|| !record.deliveredFingerprints.every((fingerprint) => typeof fingerprint === "string" && /^[0-9a-f]{64}$/.test(fingerprint))
		|| (record.pendingNotification !== undefined && (
			!record.pendingNotification
			|| typeof record.pendingNotification !== "object"
			|| typeof record.pendingNotification.fingerprint !== "string"
			|| !/^[0-9a-f]{64}$/.test(record.pendingNotification.fingerprint)
			|| !boundedString(record.pendingNotification.customType, 128)
		))) return false;
	try {
		cloneAdapterState(record.state);
		return true;
	} catch {
		return false;
	}
}

export function cloneActiveRecord(record: ActiveMonitorRecord): ActiveMonitorRecord {
	return {
		...record,
		state: cloneAdapterState(record.state),
		...(record.pendingNotification ? { pendingNotification: { ...record.pendingNotification } } : {}),
		deliveredFingerprints: [...record.deliveredFingerprints],
	};
}

function isMonitorRecord(value: unknown): value is MonitorRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<MonitorRecord>;
	return boundedString(record.id, 512)
		&& boundedString(record.kind, 64)
		&& boundedString(record.label, 256)
		&& record.lifecycle === "completed"
		&& (record.health === "healthy" || record.health === "degraded")
		&& Number.isSafeInteger(record.attentionCount)
		&& (record.attentionCount ?? -1) >= 0
		&& (record.attentionCount ?? Number.MAX_SAFE_INTEGER) <= 1_000
		&& boundedString(record.status, 500)
		&& Array.isArray(record.detail)
		&& record.detail.length <= MAX_DETAIL_LINES
		&& record.detail.every((line) => boundedString(line, 500))
		&& (record.lastCheckedAt === undefined || validDate(record.lastCheckedAt))
		&& (record.nextCheckAt === undefined || validDate(record.nextCheckAt))
		&& validDate(record.completedAt);
}

function hasValidPresentationState(state: { recent?: unknown; dismissed?: unknown }): boolean {
	return Array.isArray(state.recent)
		&& state.recent.length <= MAX_RECENT_MONITORS
		&& state.recent.every(isMonitorRecord)
		&& Array.isArray(state.dismissed)
		&& state.dismissed.length <= MAX_DISMISSED_MONITORS
		&& state.dismissed.every((key) => boundedString(key, 1_024));
}

function isMonitorRecordState(value: unknown): value is MonitorRecordState {
	if (!value || typeof value !== "object") return false;
	const state = value as Partial<MonitorRecordState>;
	return state.version === RECORDS_VERSION
		&& Array.isArray(state.active)
		&& state.active.length <= MAX_ACTIVE_MONITORS
		&& state.active.every(isActiveMonitorRecord)
		&& new Set(state.active.map((record) => record.id)).size === state.active.length
		&& hasValidPresentationState(state);
}

function cloneRecord(record: MonitorRecord): MonitorRecord {
	return { ...record, detail: [...record.detail] };
}

export function completionKey(record: Pick<MonitorRecord, "id" | "completedAt">): string {
	return `${record.id}::${record.completedAt}`;
}

export function toMonitorRecord(view: MonitorView): MonitorRecord | undefined {
	if (view.lifecycle !== "completed" || !view.completedAt) return undefined;
	const candidate: MonitorRecord = {
		...view,
		lifecycle: "completed",
		completedAt: view.completedAt,
		detail: [...view.detail],
	};
	return isMonitorRecord(candidate) ? candidate : undefined;
}

export function normalizeMonitorRecords(records: Iterable<MonitorRecord>, dismissed: ReadonlySet<string>): MonitorRecord[] {
	const byId = new Map<string, MonitorRecord>();
	for (const record of records) {
		if (!isMonitorRecord(record) || dismissed.has(completionKey(record))) continue;
		const current = byId.get(record.id);
		if (!current || Date.parse(record.completedAt) > Date.parse(current.completedAt)) byId.set(record.id, cloneRecord(record));
	}
	return [...byId.values()]
		.sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
		.slice(0, MAX_RECENT_MONITORS);
}

export function loadMonitorRecordState(ctx: ExtensionContext): MonitorRecordState {
	let latest: MonitorRecordState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === MONITOR_RECORDS_TYPE && isMonitorRecordState(entry.data)) latest = entry.data;
	}
	return latest
		? {
			version: RECORDS_VERSION,
			active: latest.active.map(cloneActiveRecord),
			recent: latest.recent.map(cloneRecord),
			dismissed: [...latest.dismissed],
		}
		: { version: RECORDS_VERSION, active: [], recent: [], dismissed: [] };
}

export function persistMonitorRecordState(
	pi: ExtensionAPI,
	active: readonly ActiveMonitorRecord[],
	recent: readonly MonitorRecord[],
	dismissed: ReadonlySet<string>,
): MonitorRecordState {
	const state: MonitorRecordState = {
		version: RECORDS_VERSION,
		active: active.slice(0, MAX_ACTIVE_MONITORS).map(cloneActiveRecord),
		recent: recent.slice(0, MAX_RECENT_MONITORS).map(cloneRecord),
		dismissed: [...dismissed].slice(-MAX_DISMISSED_MONITORS),
	};
	pi.appendEntry(MONITOR_RECORDS_TYPE, state);
	return state;
}
