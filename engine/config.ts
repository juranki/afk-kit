/**
 * The Engine's pinned configuration and its validation (ticket afk-kit #60,
 * durable spec #46): the models, package-owned agent definitions, SDK
 * module, and executables a start depends on, checked by preflight before
 * any Claim. Models follow the flash-first routing (ADR 0004) and the
 * durable spec's session pinning; agent definitions live at exact package
 * paths — no discovery, shadowing, or runtime override.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ImplementationSkill } from "./runs/events.ts";

/** The pinned implementer model (durable spec #46, ADR 0004). */
const IMPLEMENTER_MODEL = "glm-5.3-flash";

/** The pinned Reviewer models — independent `glm-5.3` sessions. */
const REVIEWER_MODEL = "glm-5.3";

/** Executables a start requires on PATH. */
const PINNED_EXECUTABLES = ["git", "gh", "bun"] as const;

/**
 * The installed implementation skills an Implementer session mounts (ADR
 * 0015, ticket #75). The pin lives with the engine configuration and the
 * flash-first model pins (ADR 0004); preflight validates it beside the
 * agent definitions, as the named `implementation-skills` check.
 */
export const IMPLEMENTATION_SKILLS = [
	"implement",
	"tdd",
	"codebase-design",
] as const;

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
	/**
	 * Directory holding the installed skills (defaults to the SDK's own
	 * agent directory — the same set an attended session discovers).
	 */
	skillsRoot?: string;
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

/** Result of resolving the implementation skills pin. */
export interface ImplementationSkillsValidation {
	ok: boolean;
	problems: string[];
	/** The resolved records, in pin order; partial when not ok. */
	skills: ImplementationSkill[];
}

/**
 * The skills root the resolution consults: the injected root, or the SDK's
 * own agent directory — the engine sees exactly what an attended session
 * sees (ADR 0015). A missing SDK export is a reportable problem, not a
 * throw.
 */
async function defaultSkillsRoot(
	ports: ConfigPorts,
): Promise<{ root?: string; problem?: string }> {
	try {
		const sdk = (await (ports.sdkImport ?? defaultSdkImport)()) as {
			getAgentDir?: unknown;
		};
		if (typeof sdk.getAgentDir !== "function") {
			return {
				problem: "the SDK module exports no agent directory (getAgentDir)",
			};
		}
		return {
			root: path.join((sdk.getAgentDir as () => string)(), "skills"),
		};
	} catch (error) {
		return {
			problem: `SDK module not importable: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Resolve the implementation skills pin (ADR 0015): every pinned name must
 * resolve to a non-empty installed `SKILL.md` under the skills root, and
 * each resolution records the file's SHA-256 — the evidence of the precise
 * text the Implementer session will be given. Names every failure; never
 * throws.
 */
export async function resolveImplementationSkills(
	ports: ConfigPorts = {},
): Promise<ImplementationSkillsValidation> {
	const problems: string[] = [];
	const skills: ImplementationSkill[] = [];
	let root = ports.skillsRoot;
	if (root === undefined) {
		const defaulted = await defaultSkillsRoot(ports);
		if (defaulted.problem !== undefined) {
			problems.push(defaulted.problem);
			return { ok: false, problems, skills };
		}
		root = defaulted.root;
	}
	for (const name of IMPLEMENTATION_SKILLS) {
		const file = path.join(root, name, "SKILL.md");
		let body: Buffer;
		try {
			body = fs.readFileSync(file);
		} catch {
			problems.push(
				`implementation skill not installed: ${name} (no SKILL.md at ${file})`,
			);
			continue;
		}
		if (body.length === 0) {
			problems.push(`implementation skill is empty: ${name} (${file})`);
			continue;
		}
		skills.push({
			name,
			path: file,
			sha256: createHash("sha256").update(body).digest("hex"),
		});
	}
	return { ok: problems.length === 0, problems, skills };
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
