import * as fs from "node:fs";
import * as path from "node:path";

/** Supported public registries; declarations select hosts, never wildcards. */
const PUBLIC_DEPENDENCY_HOSTS = new Set([
	"registry.npmjs.org",
	"proxy.golang.org",
	"sum.golang.org",
	"storage.googleapis.com",
]);

export interface ConfinementPolicy {
	readonly dependencyHosts: readonly string[];
	readonly nonSecretExamples: readonly string[];
}

export const CLOSED_CONFINEMENT_POLICY: ConfinementPolicy = Object.freeze({
	dependencyHosts: Object.freeze([]),
	nonSecretExamples: Object.freeze([]),
});

/** Read only regular, singly-linked public metadata inside the repository. */
export function readPublicRepositoryFile(
	repository: string,
	relative: string,
): Buffer | null {
	const root = fs.realpathSync(repository);
	const parts = relative.split("/");
	if (
		path.isAbsolute(relative) ||
		parts.some((part) => part === ".." || part === "." || part === "")
	)
		throw new Error(`Invalid public metadata path: ${relative}`);
	let current = root;
	for (const [index, part] of parts.entries()) {
		current = path.join(current, part);
		let stat: fs.Stats;
		try {
			stat = fs.lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		if (
			stat.isSymbolicLink() ||
			(index === parts.length - 1 && (!stat.isFile() || stat.nlink !== 1))
		)
			throw new Error(
				`Public metadata must not alias protected contents: ${relative}`,
			);
	}
	return fs.readFileSync(current);
}

/** Capture once from the primary checkout, never from delegated work. */
export function captureConfinementPolicy(
	repository: string,
): ConfinementPolicy {
	const body = readPublicRepositoryFile(repository, ".afk/confinement.json");
	if (body === null) return CLOSED_CONFINEMENT_POLICY;
	return parseConfinementPolicy(JSON.parse(body.toString("utf8")));
}

export function isNonSecretExampleName(file: string): boolean {
	return /^\.env\.[a-zA-Z0-9_-]+$/.test(file);
}

/** Pure declaration validation, separate from capture's filesystem boundary. */
export function parseConfinementPolicy(value: unknown): ConfinementPolicy {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid confinement declaration: expected an object");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).some(
			(key) => !["dependencyHosts", "nonSecretExamples"].includes(key),
		)
	)
		throw new Error("Invalid confinement declaration: unknown keys");
	const strings = (key: string): string[] => {
		const entries = record[key];
		if (
			!Array.isArray(entries) ||
			entries.some((entry) => typeof entry !== "string")
		)
			throw new Error(
				`Invalid confinement declaration: ${key} must be a string array`,
			);
		return [...new Set(entries as string[])];
	};
	const dependencyHosts = strings("dependencyHosts");
	const nonSecretExamples = strings("nonSecretExamples");
	if (dependencyHosts.some((host) => !PUBLIC_DEPENDENCY_HOSTS.has(host)))
		throw new Error(
			"Invalid confinement declaration: dependencyHosts must select exact supported public registry hosts",
		);
	if (nonSecretExamples.some((file) => !isNonSecretExampleName(file)))
		throw new Error(
			"Invalid confinement declaration: examples must be root .env.* filenames, never .env or escaping paths",
		);
	return Object.freeze({
		dependencyHosts: Object.freeze(dependencyHosts),
		nonSecretExamples: Object.freeze(nonSecretExamples),
	});
}
