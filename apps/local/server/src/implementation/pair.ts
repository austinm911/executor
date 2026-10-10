/** `executor pair`: a client of the running server that reads keys and writes nothing. */
import { Console, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { LocalAuthApi } from "../contracts/auth.ts";
import { serverPortConfig } from "../contracts/config.ts";
import { PairFailed } from "../contracts/startup.ts";
import { LocalConfigurationError, savedApiKey } from "./bootstrap.ts";

/**
 * fetch reports a refused connection as its cause's code. Only that means nothing listens on the
 * port; a reset, a closed connection or a reply that is not HTTP comes from another service.
 */
const connectionRefused = Schema.is(
  Schema.Struct({ cause: Schema.Struct({ code: Schema.Literal("ECONNREFUSED") }) }),
);
/** A running Executor server answers at once, so a listener that stays silent is something else. */
const answerWithin = "10 seconds";

/** Print a one-use connection link from the server on EXECUTOR_PORT, sent the directory's key. */
export const pair = (platform: string) =>
  Effect.gen(function* () {
    const port = yield* serverPortConfig.pipe(
      Effect.mapError(
        () =>
          new LocalConfigurationError({
            reason: "misconfigured",
            message:
              "EXECUTOR_PORT must be a port number from 1 to 65535: the port the running server listens on. Nothing was changed.",
          }),
      ),
    );
    const { directory, apiKey, keys } = yield* savedApiKey(platform);
    const failed = (reason: PairFailed["reason"]) =>
      Effect.fail(new PairFailed({ reason, port, directory, keys }));
    const client = yield* HttpApiClient.make(LocalAuthApi, {
      baseUrl: `http://127.0.0.1:${port}`,
      transformClient: (client) =>
        client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(apiKey))),
    }).pipe(Effect.provide(FetchHttpClient.layer));
    const link = yield* client.auth.pair().pipe(
      Effect.timeout(answerWithin),
      Effect.catchTags({
        PairingUnauthorized: () => failed("key-rejected"),
        AuthStorageError: () => failed("storage-unavailable"),
        HttpClientError: (error) =>
          failed(
            error.reason instanceof HttpClientError.TransportError &&
              connectionRefused(error.reason.cause)
              ? "no-server"
              : "unexpected-response",
          ),
        AuthForbidden: () => failed("unexpected-response"),
        SchemaError: () => failed("unexpected-response"),
        TimeoutError: () => failed("unexpected-response"),
      }),
    );
    yield* Console.log(Redacted.value(link.url));
  });
