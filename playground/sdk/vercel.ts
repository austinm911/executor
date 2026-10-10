/** Promise SDK example using caller-provided storage, credentials and runtime. */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem } from "effect";
import {
  createExecutor,
  createRemoteExecutor,
  OwnerId,
  ToolName,
  type Executor,
  type ExecutorOptions,
} from "@executor-js/sdk";
import apps from "apps/package.json" with { type: "json" };

const me = OwnerId.make("app-user-me");

/** Deploy one configured app, connect an account for its profile, and call the tool. */
export async function vercelProjectsReport(executor: Executor) {
  const source = await Effect.runPromise(
    FileSystem.FileSystem.use((fs) =>
      fs.readFileString("playground/demo-apps/vercel/index.ts"),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  const { app } = await executor.apps.deploy({
    owner: me,
    name: "Work Vercel",
    files: [
      { path: "index.ts", content: source },
      { path: "package.json", content: JSON.stringify({ dependencies: { apps: apps.version } }) },
    ],
  });

  // Runtime metadata has dynamic slot names; check the expected slot exists.
  if (app.requirements.accounts.vercel === undefined)
    throw new Error("This app must declare a vercel account");

  const profile = await executor.apps.profiles.create({
    owner: me,
    subject: "me",
    idempotencyKey: "work",
    app: app.id,
    accounts: {},
  });
  // Every account is connected for an app requirement. Completing the request saves the
  // account and selects it for the profile. Products give users the request as a browser link.
  const connection = await executor.accountConnections.create({
    owner: me,
    target: { app: app.id, profile: profile.id, requirement: "vercel" },
  });
  const account = await executor.accountConnections.submit({
    connection: connection.id,
    method: "apiKey",
    label: "Work Vercel",
    fields: { token: "vercel_tok_synthetic_example_only" },
  });

  const projects = await executor.tools.call({
    app: app.id,
    profile: profile.id,
    tool: ToolName.make("listProjects"),
    kind: "query",
    input: {},
  });
  return { app, profile, account, projects };
}

/** Local/remote parity; neither function starts work until called. */
export const inProcess = async (options: ExecutorOptions) =>
  vercelProjectsReport(await createExecutor(options));

/** The remote client exposes exactly the same operations. */
export const remote = async () =>
  vercelProjectsReport(
    await createRemoteExecutor({
      baseUrl: "https://executor.example.com",
      apiKey: "exec_sk_synthetic",
    }),
  );
