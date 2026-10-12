import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ConcourseConfig {
	target: string;
	team: string;
	resource: string;
	flyPath: string;
}

export function loadConcourseConfig(): { config?: ConcourseConfig; warning?: string } {
	const file = join(getAgentDir(), "pi-monitors.json");
	const invalid = (problem: string) => ({ warning: `Concourse monitoring is off: ${file} ${problem}` });
	let raw: string;
	let descriptor: number | undefined;
	try {
		descriptor = openSync(file, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) return invalid("must be a regular file");
		const maxBytes = 64 * 1024;
		if (stat.size > maxBytes) return invalid("must be at most 64 KiB");
		const buffer = Buffer.alloc(maxBytes + 1);
		let bytesRead = 0;
		while (bytesRead < buffer.length) {
			const count = readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
			if (count === 0) break;
			bytesRead += count;
		}
		if (bytesRead > maxBytes) return invalid("must be at most 64 KiB");
		raw = buffer.toString("utf8", 0, bytesRead);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		return invalid("could not be read");
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return invalid("must contain valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalid("must be an object");
	if (!Object.hasOwn(parsed, "concourse")) return {};
	const value = (parsed as Record<string, unknown>).concourse;
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("concourse must be an object");
	const fields = value as Record<string, unknown>;
	const unknownKey = Object.keys(fields).find((key) => !["target", "team", "resource", "flyPath"].includes(key));
	if (unknownKey !== undefined) {
		const key = unknownKey.replace(/[\p{Cc}\p{Cf}]/gu, "\uFFFD").slice(0, 128);
		return invalid(`concourse.${key} is an unknown key`);
	}
	const target = fields.target;
	const team = fields.team === undefined ? "main" : fields.team;
	const resource = fields.resource === undefined ? "repo" : fields.resource;
	const pattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
	for (const [key, field] of [["target", target], ["team", team], ["resource", resource]]) {
		if (typeof field !== "string" || !pattern.test(field)) {
			return invalid(`concourse.${key} must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`);
		}
	}
	const flyPath = fields.flyPath === undefined ? "/usr/local/bin/fly" : fields.flyPath;
	if (typeof flyPath !== "string" || !isAbsolute(flyPath)
		|| /[\p{Cc}\p{Cf}]/u.test(flyPath) || Buffer.byteLength(flyPath, "utf8") > 512) {
		return invalid("concourse.flyPath must be absolute, contain no control characters, and be at most 512 bytes");
	}
	return { config: { target: target as string, team: team as string, resource: resource as string, flyPath } };
}
