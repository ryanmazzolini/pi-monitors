import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { join } from "node:path";

const MALFORMED_LEASE_GRACE_MS = 30_000;
const LEASE_PROBE_TIMEOUT_MS = 250;

export interface MonitorLeaseOptions {
	directory: string;
	now?: () => number;
	resourceName?: string;
}

export interface MonitorLease {
	acquire(key: string, sessionId: string): Promise<void>;
	release(): Promise<void>;
}

interface LeaseOwner {
	token: string;
	sessionId: string;
	pid: number;
	createdAt: string;
	port: number;
}

interface LeaseIdentity {
	device: number;
	inode: number;
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise((resolve) => server.close(() => resolve()));
}

function startLeaseServer(token: string): Promise<{ server: Server; port: number }> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => socket.end(token));
		const onError = (error: Error) => reject(error);
		server.once("error", onError);
		server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
			server.off("error", onError);
			server.on("error", () => undefined);
			const address = server.address();
			if (!address || typeof address === "string") {
				void closeServer(server);
				reject(new Error("Could not determine the monitor lease port"));
				return;
			}
			server.unref();
			resolve({ server, port: address.port });
		});
	});
}

function leaseOwnerIsLive(owner: LeaseOwner): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ host: "127.0.0.1", port: owner.port });
		let response = "";
		let settled = false;
		const finish = (live: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			resolve(live);
		};
		const timer = setTimeout(() => finish(true), LEASE_PROBE_TIMEOUT_MS);
		timer.unref();
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			response += chunk;
			if (!owner.token.startsWith(response) || response.length > owner.token.length) finish(false);
		});
		socket.once("end", () => finish(response === owner.token));
		socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code !== "ECONNREFUSED"));
	});
}

function sameIdentity(file: { dev: number; ino: number }, identity: LeaseIdentity): boolean {
	return file.dev === identity.device && file.ino === identity.inode;
}

function validLeaseOwner(value: unknown): value is LeaseOwner {
	if (!value || typeof value !== "object") return false;
	const owner = value as Partial<LeaseOwner>;
	return typeof owner.token === "string" && /^[0-9a-f-]{36}$/i.test(owner.token)
		&& typeof owner.sessionId === "string" && typeof owner.pid === "number" && owner.pid > 0
		&& typeof owner.createdAt === "string" && Number.isFinite(Date.parse(owner.createdAt))
		&& typeof owner.port === "number" && Number.isInteger(owner.port) && owner.port > 0 && owner.port <= 65_535;
}

export class FileMonitorLease implements MonitorLease {
	private path: string | undefined;
	private identity: LeaseIdentity | undefined;
	private server: Server | undefined;
	private acquiring = false;
	private readonly directory: string;
	private readonly now: () => number;
	private readonly resourceName: string;

	constructor(options: MonitorLeaseOptions) {
		this.directory = options.directory;
		this.now = options.now ?? Date.now;
		this.resourceName = options.resourceName?.trim() || "monitor";
	}

	async acquire(key: string, sessionId: string): Promise<void> {
		if (this.acquiring || this.path || this.identity || this.server) {
			throw new Error(`This ${this.resourceName} lease already owns or is acquiring a target`);
		}
		this.acquiring = true;
		try {
			await this.acquireOnce(key, sessionId);
		} finally {
			this.acquiring = false;
		}
	}

	async release(): Promise<void> {
		const path = this.path;
		const identity = this.identity;
		const server = this.server;
		this.path = undefined;
		this.identity = undefined;
		this.server = undefined;
		if (!path || !identity) {
			if (server) await closeServer(server);
			return;
		}

		const releasePath = `${path}.release-${randomUUID()}`;
		let ownsReleasePath = false;
		try {
			const current = await lstat(path).catch(() => undefined);
			if (!current || !current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, identity)) return;
			await rename(path, releasePath);
			const moved = await lstat(releasePath);
			ownsReleasePath = moved.isDirectory() && !moved.isSymbolicLink() && sameIdentity(moved, identity);
			if (ownsReleasePath) await this.releasePathMoved();
		} finally {
			if (server) await closeServer(server);
		}
		if (!ownsReleasePath) return;
		await unlink(join(releasePath, "owner.json")).catch(() => undefined);
		await rmdir(releasePath).catch(() => undefined);
	}

	protected async releasePathMoved(): Promise<void> {}

	private async acquireOnce(key: string, sessionId: string): Promise<void> {
		const digest = createHash("sha256").update(key).digest("hex");
		const path = join(this.directory, `${digest}.lock`);
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				await mkdir(path, { mode: 0o700 });
				await this.publish(path, sessionId);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				const inspected = await this.inspect(path);
				if (!inspected) throw new Error(`This ${this.resourceName} is already owned by another Pi process`);
				if (inspected.owner && await leaseOwnerIsLive(inspected.owner)) {
					throw new Error(`This ${this.resourceName} is already owned by Pi process ${inspected.owner.pid}`);
				}
				if (!inspected.owner && this.now() - inspected.mtimeMs < MALFORMED_LEASE_GRACE_MS) {
					throw new Error(`This ${this.resourceName} is already owned by another Pi process`);
				}
				await this.removeStale(path, inspected.identity);
			}
		}
		throw new Error(`Could not acquire the ${this.resourceName} lease`);
	}

	private async publish(path: string, sessionId: string): Promise<void> {
		const directory = await lstat(path);
		if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Monitor lease path is not a directory");
		const identity = { device: directory.dev, inode: directory.ino };
		const owner: LeaseOwner = {
			token: randomUUID(),
			sessionId,
			pid: process.pid,
			createdAt: new Date(this.now()).toISOString(),
			port: 0,
		};
		let server: Server | undefined;
		try {
			const listening = await startLeaseServer(owner.token);
			server = listening.server;
			owner.port = listening.port;
			const handle = await open(join(path, "owner.json"), "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(owner), "utf8");
			} finally {
				await handle.close();
			}
			const [latestDirectory, ownerFile] = await Promise.all([lstat(path), lstat(join(path, "owner.json"))]);
			if (!latestDirectory.isDirectory() || latestDirectory.isSymbolicLink() || !sameIdentity(latestDirectory, identity)
				|| !ownerFile.isFile() || ownerFile.isSymbolicLink()) throw new Error("Monitor lease changed while it was being published");
			this.path = path;
			this.identity = identity;
			this.server = server;
		} catch (error) {
			if (server) await closeServer(server);
			await unlink(join(path, "owner.json")).catch(() => undefined);
			await rmdir(path).catch(() => undefined);
			throw error;
		}
	}

	private async inspect(path: string): Promise<{ identity: LeaseIdentity; mtimeMs: number; owner?: LeaseOwner } | undefined> {
		const directory = await lstat(path).catch(() => undefined);
		if (!directory || !directory.isDirectory() || directory.isSymbolicLink()) return undefined;
		let owner: LeaseOwner | undefined;
		try {
			const file = await lstat(join(path, "owner.json"));
			if (file.isFile() && !file.isSymbolicLink()) {
				const parsed = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as unknown;
				if (validLeaseOwner(parsed)) owner = parsed;
			}
		} catch {
			// A competing process may still be publishing the owner record.
		}
		return { identity: { device: directory.dev, inode: directory.ino }, mtimeMs: directory.mtimeMs, ...(owner ? { owner } : {}) };
	}

	private async removeStale(path: string, identity: LeaseIdentity): Promise<void> {
		const current = await lstat(path).catch(() => undefined);
		if (!current || !current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, identity)) return;
		await unlink(join(path, "owner.json")).catch(() => undefined);
		await rmdir(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
		});
	}
}
