/**
 * Package managers create a command shim from the launcher's declared bin path. Executor 1 declared
 * `bin/executor`; Executor 2 declares `bin.mjs`. An upgrade that replaces the package without
 * relinking, such as `bun add executor@beta` run inside Bun's global directory, leaves the old shim
 * starting `bin/executor`, so the launcher must keep that path working.
 */
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Effect, FileSystem, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.NonEmptyString,
    bin: Schema.Struct({ executor: Schema.Literal("bin.mjs") }),
  }),
);

it.live("command shims for every npm launcher entry point start the installed CLI", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const processes = yield* ChildProcessSpawner.ChildProcessSpawner;
      const launcherArchive = path.resolve(yield* Config.String("EXECUTOR_E2E_LAUNCHER_ARCHIVE"));
      const runtimeArchive = path.resolve(yield* Config.String("EXECUTOR_E2E_RUNTIME_ARCHIVE"));
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "executor-npm-launcher-" });
      const modules = path.join(root, "node_modules");
      yield* fs.makeDirectory(modules);

      const run = (command: string, args: ReadonlyArray<string>, cwd: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const child = yield* processes.spawn(
              ChildProcess.make(command, args, {
                cwd,
                // Release scenarios never send product analytics, even from a build with a baked key.
                env: { DO_NOT_TRACK: "1" },
                extendEnv: true,
                stdout: "pipe",
                stderr: "pipe",
              }),
            );
            const [code, stdout, stderr] = yield* Effect.all(
              [
                child.exitCode,
                child.stdout.pipe(Stream.decodeText(), Stream.mkString),
                child.stderr.pipe(Stream.decodeText(), Stream.mkString),
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.timeout("60 seconds"));
            return { code: Number(code), stdout: stdout.trim(), stderr };
          }),
        );
      // Unpack as npm lays out an install: each archive's package/ becomes node_modules/<name>.
      const unpack = Effect.fnUntraced(function* (archive: string, name: string) {
        const staging = path.join(root, `unpack-${name}`);
        yield* fs.makeDirectory(staging);
        yield* fs.copyFile(archive, path.join(staging, "package.tgz"));
        // A relative archive path: GNU tar on Windows reads a drive letter as a remote host.
        const result = yield* run("tar", ["-xzf", "package.tgz"], staging);
        expect(result.code, result.stderr).toBe(0);
        yield* fs.rename(path.join(staging, "package"), path.join(modules, name));
        return path.join(modules, name);
      });

      const launcher = yield* unpack(launcherArchive, "executor");
      // The launcher's optional dependency alias for this machine's native runtime.
      yield* unpack(runtimeArchive, `executor-${process.platform}-${process.arch}`);
      const manifest = yield* fs
        .readFileString(path.join(launcher, "package.json"))
        .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Manifest)));

      for (const entry of ["bin.mjs", "bin/executor"]) {
        const file = path.join(launcher, entry);
        // Windows shims (npm's .cmd and .ps1, Bun's .exe) start the entry with Node.
        const viaNode = yield* run(process.execPath, [file, "--version"], root);
        expect(viaNode.code, viaNode.stderr).toBe(0);
        expect(viaNode.stdout).toBe(`executor v${manifest.version}`);
        // Unix shims are symlinks to the entry, started through its shebang.
        if (process.platform !== "win32") {
          const viaShebang = yield* run(file, ["--version"], root);
          expect(viaShebang.code, viaShebang.stderr).toBe(0);
          expect(viaShebang.stdout).toBe(`executor v${manifest.version}`);
        }
      }
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
