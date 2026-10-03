import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	SandboxManager,
	type SandboxRuntimeConfig,
	SandboxRuntimeConfigSchema,
} from "@anthropic-ai/sandbox-runtime";
import {
	type BashOperations,
	createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";

/** The filesystem and network channels one implementer task needs. */
export interface TaskConfinementNeeds {
	/** Existing root of the task's Ticket worktree. */
	worktree: string;
	/** Existing worktree-relative paths the task may write. */
	writablePaths: string[];
	/** Hostnames (optionally with srt wildcards/ports) the task may reach. */
	allowedDomains: string[];
	/** Explicit examples from the immutable Maintainer declaration. */
	nonSecretExamples?: readonly string[];
}

const TOOL_DIRECTORIES = {
	TMPDIR: "tmp",
	GOTMPDIR: "tmp",
	GOCACHE: "go-build",
	GOMODCACHE: "go-mod",
	XDG_CACHE_HOME: "cache",
	XDG_CONFIG_HOME: "config",
	GOPATH: "go-path",
} as const;

const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"SHELL",
	"USER",
	"LOGNAME",
	"TERM",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
] as const;

function unique<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function isInside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !path.isAbsolute(relative))
	);
}

function resolveWritablePath(worktree: string, entry: string): string {
	if (path.isAbsolute(entry)) {
		throw new Error(`Confinement writable path must be relative: ${entry}`);
	}
	const lexicalPath = path.resolve(worktree, entry);
	if (!isInside(worktree, lexicalPath)) {
		throw new Error(
			`Confinement writable path must stay inside the worktree: ${entry}`,
		);
	}
	let realPath: string;
	try {
		realPath = fs.realpathSync(lexicalPath);
	} catch {
		throw new Error(`Confinement writable path must already exist: ${entry}`);
	}
	if (!isInside(worktree, realPath)) {
		throw new Error(
			`Confinement writable path must resolve inside the worktree: ${entry}`,
		);
	}
	return realPath;
}

function sensitiveReadPaths(worktree: string): string[] {
	const home = os.homedir();
	return [
		path.join(home, ".ssh"),
		path.join(home, ".aws"),
		path.join(home, ".gnupg"),
		path.join(home, ".config", "gh"),
		path.join(home, ".gitconfig"),
		path.join(home, ".git-credentials"),
		path.join(home, ".netrc"),
		path.join(worktree, ".env"),
		path.join(worktree, ".env.*"),
	];
}

const SAFE_GIT_ENV = {
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
};

function isolatedGit(worktree: string, args: string[]): string {
	return execFileSync("git", args, {
		cwd: worktree,
		env: { PATH: process.env.PATH, ...SAFE_GIT_ENV },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

function declaredExamplePaths(
	worktree: string,
	declarations: readonly string[],
): string[] {
	return unique([...declarations]).map((file) => {
		if (!/^\.env\.[a-zA-Z0-9_-]+$/.test(file))
			throw new Error(`Invalid non-secret example declaration: ${file}`);
		const example = path.join(worktree, file);
		const stat = fs.lstatSync(example);
		const entry = isolatedGit(worktree, ["ls-files", "--stage", "--", file]);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			!/^100(?:644|755) [0-9a-f]+ 0\t/.test(entry) ||
			entry.trimEnd().split("\t")[1] !== file
		)
			throw new Error(
				`Declared example must be a tracked regular file without aliases: ${file}`,
			);
		return example;
	});
}

/**
 * Compile one task's declared needs to srt's allow-only policy. Paths are
 * realpathed so a worktree symlink cannot widen the writable boundary.
 */
export function compileConfinementConfig(
	needs: TaskConfinementNeeds,
): SandboxRuntimeConfig {
	const knownKeys = new Set([
		"worktree",
		"writablePaths",
		"allowedDomains",
		"nonSecretExamples",
	]);
	const unknownKeys = Object.keys(needs).filter((key) => !knownKeys.has(key));
	if (unknownKeys.length > 0) {
		throw new Error(
			`Invalid confinement needs: unknown keys ${unknownKeys.join(", ")}`,
		);
	}

	let worktree: string;
	try {
		worktree = fs.realpathSync(needs.worktree);
	} catch {
		throw new Error(
			`Invalid confinement needs: worktree does not exist: ${needs.worktree}`,
		);
	}
	const examples = declaredExamplePaths(
		worktree,
		needs.nonSecretExamples ?? [],
	);
	if (fs.existsSync(path.join(worktree, ".git"))) {
		const tracked = isolatedGit(worktree, [
			"ls-files",
			"-z",
			"--",
			".env",
			".env.*",
		])
			.split("\0")
			.filter(Boolean);
		const protectedFiles = tracked.filter(
			(entry) => !examples.includes(path.join(worktree, entry)),
		);
		if (protectedFiles.length > 0) {
			throw new Error(
				`Confinement cannot mask tracked protected file(s) without breaking Git: ${protectedFiles.join(", ")}. Remove secrets from tracking before starting a Run; non-secret examples require an explicit Maintainer declaration.`,
			);
		}
	}
	const candidate = {
		network: {
			allowedDomains: unique(needs.allowedDomains),
			deniedDomains: [],
			strictAllowlist: true,
		},
		filesystem: {
			denyRead: sensitiveReadPaths(worktree),
			allowRead: examples,
			allowWrite: unique(
				needs.writablePaths.map((entry) =>
					resolveWritablePath(worktree, entry),
				),
			),
			denyWrite: [],
		},
	};
	const parsed = SandboxRuntimeConfigSchema.safeParse(candidate);
	if (!parsed.success) {
		const reason = parsed.error.issues
			.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
			.join("; ");
		throw new Error(`Invalid confinement needs: ${reason}`);
	}
	return parsed.data;
}

function confinedEnvironment(
	parent: NodeJS.ProcessEnv | undefined,
	scratch: string,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const name of ENV_ALLOWLIST) {
		const value = parent?.[name];
		if (value !== undefined && value !== "") env[name] = value;
	}
	return {
		...env,
		...Object.fromEntries(
			Object.entries(TOOL_DIRECTORIES).map(([name, directory]) => [
				name,
				path.join(scratch, directory),
			]),
		),
		GOENV: "off",
		GOTELEMETRY: "off",
		GOPROXY: "https://proxy.golang.org",
		GOSUMDB: "sum.golang.org",
		GOTOOLCHAIN: "local",
		...SAFE_GIT_ENV,
	};
}

function removeScratch(root: string): void {
	// Go module directories are read-only. Never follow tool-created symlinks.
	function makeRemovable(directory: string): void {
		if (!fs.lstatSync(directory).isDirectory()) return;
		fs.chmodSync(directory, 0o700);
		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (entry.isDirectory()) makeRemovable(path.join(directory, entry.name));
		}
	}
	if (fs.existsSync(root)) makeRemovable(root);
	fs.rmSync(root, { recursive: true, force: true });
}

