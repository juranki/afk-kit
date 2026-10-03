import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeConfinementCapability } from "./preflight.ts";

const runtime = {
	initialize: async () => {},
	wrapWithSandbox: async (_command: string) =>
		"printf 'unsupported verification environment'; exit 7",
	annotateStderrWithSandboxFailures: (_id: string, output: string) => output,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};

test("Preflight refuses when a confined verification-environment probe cannot execute", async () => {
	const result = await probeConfinementCapability({ runtime });
	expect(result.ok).toBe(false);
	expect(result.detail).toContain("unsupported verification environment");
});

test.each(["hardlink", "symlink"])(
	"Preflight never exempts a tracked example %s to protected contents",
	async (kind) => {
		const repository = fs.mkdtempSync(
			path.join(os.tmpdir(), "afk-preflight-alias-"),
		);
		try {
			execFileSync("git", ["init", "-q", repository]);
			fs.writeFileSync(path.join(repository, ".env"), "NEVER_EXPOSE_ME");
			if (kind === "hardlink")
				fs.linkSync(
					path.join(repository, ".env"),
					path.join(repository, ".env.example"),
				);
			else fs.symlinkSync(".env", path.join(repository, ".env.example"));
			execFileSync("git", ["-C", repository, "add", ".env.example"]);
			const result = await probeConfinementCapability({ repository, runtime });
			expect(result.detail).toContain("tracked protected file");
			expect(result.detail).not.toContain("NEVER_EXPOSE_ME");
		} finally {
			fs.rmSync(repository, { recursive: true, force: true });
		}
	},
);

test("Preflight refuses tracked secrets without reading or exposing their contents", async () => {
	const repository = fs.mkdtempSync(
		path.join(os.tmpdir(), "afk-preflight-test-"),
	);
	try {
		execFileSync("git", ["init", "-q", repository]);
		fs.writeFileSync(
			path.join(repository, ".env.production"),
			"NEVER_EXPOSE_ME",
		);
		execFileSync("git", ["-C", repository, "add", ".env.production"]);
		const result = await probeConfinementCapability({ repository, runtime });
		expect(result.ok).toBe(false);
		expect(result.detail).toContain("tracked protected file");
		expect(result.detail).not.toContain("NEVER_EXPOSE_ME");
	} finally {
		fs.rmSync(repository, { recursive: true, force: true });
	}
});
