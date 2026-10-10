/** Profile setup through the public API. Each fixture retains the returned identity explicitly. */
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "./api.ts";
import { appsManifest } from "./apps-release.ts";

/** Account selections and revision returned by a real profile write. */
export const Profile = Schema.Struct({
  id: Schema.String,
  revision: Schema.Number,
  accounts: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});

/** Create one empty fixture profile, optionally supplying the SDK's explicit owner, subject and name. */
export const createProfile = (
  actor: Session,
  appPath: string,
  identity?: { readonly owner: string; readonly subject: string; readonly name?: string },
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return yield* body(
      Profile,
      yield* api.request(
        actor,
        "POST",
        `${appPath}/profiles`,
        { ...identity, accounts: {}, idempotencyKey: randomUUID() },
        headers,
      ),
    );
  });

/** Read the exact fixture profile's revision before replacing its complete selection. */
export const selectProfileAccounts = (
  actor: Session,
  appPath: string,
  profile: string,
  accounts: typeof Profile.Type.accounts,
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const path = `${appPath}/profiles/${profile}`;
    const current = yield* body(
      Profile,
      yield* api.request(actor, "GET", path, undefined, headers),
    );
    return yield* api.request(
      actor,
      "PATCH",
      path,
      { expectedRevision: current.revision, accounts },
      headers,
    );
  });

/** A saved account, as the connection that saved it returns. */
export const ConnectedAccount = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
});
const ConnectionLink = Schema.Struct({ connection: Schema.String, url: Schema.String });

/**
 * Save a secrets-method account the only way the product allows: through a local connection
 * request for an app profile's requirement, which selects the account for that profile. With
 * `account`, the request replaces that account's credentials instead. The agent issues the link
 * with its bearer key; the form's submission carries only the link's grant.
 */
export const connectLocalAccount = (
  actor: Session,
  input: {
    readonly app: string;
    readonly profile: string;
    readonly requirement: string;
    readonly method: string;
    readonly fields: Record<string, unknown>;
    readonly label?: string;
    readonly account?: string;
    readonly owner?: string;
  },
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const issued = yield* api.request(
      actor,
      "POST",
      "/account-connect/api/requests",
      {
        owner: input.owner ?? "local",
        target: { app: input.app, profile: input.profile, requirement: input.requirement },
        ...(input.account === undefined ? {} : { account: input.account }),
      },
      headers,
    );
    if (issued.status !== 200)
      return yield* Effect.die(`Connection request failed: ${JSON.stringify(issued.body)}`);
    const link = yield* body(ConnectionLink, issued);
    const submitted = yield* api.request(
      actor,
      "POST",
      "/account-connect/api/submit",
      {
        connection: link.connection,
        token: new URLSearchParams(new URL(link.url).hash.slice(1)).get("token"),
        method: input.method,
        ...(input.label === undefined ? {} : { label: input.label }),
        fields: input.fields,
      },
      headers,
    );
    if (submitted.status !== 200)
      return yield* Effect.die(`Connection submission failed: ${JSON.stringify(submitted.body)}`);
    return yield* body(ConnectedAccount, submitted);
  });

/**
 * Save accounts that no profile of the scenario's own app selects. Accounts are connected only for
 * an app, so they are connected for a throwaway app that requires the same provider definition,
 * which resolves to the same provider, and that app is removed again. The accounts stay saved.
 */
export const connectAccountsThroughOtherApp = (
  actor: Session,
  input: {
    /** Source of the scenario app's `defineProvider(...)` call, imported names included. */
    readonly provider: string;
    readonly method: string;
    readonly accounts: ReadonlyArray<{
      readonly label: string;
      readonly fields: Record<string, unknown>;
    }>;
    readonly owner?: string;
  },
  headers?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const owner = input.owner ?? "local";
    const deployed = yield* api.request(
      actor,
      "POST",
      "/v1/apps/deploy",
      {
        owner,
        name: `Account fixture ${randomUUID().slice(0, 8)}`,
        files: [
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = ${input.provider};
export default defineApp({ accounts: { service: service.many() } }, async () => ({ tools: router({}) }));`,
          },
          appsManifest,
        ],
      },
      headers,
    );
    if (deployed.status !== 200)
      return yield* Effect.die(`Fixture app deploy failed: ${JSON.stringify(deployed.body)}`);
    const { app } = yield* body(
      Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
      deployed,
    );
    const profile = yield* createProfile(
      actor,
      `/v1/apps/${app.id}`,
      { owner, subject: "local" },
      headers,
    );
    const accounts = yield* Effect.forEach(input.accounts, (account) =>
      connectLocalAccount(
        actor,
        {
          owner,
          app: app.id,
          profile: profile.id,
          requirement: "service",
          method: input.method,
          label: account.label,
          fields: account.fields,
        },
        headers,
      ),
    );
    const removed = yield* api.request(actor, "DELETE", `/v1/apps/${app.id}`, undefined, headers);
    if (removed.status !== 200)
      return yield* Effect.die(`Fixture app removal failed: ${JSON.stringify(removed.body)}`);
    return accounts;
  });
