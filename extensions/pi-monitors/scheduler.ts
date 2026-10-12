export type MonitorCheckOutcome = { ok: true } | { ok: false; error: string };
export type MonitorTimerHandle = ReturnType<typeof setTimeout>;

export interface MonitorCheckSchedulerOptions {
	intervalMs: number;
	maxBackoffMs: number;
	check(signal: AbortSignal): Promise<MonitorCheckOutcome>;
	canCheck(): boolean;
	onChange(): void;
	now?: () => number;
	schedule?: (callback: () => void, delayMs: number) => MonitorTimerHandle;
	cancelSchedule?: (handle: MonitorTimerHandle) => void;
}

export interface MonitorCheckScheduler {
	readonly nextCheckAt: string | undefined;
	start(parentSignal?: AbortSignal): Promise<MonitorCheckOutcome>;
	stop(): void;
}

function defaultSchedule(callback: () => void, delayMs: number): MonitorTimerHandle {
	const timer = setTimeout(callback, delayMs);
	timer.unref();
	return timer;
}

export class RuntimeCheckScheduler implements MonitorCheckScheduler {
	private readonly options: MonitorCheckSchedulerOptions;
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => MonitorTimerHandle;
	private readonly cancelSchedule: (handle: MonitorTimerHandle) => void;
	private timer: MonitorTimerHandle | undefined;
	private checkAbort: AbortController | undefined;
	private backoffMs: number;
	private generation = 0;
	private stopped = false;
	private nextCheck: string | undefined;

	constructor(options: MonitorCheckSchedulerOptions) {
		if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) throw new Error("Monitor check interval must be a positive integer");
		if (!Number.isSafeInteger(options.maxBackoffMs) || options.maxBackoffMs < options.intervalMs) {
			throw new Error("Monitor maximum backoff must be an integer at least as large as the check interval");
		}
		this.options = options;
		this.now = options.now ?? Date.now;
		this.schedule = options.schedule ?? defaultSchedule;
		this.cancelSchedule = options.cancelSchedule ?? clearTimeout;
		this.backoffMs = options.intervalMs;
	}

	get nextCheckAt(): string | undefined {
		return this.nextCheck;
	}

	async start(parentSignal?: AbortSignal): Promise<MonitorCheckOutcome> {
		this.stopped = false;
		const generation = ++this.generation;
		this.clearTimer();
		const outcome = await this.run(parentSignal);
		if (generation === this.generation && !this.stopped && !parentSignal?.aborted && this.options.canCheck()) {
			this.scheduleNext(outcome.ok ? this.options.intervalMs : this.backoffMs);
		}
		return outcome;
	}

	stop(): void {
		this.stopped = true;
		this.generation++;
		this.clearTimer();
		this.checkAbort?.abort();
		this.checkAbort = undefined;
	}

	private async run(parentSignal?: AbortSignal): Promise<MonitorCheckOutcome> {
		if (this.stopped) return { ok: true };
		this.checkAbort?.abort();
		if (!this.options.canCheck()) return { ok: true };
		const controller = new AbortController();
		const abort = () => controller.abort();
		parentSignal?.addEventListener("abort", abort, { once: true });
		if (parentSignal?.aborted) controller.abort();
		this.checkAbort = controller;
		try {
			let outcome: MonitorCheckOutcome;
			try {
				outcome = await this.options.check(controller.signal);
			} catch (error) {
				if (controller.signal.aborted) return { ok: true };
				const message = String(error instanceof Error ? error.message : error)
					.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ")
					.replace(/\s+/g, " ")
					.trim()
					.slice(0, 500);
				outcome = { ok: false, error: message || "monitor check failed" };
			}
			if (!controller.signal.aborted) {
				this.backoffMs = outcome.ok
					? this.options.intervalMs
					: Math.min(this.options.maxBackoffMs, Math.max(this.options.intervalMs, this.backoffMs * 2));
			}
			return outcome;
		} finally {
			parentSignal?.removeEventListener("abort", abort);
			if (this.checkAbort === controller) this.checkAbort = undefined;
		}
	}

	private scheduleNext(delayMs: number): void {
		this.clearTimer();
		this.nextCheck = new Date(this.now() + delayMs).toISOString();
		this.timer = this.schedule(() => {
			this.timer = undefined;
			this.nextCheck = undefined;
			const generation = ++this.generation;
			this.options.onChange();
			void this.runScheduled(generation);
		}, delayMs);
		this.options.onChange();
	}

	private async runScheduled(generation: number): Promise<void> {
		const outcome = await this.run();
		if (generation === this.generation && !this.stopped && this.options.canCheck()) {
			this.scheduleNext(outcome.ok ? this.options.intervalMs : this.backoffMs);
		}
	}

	private clearTimer(): void {
		if (this.timer) this.cancelSchedule(this.timer);
		this.timer = undefined;
		if (this.nextCheck) {
			this.nextCheck = undefined;
			this.options.onChange();
		}
	}
}
