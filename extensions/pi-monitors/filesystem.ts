import { watch as watchDirectory } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export const FILES_CHANGED_EVENT = "pi-monitors:files-changed:v1";

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_RETRY_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 30_000;
const MAX_WATCHES = 64;
const MAX_FILENAMES = 128;
const MAX_CHANGED_PATHS = 100;
const MAX_WATCH_ID_BYTES = 128;
const MAX_PATH_BYTES = 4_096;
const MAX_EVENT_PATH_BYTES = 60 * 1_024;

export interface FilesChangedEvent {
	watchId: string;
	paths: readonly string[] | null;
	observedAt: string;
}

export interface FilesystemWatchOptions {
	watchId: string;
	directory: string;
	filenames?: readonly string[];
	debounceMs?: number;
}

interface WatchHandle {
	on(event: "error", listener: (error: Error) => void): this;
	close(): void;
}

interface TimerHandle {
	unref?(): void;
}

interface Registration {
	watchId: string;
	directory: string;
	filenames: Set<string> | undefined;
	debounceMs: number;
	pendingPaths: Set<string> | null;
	timer: TimerHandle | undefined;
}

interface WatchedDirectory {
	path: string;
	watchIds: Set<string>;
	handle: WatchHandle | undefined;
	retryTimer: TimerHandle | undefined;
	retryMs: number;
}

export interface FilesystemWakeupsOptions {
	emit(event: FilesChangedEvent): void;
	watch?: (directory: string, listener: (eventType: string, filename: string | Buffer | null) => void) => WatchHandle;
	now?: () => number;
	schedule?: (callback: () => void, delayMs: number) => TimerHandle;
	cancelSchedule?: (handle: TimerHandle) => void;
	retryMs?: number;
	maxRetryMs?: number;
}

function defaultWatch(
	directory: string,
	listener: (eventType: string, filename: string | Buffer | null) => void,
): WatchHandle {
	return watchDirectory(directory, { persistent: false, encoding: "buffer" }, listener);
}

function defaultSchedule(callback: () => void, delayMs: number): TimerHandle {
	const timer = setTimeout(callback, delayMs);
	timer.unref();
	return timer;
}

function byteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

