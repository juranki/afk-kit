/**
 * The Engine's pinned configuration and its validation (ticket afk-kit #60,
 * durable spec #46): the models, package-owned agent definitions, SDK
 * module, and executables a start depends on, checked by preflight before
 * any Claim. Models follow the flash-first routing (ADR 0004) and the
 * durable spec's session pinning; agent definitions live at exact package
 * paths — no discovery, shadowing, or runtime override.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** The pinned implementer model (durable spec #46, ADR 0004). */
const IMPLEMENTER_MODEL = "glm-5.3-flash";

/** The pinned Reviewer models — independent `glm-5.3` sessions. */
const REVIEWER_MODEL = "glm-5.3";

/** Executables a start requires on PATH. */
const PINNED_EXECUTABLES = ["git", "gh", "bun"] as const;

/** One package-owned agent definition, loaded by exact package path. */
interface AgentDefinitionPin {
	role: "implementer" | "standards-reviewer" | "spec-reviewer";
	/** File name under the package's `engine/agents/` directory. */
	file: string;
	model: string;
}

/** The agent definitions a start pins, in the order preflight checks them. */
const AGENT_DEFINITIONS: readonly AgentDefinitionPin[] = [
	{ role: "implementer", file: "implementer.md", model: IMPLEMENTER_MODEL },
	{
		role: "standards-reviewer",
		file: "standards-reviewer.md",
		model: REVIEWER_MODEL,
	},
	{ role: "spec-reviewer", file: "spec-reviewer.md", model: REVIEWER_MODEL },
];

/** Injectable lookup ports; defaults consult the real host. */
export interface ConfigPorts {
	/** Directory holding the pinned agent definitions. */
	definitionsRoot?: string;
	/** The PATH to scan for executables (defaults to the process PATH). */
	pathEnv?: string;
	/** The SDK import to attempt (defaults to the pi coding agent package). */
	sdkImport?: () => Promise<unknown>;
}

/** True when some directory on `pathEnv` holds an executable `bin`. */
function executableOnPath(bin: string, pathEnv: string): boolean {
	for (const dir of pathEnv.split(path.delimiter)) {
		if (dir === "") continue;
		const candidate = path.join(dir, bin);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return true;
		} catch {
			// keep scanning
		}
	}
	return false;
}

/** The default SDK import, resolved lazily so failures stay reportable. */
function defaultSdkImport(): Promise<unknown> {
	return import("@earendil-works/pi-coding-agent");
}

export interface ConfigValidation {
	ok: boolean;
	problems: string[];
}

/**
 * Validate everything a start pins: agent definitions exist and are
 * non-empty at their exact package paths, the pinned model identifiers are
 * set, the SDK module imports, and every pinned executable is on PATH.
 */
export async function validateEngineConfig(
	ports: ConfigPorts = {},
): Promise<ConfigValidation> {
	const problems: string[] = [];

	const root = ports.definitionsRoot ?? path.join(import.meta.dir, "agents");
	for (const pin of AGENT_DEFINITIONS) {
		const file = path.join(root, pin.file);
		let body: string;
		try {
			body = fs.readFileSync(file, "utf8");
		} catch {
			problems.push(`${pin.role} definition missing: ${file}`);
			continue;
		}
		if (body.trim() === "") {
			problems.push(`${pin.role} definition is empty: ${file}`);
		}
		if (pin.model.trim() === "") {
			problems.push(`${pin.role} model pin is empty`);
		}
	}

	try {
		await (ports.sdkImport ?? defaultSdkImport)();
	} catch (error) {
		problems.push(
			`SDK module not importable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const pathEnv = ports.pathEnv ?? process.env.PATH ?? "";
	for (const bin of PINNED_EXECUTABLES) {
		if (!executableOnPath(bin, pathEnv)) {
			problems.push(`executable not found on PATH: ${bin}`);
		}
	}

	return { ok: problems.length === 0, problems };
}
