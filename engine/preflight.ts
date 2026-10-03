/**
 * Preflight's confinement capability check (ticket afk-kit #60, durable
 * spec #46): before any Claim, prove the sandbox runtime can initialize for
 * a probe task — execute tool scratch/Git checks and, for Go repositories,
 * cold dependency acquisition and a minimal build before Claim. The runtime is injectable at its port;
 * production uses the real srt manager, tests a fake (code-verify
 * standard, L2).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	compileConfinementConfig,
	createTaskConfinement,
	IMPLEMENTER_ALLOWED_DOMAINS,
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
 * Execute confined verification-environment probes for a scratch task. Any
 * failure — unsupported host, unusable policy — is the probe's negative
 * result, never a throw.
 */
export async function probeConfinementCapability(
	dependencies: { runtime?: ConfinementRuntimePort; repository?: string } = {},
): Promise<CapabilityProbe> {
	const dir = fs.mkdtempSync(
		path.join(os.tmpdir(), "afk-preflight-confinement-"),
	);
	try {
		const repository = dependencies.repository;
		if (repository) {
			compileConfinementConfig({
				worktree: repository,
				writablePaths: ["."],
				allowedDomains: [],
			});
			// Copy only public module metadata; never source secrets or host caches.
			for (const file of ["go.mod", "go.sum"]) {
				const source = path.join(repository, file);
				if (fs.existsSync(source))
					fs.copyFileSync(source, path.join(dir, file));
			}
		}
		const confinement: TaskConfinement = await createTaskConfinement(
			{
				worktree: dir,
				writablePaths: ["."],
				allowedDomains: [...IMPLEMENTER_ALLOWED_DOMAINS],
			},
			dependencies,
		);
		try {
			const go = fs.existsSync(path.join(dir, "go.mod"));
			if (go)
				fs.writeFileSync(
					path.join(dir, "probe_test.go"),
					'package probe\nimport "testing"\nfunc TestBuild(t *testing.T) {}\n',
				);
			const command =
				'touch "$TMPDIR/probe" "$GOCACHE/probe" && git config --global --list' +
				(go ? " && go version && go mod download && go test ./..." : "");
			let output = "";
			const result = await confinement.operations.exec(command, dir, {
				env: process.env,
				timeout: 120,
				onData: (chunk) => {
					output += chunk.toString();
				},
			});
			if (result.exitCode !== 0)
				throw new Error(
					`unsupported verification environment (exit ${String(result.exitCode)}): ${output.trim()}. Check sandbox prerequisites, installed Go/toolchain compatibility, registry access and any local module replacements.`,
				);
		} finally {
			await confinement.dispose();
		}
		return {
			ok: true,
			detail:
				"sandbox runtime executed tool-cache, temporary-directory and Git probes; Go module/build probe passed when declared",
		};
	} catch (error) {
		return {
			ok: false,
			detail: `sandbox runtime cannot initialize or verify tools: ${error instanceof Error ? error.message : String(error)}`,
		};
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}
