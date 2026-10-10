/** Scoped loopback listeners for isolated ports and real bind-conflict fixtures. */
import { createServer, type Socket } from "node:net";
import { Effect } from "effect";
import { driver } from "./platform.ts";

/**
 * Hold a loopback port until the owning scope closes; zero asks the OS to choose. `onConnection`
 * handles each connection; the scope closes once every connection has ended.
 */
export const holdPort = (port: number, onConnection?: (socket: Socket) => void) =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => createServer(onConnection)),
      (server) =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    return yield* driver(
      "allocate isolated port",
      () =>
        new Promise<number>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "127.0.0.1", () => {
            const address = server.address();
            if (address === null || typeof address === "string") reject(new Error("No test port"));
            else resolve(address.port);
          });
        }),
    );
  });

/** Ask the OS for an available port and release it before returning. */
export const freePort = Effect.scoped(holdPort(0));