function isBoundedPrintable(value: string, maxBytes: number): boolean {
	return Boolean(value)
		&& byteLength(value) <= maxBytes
		&& !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

export class FilesystemWakeups {
	private readonly emit: (event: FilesChangedEvent) => void;
	private readonly watchDirectory: NonNullable<FilesystemWakeupsOptions["watch"]>;
	private readonly now: () => number;
	private readonly schedule: NonNullable<FilesystemWakeupsOptions["schedule"]>;
	private readonly cancelSchedule: NonNullable<FilesystemWakeupsOptions["cancelSchedule"]>;
	private readonly retryMs: number;
	private readonly maxRetryMs: number;
	private readonly registrations = new Map<string, Registration>();
	private readonly directories = new Map<string, WatchedDirectory>();
	private started = false;
	private disposed = false;

	constructor(options: FilesystemWakeupsOptions) {
		this.emit = options.emit;
		this.watchDirectory = options.watch ?? defaultWatch;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancelSchedule = options.cancelSchedule ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
		this.maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
		if (!Number.isSafeInteger(this.retryMs) || this.retryMs <= 0) throw new Error("Filesystem watcher retry must be a positive integer");
		if (!Number.isSafeInteger(this.maxRetryMs) || this.maxRetryMs < this.retryMs) {
			throw new Error("Filesystem watcher maximum retry must be at least its initial retry");
		}
	}

	watch(options: FilesystemWatchOptions): () => void {
		if (this.disposed) throw new Error("Filesystem wakeups have been disposed");
		if (!isBoundedPrintable(options.watchId, MAX_WATCH_ID_BYTES)) {
			throw new Error("Filesystem watch IDs must be bounded printable strings");
		}
		if (this.registrations.has(options.watchId)) throw new Error(`Duplicate filesystem watch ID: ${options.watchId}`);
		if (this.registrations.size >= MAX_WATCHES) throw new Error("Filesystem wakeup watch limit reached");
		if (!isAbsolute(options.directory) || !isBoundedPrintable(options.directory, MAX_PATH_BYTES)) {
			throw new Error("Filesystem watch directories must be bounded absolute paths");
		}
		const directory = resolve(options.directory);
		const filenames = this.checkedFilenames(options.filenames);
		const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
		if (!Number.isSafeInteger(debounceMs) || debounceMs <= 0 || debounceMs > 60_000) {
			throw new Error("Filesystem watch debounce must be between 1 and 60000 milliseconds");
		}
		const registration: Registration = {
			watchId: options.watchId,
			directory,
			filenames,
			debounceMs,
			pendingPaths: new Set(),
			timer: undefined,
		};
		this.registrations.set(registration.watchId, registration);
		let watched = this.directories.get(directory);
		if (!watched) {
			watched = {
				path: directory,
				watchIds: new Set(),
				handle: undefined,
				retryTimer: undefined,
				retryMs: this.retryMs,
			};
			this.directories.set(directory, watched);
		}
		watched.watchIds.add(registration.watchId);
		if (this.started) this.open(watched);

		let registered = true;
		return () => {
			if (!registered) return;
			registered = false;
			this.unregister(registration.watchId);
		};
	}

	start(): void {
		if (this.disposed) throw new Error("Filesystem wakeups have been disposed");
		if (this.started) return;
		this.started = true;
		for (const directory of this.directories.values()) this.open(directory);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.started = false;
		for (const registration of this.registrations.values()) this.clearRegistrationTimer(registration);
		for (const directory of this.directories.values()) this.closeDirectory(directory);
		this.registrations.clear();
		this.directories.clear();
	}

	private checkedFilenames(values: readonly string[] | undefined): Set<string> | undefined {
		if (values === undefined) return undefined;
		if (values.length === 0 || values.length > MAX_FILENAMES) {
			throw new Error(`Filesystem watches require between 1 and ${MAX_FILENAMES} filenames`);
		}
		const filenames = new Set<string>();
		for (const value of values) {
			if (!isBoundedPrintable(value, MAX_PATH_BYTES) || basename(value) !== value || value === "." || value === "..") {
				throw new Error("Filesystem watch filenames must be bounded base names");
			}
			filenames.add(value);
		}
		return filenames;
	}

	private unregister(watchId: string): void {
		const registration = this.registrations.get(watchId);
		if (!registration) return;
		this.clearRegistrationTimer(registration);
		this.registrations.delete(watchId);
		const directory = this.directories.get(registration.directory);
		if (!directory) return;
		directory.watchIds.delete(watchId);
		if (directory.watchIds.size > 0) return;
		this.closeDirectory(directory);
		this.directories.delete(directory.path);
	}

	private open(directory: WatchedDirectory): void {
		if (!this.started || directory.handle || directory.retryTimer || directory.watchIds.size === 0) return;
		try {
			const handle = this.watchDirectory(directory.path, (_eventType, filename) => this.changed(directory, filename));
			directory.handle = handle;
			directory.retryMs = this.retryMs;
			handle.on("error", () => this.failed(directory, handle));
		} catch {
			this.rescan(directory);
			this.scheduleRetry(directory);
		}
	}

	private changed(directory: WatchedDirectory, filename: string | Buffer | null): void {
		if (!this.started || directory.handle === undefined) return;
		if (filename === null) {
			this.rescan(directory);
			return;
		}
		const name = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
		if ((Buffer.isBuffer(filename) && !Buffer.from(name, "utf8").equals(filename))
			|| !isBoundedPrintable(name, MAX_PATH_BYTES) || basename(name) !== name || name === "." || name === "..") {
			this.rescan(directory);
			return;
		}
		const path = join(directory.path, name);
		for (const watchId of directory.watchIds) {
			const registration = this.registrations.get(watchId);
			if (registration && (!registration.filenames || registration.filenames.has(name))) this.queue(registration, path);
		}
	}

	private failed(directory: WatchedDirectory, handle: WatchHandle): void {
		if (directory.handle !== handle) return;
		try {
			handle.close();
		} catch {
			// The watcher has already failed; closing is best effort.
		}
		directory.handle = undefined;
		this.rescan(directory);
		this.scheduleRetry(directory);
	}

	private rescan(directory: WatchedDirectory): void {
		for (const watchId of directory.watchIds) {
			const registration = this.registrations.get(watchId);
			if (registration) this.queue(registration, null);
		}
	}

	private queue(registration: Registration, path: string | null): void {
		if (path === null) {
			registration.pendingPaths = null;
		} else if (registration.pendingPaths !== null) {
			registration.pendingPaths.add(path);
			const bytes = [...registration.pendingPaths].reduce((total, candidate) => total + byteLength(candidate), 0);
			if (registration.pendingPaths.size > MAX_CHANGED_PATHS || bytes > MAX_EVENT_PATH_BYTES) registration.pendingPaths = null;
		}
		if (registration.timer) return;
		registration.timer = this.schedule(() => this.flush(registration), registration.debounceMs);
		registration.timer.unref?.();
	}

	private flush(registration: Registration): void {
		registration.timer = undefined;
		if (!this.started || !this.registrations.has(registration.watchId)) return;
		const paths = registration.pendingPaths === null ? null : [...registration.pendingPaths].sort();
		registration.pendingPaths = new Set();
		if (paths !== null && paths.length === 0) return;
		try {
			this.emit({ watchId: registration.watchId, paths, observedAt: new Date(this.now()).toISOString() });
		} catch {
			// One event-bus failure must not stop filesystem observation.
		}
	}

	private scheduleRetry(directory: WatchedDirectory): void {
		if (!this.started || directory.retryTimer || directory.watchIds.size === 0) return;
		const delayMs = directory.retryMs;
		directory.retryMs = Math.min(this.maxRetryMs, directory.retryMs * 2);
		directory.retryTimer = this.schedule(() => {
			directory.retryTimer = undefined;
			this.open(directory);
		}, delayMs);
		directory.retryTimer.unref?.();
	}

	private clearRegistrationTimer(registration: Registration): void {
		if (registration.timer) this.cancelSchedule(registration.timer);
		registration.timer = undefined;
		registration.pendingPaths = new Set();
	}

	private closeDirectory(directory: WatchedDirectory): void {
		if (directory.retryTimer) this.cancelSchedule(directory.retryTimer);
		directory.retryTimer = undefined;
		if (directory.handle) {
			try {
				directory.handle.close();
			} catch {
				// Shutdown cleanup is best effort for an already-failed watcher.
			}
		}
		directory.handle = undefined;
	}
}
