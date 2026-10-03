import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { probeConfinementCapability } from "./preflight.ts";

const passingRuntime = {
	initialize: async () => {},
	wrapWithSandbox: async (command: string) => command,
	annotateStderrWithSandboxFailures: (_id: string, output: string) => output,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};

const runtime = {
	initialize: async () => {},
	wrapWithSandbox: async (_command: string) =>
		"printf 'unsupported verification environment'; exit 7",
	annotateStderrWithSandboxFailures: (_id: string, output: string) => output,
	cleanupAfterCommand: () => {},
	reset: async () => {},
};

test("Preflight rejects undeclared tracked examples and captures explicit repository permissions", async () => {
	const repository = fs.mkdtempSync(
		path.join(os.tmpdir(), "afk-preflight-policy-"),
	);
	try {
		execFileSync("git", ["init", "-q", repository]);
		fs.writeFileSync(
			path.join(repository, ".env.example"),
			"PUBLIC=placeholder",
		);
		execFileSync("git", ["-C", repository, "add", ".env.example"]);
		const undeclared = await probeConfinementCapability({
			repository,
			runtime: passingRuntime,
		});
		expect(undeclared.ok).toBe(false);
		fs.mkdirSync(path.join(repository, ".afk"));
		fs.writeFileSync(
			path.join(repository, ".afk/confinement.json"),
			JSON.stringify({
				dependencyHosts: ["proxy.golang.org"],
				nonSecretExamples: [".env.example"],
			}),
		);
		const declared = await probeConfinementCapability({
			repository,
			runtime: passingRuntime,
		});
		expect(declared.ok).toBe(true);
		expect(declared.policy).toEqual({
			dependencyHosts: ["proxy.golang.org"],
			nonSecretExamples: [".env.example"],
		});
		fs.writeFileSync(
			path.join(repository, ".afk/confinement.json"),
			JSON.stringify({
				dependencyHosts: ["evil.example"],
				nonSecretExamples: [".env.production"],
			}),
		);
		expect(declared.policy?.dependencyHosts).toEqual(["proxy.golang.org"]);
		expect(
			(
				await probeConfinementCapability({
					repository,
					runtime: passingRuntime,
				})
			).ok,
		).toBe(false);
	} finally {
		fs.rmSync(repository, { recursive: true, force: true });
	}
});

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
			fs.mkdirSync(path.join(repository, ".afk"));
			fs.writeFileSync(
				path.join(repository, ".afk/confinement.json"),
				JSON.stringify({
					dependencyHosts: [],
					nonSecretExamples: [".env.example"],
				}),
			);
			const result = await probeConfinementCapability({ repository, runtime });
			expect(result.detail).toContain("without aliases");
			expect(result.detail).not.toContain("NEVER_EXPOSE_ME");
		} finally {
			fs.rmSync(repository, { recursive: true, force: true });
		}
	},
);

test.each(["hardlink", "symlink"])(
	"Preflight does not copy a protected Go metadata %s into its readable fixture",
	async (kind) => {
		const repository = fs.mkdtempSync(
			path.join(os.tmpdir(), "afk-preflight-metadata-"),
		);
		try {
			fs.writeFileSync(path.join(repository, ".env"), "NEVER_EXPOSE_ME");
			if (kind === "hardlink")
				fs.linkSync(
					path.join(repository, ".env"),
					path.join(repository, "go.mod"),
				);
			else fs.symlinkSync(".env", path.join(repository, "go.mod"));
			const result = await probeConfinementCapability({
				repository,
				runtime: passingRuntime,
			});
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("must not alias protected contents");
			expect(result.detail).not.toContain("NEVER_EXPOSE_ME");
		} finally {
			fs.rmSync(repository, { recursive: true, force: true });
		}
	},
);

test.each([
	{ dependencyHosts: ["*"], nonSecretExamples: [] },
	{ dependencyHosts: ["https://proxy.golang.org"], nonSecretExamples: [] },
	{ dependencyHosts: [], nonSecretExamples: [".env"] },
	{ dependencyHosts: [], nonSecretExamples: ["../.env.example"] },
	{ dependencyHosts: [], nonSecretExamples: ["/tmp/.env.example"] },
	{ dependencyHosts: [], nonSecretExamples: [], extra: true },
])(
	"Preflight rejects invalid confinement declaration %j",
	async (declaration) => {
		const repository = fs.mkdtempSync(
			path.join(os.tmpdir(), "afk-preflight-invalid-"),
		);
		try {
			fs.mkdirSync(path.join(repository, ".afk"));
			fs.writeFileSync(
				path.join(repository, ".afk/confinement.json"),
				JSON.stringify(declaration),
			);
			const result = await probeConfinementCapability({
				repository,
				runtime: passingRuntime,
			});
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("Invalid confinement declaration");
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
