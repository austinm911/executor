#!/usr/bin/env node
import { appsCommand, appCommandFailure } from "@executor-js/app-management/cli";
/** CLI composition root. Platform dependencies and raw process arguments stop here. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { fileURLToPath } from "node:url";
import { Console, Effect, Option, Schema } from "effect";
import { CliError, Command } from "effect/cli";
import {
  LegacyCommand,
  PairFailed,
  executorCommand,
  legacyCommands,
  pairCommand,
  rotateKeyCommand,
  serveCommand,
} from "./contracts/startup.ts";
import { LocalConfigurationError, rotateApiKey } from "./implementation/bootstrap.ts";
import { launch } from "./implementation/launcher.ts";
import { pair } from "./implementation/pair.ts";

// The installed runtime's own path shows which package manager installed it.
const installation = fileURLToPath(import.meta.url);
/** Failures whose message is written for the person running the command. */
const explained = Schema.is(Schema.Union([LocalConfigurationError, PairFailed, LegacyCommand]));

const cli = executorCommand.pipe(
  Command.withHandler(({ bootstrapFd }) =>
    launch(Option.isSome(bootstrapFd) ? "desktop" : "browser", process.platform, installation),
  ),
  Command.withSubcommands([
    appsCommand(process.platform),
    serveCommand.pipe(
      Command.withHandler(() => launch("headless", process.platform, installation)),
    ),
    pairCommand.pipe(Command.withHandler(() => pair(process.platform))),
    rotateKeyCommand.pipe(
      Command.withHandler(() =>
        rotateApiKey(process.platform).pipe(
          Effect.andThen(
            Console.log(
              "Rotated the local API key. Restart Executor to use it, then update clients that used the previous key.",
            ),
          ),
        ),
      ),
    ),
    ...legacyCommands.map((legacy) =>
      legacy.pipe(
        Command.withHandler(() => Effect.fail(new LegacyCommand({ command: legacy.name }))),
      ),
    ),
  ]),
);

NodeRuntime.runMain(
  Command.run(cli, { version: process.env.EXECUTOR_BUILD_VERSION ?? "0.0.0-dev" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    // Effect CLI renders argument errors and supplies the exit status for help.
    // Operational failures retain the launcher's sanitized message.
    Effect.catch((error) =>
      CliError.isCliError(error)
        ? Effect.fail(error)
        : Console.error(
            (explained(error) ? error.message : undefined) ??
              appCommandFailure(error) ??
              "Executor could not start. Check the configured keys and whether the port is already in use.",
          ).pipe(
            Effect.andThen(
              Effect.sync(() => {
                process.exitCode = 1;
              }),
            ),
          ),
    ),
  ),
);
