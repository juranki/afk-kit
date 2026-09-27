#!/usr/bin/env bun

/**
 * Live srt upgrade gate. Requires Linux host prerequisites (bubblewrap, socat,
 * ripgrep, curl) and outbound HTTPS. This is intentionally separate from the
 * deterministic test sweep; run it whenever the exact srt pin changes.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { createTaskConfinement } from "../engine/confinement.ts";

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

const confinement = await createTaskConfinement({
	worktree,
	writablePaths: ["."],
	allowedDomains: ["example.com"],
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

	const deniedRead = await probe("cat .env");
	requireProbe(
		"refuse sensitive read",
		deniedRead,
		(result) =>
			result.exitCode !== 0 && !result.output.includes("must-not-read"),
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

	const exitCode = await probe("exit 7");
	requireProbe(
		"preserve normal exit code",
		exitCode,
		(result) => result.exitCode === 7,
	);
} finally {
	await confinement.dispose();
	fs.rmSync(root, { recursive: true, force: true });
}
