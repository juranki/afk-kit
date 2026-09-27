/**
 * Preflight's confinement capability check (ticket afk-kit #60, durable
 * spec #46): before any Claim, prove the sandbox runtime can initialize for
 * a probe task — compile an allow-only policy for a scratch worktree,
 * initialize the runtime, and reset. The runtime is injectable at its port;
 * production uses the real srt manager, tests a fake (code-verify
 * standard, L2).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createTaskConfinement,
	type SandboxRuntimePort,
	type TaskConfinement,
} from "./confinement.ts";

/**
 * The slice of the srt port a start depends on — the same shape
 * `createTaskConfinement` accepts as its injected runtime.
 */
export type ConfinementRuntimePort = SandboxRuntimePort;

export interface CapabilityProbe {
	ok: boolean;
	detail: string;
}

/**
 * Initialize and reset the confinement runtime for a probe task. Any
 * failure — unsupported host, unusable policy — is the probe's negative
 * result, never a throw.
 */
export async function probeConfinementCapability(
	dependencies: { runtime?: ConfinementRuntimePort } = {},
): Promise<CapabilityProbe> {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "afk-preflight-confinement-"),
	);
	try {
		const confinement: TaskConfinement = await createTaskConfinement(
			{ worktree: dir, writablePaths: ["."], allowedDomains: [] },
			dependencies,
		);
		await confinement.dispose();
		return {
			ok: true,
			detail: "sandbox runtime initialized and reset for a probe task",
		};
	} catch (error) {
		return {
			ok: false,
			detail: `sandbox runtime cannot initialize: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
