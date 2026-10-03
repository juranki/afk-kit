#!/usr/bin/env bun

/**
 * Live srt upgrade gate. Requires Linux host prerequisites (bubblewrap, socat,
 * ripgrep, curl) and outbound HTTPS. This is intentionally separate from the
 * deterministic test sweep; run it whenever the exact srt pin changes.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
	createTaskConfinement,
	IMPLEMENTER_ALLOWED_DOMAINS,
} from "../engine/confinement.ts";

import { probeConfinementCapability } from "../engine/preflight.ts";

interface ProbeResult {
	exitCode: number | null;
	output: string;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireProbe(
	name: string,
	result: ProbeResult,
	accept: (result: ProbeResult) => boolean,
): void {
	if (!accept(result)) {
		throw new Error(
			`${name} failed (exit ${String(result.exitCode)}):\n${result.output}`,
		);
	}
	console.log(`PASS ${name}`);
}

const dependencies = SandboxManager.checkDependencies();
if (dependencies.errors.length > 0) {
	throw new Error(
		`Sandbox prerequisites missing:\n${dependencies.errors.join("\n")}`,
	);
}
for (const warning of dependencies.warnings) console.warn(`WARN ${warning}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "afk-confinement-smoke-"));
const worktree = path.join(root, "worktree");
const outside = path.join(root, "outside.txt");
fs.mkdirSync(worktree);
fs.writeFileSync(path.join(worktree, ".env"), "SMOKE_SECRET=must-not-read\n");
fs.writeFileSync(
	path.join(worktree, ".env.example"),
	"PUBLIC_EXAMPLE=placeholder\n",
);
execFileSync("git", ["init", "-q", worktree]);
execFileSync("git", ["-C", worktree, "add", ".env.example"]);
execFileSync("git", [
	"-C",
	worktree,
	"-c",
	"user.name=Fixture",
	"-c",
	"user.email=fixture@example.com",
	"commit",
	"-qm",
	"fixture",
]);
fs.writeFileSync(
	path.join(worktree, ".gitignore"),
	".env*\n!.env.example\nallowed.txt\ngo.sum\n",
);
fs.writeFileSync(
	path.join(worktree, ".env.local"),
	"LOCAL_SECRET=must-not-read\n",
);
fs.writeFileSync(
	path.join(worktree, "go.mod"),
	"module fixture\n\ngo 1.20\n\nrequire github.com/google/uuid v1.6.0\n",
);
fs.writeFileSync(
	path.join(worktree, "fixture_test.go"),
	`package fixture
import (
 "testing"
 "github.com/google/uuid"
)
func TestDependency(t *testing.T) { if len(uuid.NewString()) != 36 { t.Fatal("invalid uuid") } }
`,
);
execFileSync("git", [
	"-C",
	worktree,
	"add",
	".gitignore",
	"go.mod",
	"fixture_test.go",
]);
execFileSync("git", [
	"-C",
	worktree,
	"-c",
	"user.name=Fixture",
	"-c",
	"user.email=fixture@example.com",
	"commit",
	"-qm",
	"Go fixture",
]);

const confinement = await createTaskConfinement({
	worktree,
	writablePaths: ["."],
	allowedDomains: ["example.com", ...IMPLEMENTER_ALLOWED_DOMAINS],
});

async function probe(command: string): Promise<ProbeResult> {
	let output = "";
	const result = await confinement.operations.exec(command, worktree, {
		onData: (chunk) => {
			output += chunk.toString();
		},
		env: process.env,
	});
	return { exitCode: result.exitCode, output };
}

try {
	const inside = await probe("printf inside > allowed.txt");
	requireProbe(
		"write inside worktree",
		inside,
		(result) =>
			result.exitCode === 0 &&
			fs.readFileSync(path.join(worktree, "allowed.txt"), "utf8") === "inside",
	);

	const outsideWrite = await probe(`printf escaped > ${shellQuote(outside)}`);
	requireProbe(
		"refuse write outside worktree",
		outsideWrite,
		(result) => result.exitCode !== 0 && !fs.existsSync(outside),
	);

	const deniedRead = await probe("cat .env .env.local");
	requireProbe(
		"refuse sensitive read",
		deniedRead,
		(result) =>
			result.exitCode !== 0 && !result.output.includes("must-not-read"),
	);

	const git = await probe(
		"git status --porcelain && git diff --exit-code && git config --global --list",
	);
	requireProbe(
		"tracked example and isolated Git config stay clean",
		git,
		(result) => result.exitCode === 0 && result.output.trim() === "",
	);

	const allowedNetwork = await probe(
		"curl --silent --show-error --output /dev/null --write-out '%{http_code}' https://example.com",
	);
	requireProbe(
		"reach allowlisted domain",
		allowedNetwork,
		(result) => result.exitCode === 0 && /^2\d\d$/.test(result.output.trim()),
	);

	const deniedNetwork = await probe(
		"curl --silent --show-error --output /dev/null https://ifconfig.me",
	);
	requireProbe(
		"refuse non-allowlisted domain",
		deniedNetwork,
		(result) => result.exitCode !== 0,
	);

	const temp = await probe(
		'touch "$TMPDIR/writable" "$GOCACHE/writable"; printf "%s\\n" "$TMPDIR" "$GOCACHE" "$GOMODCACHE"',
	);
	requireProbe(
		"designated caches and temp are writable outside the worktree",
		temp,
		(result) =>
			result.exitCode === 0 &&
			result.output
				.trim()
				.split("\n")
				.every((entry) =>
					confinement.config.filesystem.allowWrite.some(
						(root) => root !== worktree && entry.startsWith(`${root}/`),
					),
				),
	);

	const go = await probe("go test -mod=mod ./...");
	requireProbe(
		"cold Go dependency and verification",
		go,
		(result) => result.exitCode === 0,
	);
	const clean = await probe("git status --porcelain && git diff --exit-code");
	requireProbe(
		"Go caches do not dirty the tracked worktree",
		clean,
		(result) => result.exitCode === 0 && result.output.trim() === "",
	);

	const exitCode = await probe("exit 7");
	requireProbe(
		"preserve normal exit code",
		exitCode,
		(result) => result.exitCode === 7,
	);

	await confinement.dispose();
	const ready = await probeConfinementCapability({ repository: worktree });
	if (!ready.ok) throw new Error(ready.detail);
	console.log("PASS Preflight checks Go acquisition and build before a cycle");
	fs.writeFileSync(
		path.join(worktree, "go.mod"),
		"module fixture\n\ngo 999.0\n",
	);
	const unsupported = await probeConfinementCapability({
		repository: worktree,
	});
	if (unsupported.ok || !unsupported.detail.includes("toolchain compatibility"))
		throw new Error("Preflight accepted unsupported Go toolchain");
	console.log(
		"PASS Preflight rejects unsupported Go with actionable diagnostics",
	);

	// A similarly named but untracked file gets no example exemption.
	execFileSync("git", ["-C", worktree, "rm", "--cached", ".env.example"]);
	fs.writeFileSync(
		path.join(worktree, ".env.example"),
		"UNTRACKED_SECRET=must-not-read\n",
	);
	const untracked = await createTaskConfinement({
		worktree,
		writablePaths: ["."],
		allowedDomains: [],
	});
	try {
		let output = "";
		const result = await untracked.operations.exec(
			"cat .env.example",
			worktree,
			{
				env: process.env,
				onData: (chunk) => {
					output += chunk.toString();
				},
			},
		);
		requireProbe(
			"untracked examples remain protected",
			{ ...result, output },
			(probe) =>
				probe.exitCode !== 0 && !probe.output.includes("must-not-read"),
		);
	} finally {
		await untracked.dispose();
	}
} finally {
	await confinement.dispose();
	fs.rmSync(root, { recursive: true, force: true });
}