export type SandboxRuntimePort = Pick<
	typeof SandboxManager,
	| "initialize"
	| "wrapWithSandbox"
	| "annotateStderrWithSandboxFailures"
	| "cleanupAfterCommand"
	| "reset"
>;

export interface TaskConfinement {
	readonly config: SandboxRuntimeConfig;
	/** Pass to createBashToolDefinition as its operations option. */
	readonly operations: BashOperations;
	dispose(): Promise<void>;
}

interface ConfinementDependencies {
	runtime?: SandboxRuntimePort;
	delegate?: BashOperations;
}

/**
 * Initialize srt for one task and return a BashOperations adapter. Every bash
 * tool invocation is wrapped immediately before the real process spawn.
 */
export async function createTaskConfinement(
	needs: TaskConfinementNeeds,
	dependencies: ConfinementDependencies = {},
): Promise<TaskConfinement> {
	const config = compileConfinementConfig(needs);
	const worktree = fs.realpathSync(needs.worktree);
	const runtime = dependencies.runtime ?? SandboxManager;
	const delegate = dependencies.delegate ?? createLocalBashOperations();
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "afk-task-tools-"));
	for (const directory of unique(Object.values(TOOL_DIRECTORIES))) {
		fs.mkdirSync(path.join(scratch, directory));
	}
	config.filesystem.allowWrite.push(scratch);
	config.filesystem.denyWrite.push("/tmp/claude", "/private/tmp/claude");
	try {
		await runtime.initialize(config, undefined, true);
	} catch (error) {
		try {
			await runtime.reset();
		} finally {
			removeScratch(scratch);
		}
		throw error;
	}
	let commandSequence = 0;
	let disposed = false;

	const operations: BashOperations = {
		exec: async (command, cwd, options) => {
			if (disposed) throw new Error("Task confinement is already disposed");
			// Never let an agent redirect a declared exemption to protected data
			// between bash invocations. Permissions themselves stay captured.
			declaredExamplePaths(worktree, needs.nonSecretExamples ?? []);
			let realCwd: string;
			try {
				realCwd = fs.realpathSync(cwd);
			} catch {
				throw new Error(`Confined spawn cwd does not exist: ${cwd}`);
			}
			if (!isInside(worktree, realCwd)) {
				throw new Error(
					`Confined spawn cwd is outside the task worktree: ${cwd}`,
				);
			}

			commandSequence += 1;
			const commandId = `afk-bash-${commandSequence}-${randomUUID()}`;
			// srt sets its own TMPDIR in the outer wrapper. Override it inside
			// the sandbox too, so cgo and other child tools use task-local space.
			const tmp = path.join(scratch, "tmp").replaceAll("'", `'"'"'`);
			const wrapped = await runtime.wrapWithSandbox(
				`export TMPDIR='${tmp}'; ${command}`,
				undefined,
				undefined,
				options.signal,
				{ commandId, commandText: command },
			);
			let output = "";
			try {
				const result = await delegate.exec(wrapped, realCwd, {
					...options,
					env: confinedEnvironment(options.env, scratch),
					onData: (chunk) => {
						output += chunk.toString();
						options.onData(chunk);
					},
				});
				const annotated = runtime.annotateStderrWithSandboxFailures(
					commandId,
					output,
				);
				const annotation = annotated.slice(output.length);
				if (annotation !== "") options.onData(Buffer.from(annotation));
				return result;
			} finally {
				runtime.cleanupAfterCommand();
			}
		},
	};

	return {
		config,
		operations,
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			try {
				await runtime.reset();
			} finally {
				removeScratch(scratch);
			}
		},
	};
}
