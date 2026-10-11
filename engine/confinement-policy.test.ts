import { expect, test } from "bun:test";
import { parseConfinementPolicy } from "./confinement-policy.ts";

test("declarations normalize duplicates into an immutable bounded policy", () => {
	const policy = parseConfinementPolicy({
		dependencyHosts: ["proxy.golang.org", "sum.golang.org", "proxy.golang.org"],
		nonSecretExamples: [".env.example", ".env.example"],
	});
	expect(policy).toEqual({
		dependencyHosts: ["proxy.golang.org", "sum.golang.org"],
		nonSecretExamples: [".env.example"],
	});
	expect(Object.isFrozen(policy)).toBe(true);
	expect(Object.isFrozen(policy.dependencyHosts)).toBe(true);
	expect(Object.isFrozen(policy.nonSecretExamples)).toBe(true);
});

test("an explicit empty declaration grants no hosts or exemptions", () => {
	expect(
		parseConfinementPolicy({ dependencyHosts: [], nonSecretExamples: [] }),
	).toEqual({ dependencyHosts: [], nonSecretExamples: [] });
});

test.each(
	[
		null,
		[],
		"invalid",
		{},
		{ dependencyHosts: [] },
		{ nonSecretExamples: [] },
		{ dependencyHosts: "proxy.golang.org", nonSecretExamples: [] },
		{ dependencyHosts: [42], nonSecretExamples: [] },
		{ dependencyHosts: [], nonSecretExamples: [null] },
		{ dependencyHosts: [], nonSecretExamples: [], extra: true },
		{ dependencyHosts: ["*"], nonSecretExamples: [] },
		{ dependencyHosts: ["*.golang.org"], nonSecretExamples: [] },
		{ dependencyHosts: ["https://proxy.golang.org"], nonSecretExamples: [] },
		{ dependencyHosts: ["unknown.example"], nonSecretExamples: [] },
	].map((value) => ({ value })),
)("rejects malformed or unsupported declaration %j", ({ value }) => {
	expect(() => parseConfinementPolicy(value)).toThrow(
		"Invalid confinement declaration",
	);
});

test.each([
	".env",
	"../.env.example",
	"/tmp/.env.example",
	"src/.env.example",
	".env.*",
	".env.example/secret",
])("rejects unsafe example name %s", (file) => {
	expect(() =>
		parseConfinementPolicy({ dependencyHosts: [], nonSecretExamples: [file] }),
	).toThrow("examples must be root");
});

test("supports only explicit exact public registry hosts and root example names", () => {
	const policy = parseConfinementPolicy({
		dependencyHosts: [
			"registry.npmjs.org",
			"proxy.golang.org",
			"sum.golang.org",
			"storage.googleapis.com",
		],
		nonSecretExamples: [".env.example", ".env.public_sample"],
	});
	expect(policy.dependencyHosts).toHaveLength(4);
	expect(policy.nonSecretExamples).toEqual([
		".env.example",
		".env.public_sample",
	]);
});
