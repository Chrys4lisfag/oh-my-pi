import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Exercise the shipped batch/PowerShell entrypoint against disposable build tools.
// Never rebuild the real checkout or replace the user's installation from tests.
const windows = process.platform === "win32" ? describe : describe.skip;
windows("Windows source replacement", () => {
	let root: string;
	let tool: string;
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp source replacement "));
		tool = path.join(root, "fixture.exe");
		const source = path.join(root, "fixture.cs");
		await Bun.write(
			source,
			`using System;
using System.IO;
class Fixture {
 static int Main(string[] args) {
  string stage = args.Length > 0 ? args[0] : "";
  if (stage == "run") stage = args[1];
  if (stage == "--smoke-test") stage = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\').EndsWith("bin") ? "installed" : "candidate";
  if (stage == "-y") {
   if (String.Join(" ", args) != "-y --profile minimal --default-toolchain none") return 24;
   if (stage == Environment.GetEnvironmentVariable("OMP_REPLACE_TEST_FAIL")) return 23;
   string bin = Path.Combine(Environment.GetEnvironmentVariable("CARGO_HOME"), "bin");
   Directory.CreateDirectory(bin);
   File.Copy(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName, Path.Combine(bin, "cargo.exe"), true);
  }
  if (stage == Environment.GetEnvironmentVariable("OMP_REPLACE_TEST_FAIL")) return 23;
  if (stage == "build:native") {
   Directory.CreateDirectory("packages/natives/native");
   File.WriteAllText("packages/natives/native/pi_natives.win32-x64-modern.node", "new native");
  }
  if (stage == "build") {
   Directory.CreateDirectory("dist");
   File.Copy(System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName, "dist/omp.exe", true);
  }
  return 0;
 }
}`,
		);
		const script = path.join(root, "compile.ps1");
		await Bun.write(
			script,
			"param($Source, $Output)\n$ErrorActionPreference='Stop'\nAdd-Type -Path $Source -OutputAssembly $Output -OutputType ConsoleApplication\n",
		);
		const child = Bun.spawn(
			["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, source, tool],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		if (code !== 0) throw new Error(`${out}\n${err}`);
	}, 30_000);
	afterAll(async () => {
		if (root) await fs.rm(root, { recursive: true, force: true });
	});

	async function run(failure?: string) {
		const dir = await fs.mkdtemp(path.join(root, "checkout with spaces "));
		const bin = path.join(dir, "bin");
		const native = path.join(dir, "packages/natives/native/pi_natives.win32-x64-modern.node");
		const build = path.join(dir, "packages/coding-agent/dist/omp.exe");
		const installed = path.join(bin, "omp.exe");
		await fs.mkdir(bin, { recursive: true });
		for (const name of ["bun", "git", "cargo"]) await fs.copyFile(tool, path.join(bin, `${name}.exe`));
		await Bun.write(native, "old native");
		await Bun.write(build, "old build");
		await Bun.write(installed, "old install");
		await Bun.write(
			path.join(dir, "replace_global.bat"),
			Bun.file(path.join(import.meta.dir, "../replace_global.bat")),
		);
		await Bun.write(
			path.join(dir, "scripts/replace-global.ps1"),
			Bun.file(path.join(import.meta.dir, "replace-global.ps1")),
		);
		await Bun.write(
			path.join(dir, "scripts/windows-rust.ps1"),
			Bun.file(path.join(import.meta.dir, "windows-rust.ps1")),
		);
		const child = Bun.spawn(["cmd.exe", "/d", "/c", "replace_global.bat"], {
			cwd: dir,
			env: {
				...process.env,
				PATH: `${bin};${process.env.PATH}`,
				BUN_INSTALL: dir,
				CROSS_TARGET: "",
				OMP_REPLACE_TEST_FAIL: failure ?? "",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { dir, native, build, installed, code, output: `${out}\n${err}` };
	}

	test("replaces the PATH executable only after smoke verification and keeps a rollback copy", async () => {
		const result = await run();
		expect(result.code).toBe(0);
		expect(await Bun.file(result.installed).arrayBuffer()).toEqual(await Bun.file(tool).arrayBuffer());
		expect(await Bun.file(result.native).text()).toBe("new native");
		const backup = (await fs.readdir(path.dirname(result.installed))).find(name =>
			name.startsWith("omp.before-source-build-"),
		);
		expect(backup).toBeDefined();
		expect(await Bun.file(path.join(path.dirname(result.installed), backup!)).text()).toBe("old install");
	}, 30_000);

	for (const mode of ["existing", "install", "bad-checksum", "installer-error"]) {
		test(`Rust bootstrap handles ${mode} without user input`, async () => {
			const dir = await fs.mkdtemp(path.join(root, "rust bootstrap "));
			const cargoHome = path.join(dir, "cargo home");
			const cargo = path.join(cargoHome, "bin/cargo.exe");
			if (mode === "existing") {
				await fs.mkdir(path.dirname(cargo), { recursive: true });
				await fs.copyFile(tool, cargo);
			}
			const system = process.env.SystemRoot ?? "C:\\Windows";
			const child = Bun.spawn(
				[
					path.join(system, "System32/WindowsPowerShell/v1.0/powershell.exe"),
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					path.join(import.meta.dir, "test-fixtures/windows-rust.ps1"),
					path.join(import.meta.dir, "windows-rust.ps1"),
					tool,
					mode,
				],
				{
					env: {
						...process.env,
						PATH: path.join(system, "System32"),
						CARGO_HOME: cargoHome,
						OMP_REPLACE_TEST_FAIL: mode === "installer-error" ? "-y" : "",
					},
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [out, err, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (mode === "existing" || mode === "install") {
				expect(code).toBe(0);
				expect(out).toContain("cargo-ready");
				expect(await Bun.file(cargo).arrayBuffer()).toEqual(await Bun.file(tool).arrayBuffer());
			} else {
				expect(code).toBe(1);
				expect(`${out}${err}`).toContain(mode === "bad-checksum" ? "SHA256 mismatch" : "exited with code 23");
				expect(await Bun.file(cargo).exists()).toBe(false);
			}
		}, 30_000);
	}

	for (const failure of ["install", "build:native", "build", "candidate", "installed"]) {
		test(`preserves installed OMP and restores artifacts when ${failure} fails`, async () => {
			const result = await run(failure);
			expect(result.code).toBe(1);
			expect(result.output).toContain("exited with code 23");
			expect(await Bun.file(result.installed).text()).toBe("old install");
			expect(await Bun.file(result.native).text()).toBe("old native");
			expect(await Bun.file(result.build).text()).toBe("old build");
		}, 30_000);
	}
});
