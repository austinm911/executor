/** Execute tool schemas, limits and discovery instructions. */
import { CodeMode } from "@opencode-ai/codemode";
import { Schema } from "effect";
import { HttpServerRequest } from "effect/http";
import { McpSchema, Tool as McpTool } from "effect/ai";
import { ApiErrorResponse, ElicitationResponse } from "apps/contracts";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import { ToolName } from "@executor-js/sdk/core";
import { InteractionId, PendingInteraction, ElicitationResponseInvalid } from "./interactions.ts";
export * from "./interactions.ts";
import { NativeElicitationFailed } from "./elicitation.ts";

/** Fixed interpreter input, live-program capacity and discovery fan-out and time bounds. */
export const McpRuntimeLimits = Schema.Struct({
  maxCodeChars: Schema.Int.check(Schema.isGreaterThan(0)),
  maxExecutions: Schema.Int.check(Schema.isGreaterThan(0)),
  discoveryConcurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  /** How long discovery waits for the apps a program or search needs before giving up on any. */
  discoveryWaitMs: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * After that wait, discovery gives up on the apps still listing once no listing in the
   * execution has completed for this long. Listings share one app runtime, so a slow app is kept
   * while others progress, and a stalled app is dropped soon after the others finish.
   */
  discoveryIdleMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpRuntimeLimits = typeof McpRuntimeLimits.Type;
/** Existing runtime defaults; execution time, output and call budgets remain in McpLimits. */
export const defaultMcpRuntimeLimits = McpRuntimeLimits.make({
  maxCodeChars: 65_536,
  maxExecutions: 64,
  discoveryConcurrency: 8,
  // Together well inside the default 5 minute execution budget, which leaves the program time to run.
  discoveryWaitMs: 10_000,
  discoveryIdleMs: 5_000,
});

/** A product denied admission before a program started. The message is safe for the caller. */
export class ExecutionRejected extends Schema.TaggedError<ExecutionRejected>()(
  "ExecutionRejected",
  { message: Schema.String },
) {}

/**
 * An app that needs accounts exposes no tools until the caller has an enabled profile for it.
 * The caller may have no profile, or only disabled or removed ones.
 */
export const AppProfileRequired = UserFacingError.define({
  tag: "AppProfileRequired",
  status: 409,
  fields: { app: Schema.String },
  title: "Set up an account profile to continue",
  description: "This app needs an account, and you have no enabled profile for it.",
  recovery: {
    action:
      "Open the app's Accounts page and connect an account or enable an existing profile, then run execute again.",
    instructions:
      "Tell the user this app needs an account profile before its tools can be used. They can connect an account, or enable a profile they already have, on the app's Accounts page. Never substitute another identity automatically. This execution cannot call the app's tools.",
  },
});

/**
 * An app was still listing its tools when discovery stopped waiting for it: a large or slow app,
 * or one whose server accepts connections and never answers. A listing that was running keeps
 * running in the background, so a slow but healthy app loads in a later execution.
 */
export const AppDiscoveryTimedOut = UserFacingError.define({
  tag: "AppDiscoveryTimedOut",
  status: 504,
  fields: { app: Schema.String, elapsedMs: Schema.Number },
  recorded: ({ elapsedMs }) => `Listing the app's tools timed out after ${elapsedMs}ms`,
  presentation: ({ elapsedMs }) => ({
    title: "App tools did not load in time",
    description: `Listing this app's tools timed out after ${elapsedMs}ms in this execution, so its tools are unavailable here. A listing that was still running continues in the background, so a slow app usually loads in a later execution. Other apps are not affected.`,
    retryable: true,
    recovery: {
      action:
        "Run execute again shortly. If the app keeps timing out, check that its upstream server responds.",
      instructions:
        "This app's tools were still loading when this execution stopped waiting for them. Retry in a new execute after a few seconds instead of treating the app as broken. If it is still unavailable after several attempts, tell the user its server may be offline or overloaded. Other apps remain usable.",
    },
  }),
});

/**
 * A call that needs approval made a request larger than the output budget, measured on what its
 * delivery sends: the whole request as an execute result, or only the prompt a native client
 * shows. Executor never offers it and cancels the saved call, so no one is asked to approve a call
 * whose request did not reach them and it can never run. App code asks for approval after it has
 * run, so the copy says what Executor did with the call, never that the tool did not run.
 */
export const ApprovalTooLarge = UserFacingError.define({
  tag: "ApprovalTooLarge",
  status: 413,
  fields: { tool: ToolName, bytes: Schema.Int, limit: Schema.Int },
  recorded: ({ bytes, limit }) =>
    `Approval request of ${bytes} bytes is over the ${limit}-byte limit`,
  presentation: ({ tool, bytes, limit }) => ({
    title: "Approval request too large",
    description: `The approval request for “${tool}” is ${bytes} bytes, over the ${limit}-byte limit for an approval request, so Executor did not ask for approval and will not run the call.`,
    recovery: {
      action:
        "Make the arguments smaller, for example by passing large content as a URL or an uploaded file, then call the tool again.",
      instructions: `An approval request carries the call's arguments and must fit in ${limit} bytes of JSON; this one is ${bytes}. Calling it again with the same arguments fails the same way, and changing unrelated arguments does not help. Pass large content by reference instead of inline: a URL, an upload or file ID the tool accepts, or several smaller calls if the tool supports that. Code that ran before approval was requested, in this tool or earlier in the program, may already have made changes; check current state with a safe read before calling again.`,
    },
  }),
});
export type ApprovalTooLarge = typeof ApprovalTooLarge.Type;

/**
 * Executor will not run an approved call, for a reason only its own state establishes. App code
 * asks for approval after it has already run, so the copy says what Executor did with the saved
 * call, never that the tool did not run. A call that ran and failed reports its own error instead.
 */
export const ApprovalUnavailable = UserFacingError.define({
  tag: "ApprovalUnavailable",
  status: 409,
  fields: {
    /**
     * `expired`: the request passed its deadline. `context-changed`: Executor read the app
     * deployment, profile or accounts and they differ from the reviewed call.
     * `context-unconfirmed`: Executor's storage failed while it read them, so it could not compare.
     * `answered`: another answer already claimed it. `ended`: the execution ended before the
     * request could be saved.
     */
    reason: Schema.Literals([
      "expired",
      "context-changed",
      "context-unconfirmed",
      "answered",
      "ended",
    ]),
  },
  recorded: ({ reason }) => `Approval unavailable: ${reason}`,
  presentation: ({ reason }) => {
    const check =
      "Code that ran before approval was requested, in this tool or earlier in the program, may already have made changes; check current state with a safe read before running anything again.";
    switch (reason) {
      case "expired":
        return {
          title: "Approval expired",
          description:
            "This approval request expired before it was answered, so Executor did not resume the saved call.",
          recovery: {
            action: "Run the call again and ask for approval promptly if it is still wanted.",
            instructions: `Approval requests expire after 15 minutes. ${check} Then start a new execute and ask the user to approve its new request.`,
          },
        };
      case "context-changed":
        return {
          title: "Approved call changed",
          description:
            "The app deployment, profile or accounts changed after this call was saved for approval, so Executor did not resume it.",
          recovery: {
            action: "Run the call again to review it with the current settings.",
            instructions: `Executor resumes only the exact call that was reviewed, and its settings changed while it waited. ${check} Then start a new execute and ask the user to approve its new request.`,
          },
        };
      case "context-unconfirmed":
        return {
          title: "Approved call not confirmed",
          description:
            "Executor could not read the app deployment, profile or accounts to confirm they still match the reviewed call, because its own storage failed, so it did not resume the call. Nothing shows that they changed.",
          recovery: {
            action:
              "Try again in a moment: run the call again and approve its new request. If this continues, check Executor's storage.",
            instructions: `This was a failure of Executor's storage, not a change to the call. The approval request is used up, so resuming it again will not run it. ${check} Then start a new execute and ask the user to approve its new request; if storage keeps failing, report it to whoever runs this Executor.`,
          },
        };
      case "answered":
        return {
          title: "Approval already answered",
          description:
            "This approval request was already answered elsewhere, which claimed its saved call, so Executor did not run the call again. That call may still be running, and its outcome is not replayed here.",
          recovery: {
            action:
              "Check the response to the earlier answer, if you have it, and the current state before running anything again.",
            instructions: `Each approval request is answered once. The earlier answer may not have received a result yet, or its response may have been lost. ${check}`,
          },
        };
      case "ended":
        return {
          title: "Execution ended",
          description:
            "The execution ended while this tool was asking for approval, so Executor will not resume the call.",
          recovery: {
            action: "Check current state, then run the program again if it is still needed.",
            instructions: `The execution timed out or was cancelled before the approval request could be saved. ${check}`,
          },
        };
    }
  },
});
export type ApprovalUnavailable = typeof ApprovalUnavailable.Type;

/**
 * Why a resume found no request it could answer. Executor's own record of the request decides it;
 * a request issued to another caller is indistinguishable from an unknown one.
 */
export const ResumeUnavailableReason = Schema.Literals([
  "answered",
  "expired",
  "ended",
  "not-found",
]);
export type ResumeUnavailableReason = typeof ResumeUnavailableReason.Type;
/** The guidance a resume returns with each reason. */
export const resumeUnavailableMessage = (reason: ResumeUnavailableReason): string => {
  const check =
    "Earlier calls in the program, and code a tool ran before asking for approval, may already have made changes: check current state with a safe read before starting a new execute, and never rerun the program automatically.";
  switch (reason) {
    case "answered":
      return `This request was already answered by another resume, which claimed it. Executor does not run it again or replay its outcome here: that program may still be running, and its result goes only to the resume that answered it, if that response arrived. Do not resume it again. ${check}`;
    case "expired":
      return `This request expired before it was answered, so Executor will not resume its program. ${check}`;
    case "ended":
      return `The program that asked this ended before it was answered: it was cancelled, timed out, or stopped. Executor will not resume it. ${check}`;
    case "not-found":
      return `Executor has no pending request with this ID for this caller. It may belong to another grant, scoped connection or approval mode; it may have ended or been answered long enough ago that Executor no longer remembers it; or it was lost when Executor restarted. In model mode, a new MCP session on the same grant can still answer its requests. ${check}`;
  }
};

/** Generated code is bounded before it reaches the parser. */
export const ExecuteInput = Schema.Struct({
  code: Schema.String.check(Schema.isMaxLength(defaultMcpRuntimeLimits.maxCodeChars)),
});
/**
 * Incomplete or failing apps stay visible as explicit discovery diagnostics. Absent fields are
 * omitted: execution results are MCP JSON, which has no undefined.
 */
export const UnavailableApp = Schema.Struct({
  app: Schema.String,
  name: Schema.String,
  reason: Schema.String,
  profile: Schema.optionalKey(Schema.String),
  /** Only this router's tools are missing; the rest of the app loaded. */
  router: Schema.optionalKey(Schema.String),
});
/**
 * One admitted tool call in call order. `interrupted` calls were still running when the
 * execution ended; the upstream may or may not have applied them. `awaiting-approval` calls
 * were still waiting for approval when the execution ended; Executor did not resume the saved
 * call, though the tool may have had effects before it asked.
 */
export const McpToolCall = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(["success", "failure", "interrupted", "awaiting-approval"]),
  durationMs: Schema.optionalKey(Schema.Number),
});
export type McpToolCall = typeof McpToolCall.Type;
/**
 * A failed tool's curated explanation as an agent receives it; a program can read it from a
 * caught tool error. `retryable` means an unchanged repeat may help and is considered safe. It
 * does not guarantee success, and correcting the input, configuration or access may allow a new
 * attempt even when it is false.
 */
export const McpErrorResponse = Schema.Struct({
  ...ApiErrorResponse.fields,
  retryable: Schema.Boolean,
});
export type McpErrorResponse = typeof McpErrorResponse.Type;
/** Program result plus apps that could not expose a live catalog during this execution. */
export const ExecuteResult = Schema.Struct({
  execution: Schema.Union([
    Schema.Struct({ ...CodeMode.Success.fields, toolCalls: Schema.Array(McpToolCall) }),
    Schema.Struct({
      ...CodeMode.Failure.fields,
      error: Schema.Struct({
        ...CodeMode.Diagnostic.fields,
        response: Schema.optionalKey(McpErrorResponse),
      }),
      toolCalls: Schema.Array(McpToolCall),
    }),
  ]),
  unavailableApps: Schema.Array(UnavailableApp),
});
/** MCP execution may return a live pause; completed program results retain the existing fields. */
export const ExecutionOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed"), ...ExecuteResult.fields }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    requestId: InteractionId,
    reason: ResumeUnavailableReason,
    message: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("busy"), requestId: InteractionId }),
  Schema.Struct({ status: Schema.Literal("capacity-exceeded") }),
]);
/** Completed or pending outcomes share one contract in model and native delivery. */
export const McpExecutionResult = Schema.Union([ExecutionOutcome, PendingInteraction]);
export type McpExecutionResult = typeof McpExecutionResult.Type;
/** MCP elicitation responses delivered by the agent; this does not send native or browser prompts. */
export const ResumeInput = Schema.Struct({
  requestId: InteractionId,
  response: ElicitationResponse,
});
/** Continue an existing program after the agent has obtained the user's decision. Never restarts source. */
export const ResumeTool = McpTool.make("resume", {
  description:
    "Continue a paused execute program using its pending requestId and the user's MCP elicitation response: {action: 'accept', content: {...}}, {action: 'decline'}, or {action: 'cancel'}. Ask the user before approving. Return the user's form fields in content on accept. Returns the next pending interaction or the completed program result. An approved call that fails reports its own error. Unavailable carries a reason (answered, expired, ended or not-found) and what to do; do not rerun the whole program because earlier calls may have completed. Busy means another resume is advancing this program; wait for that response. Results are not replayed.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ResumeInput,
  success: McpExecutionResult,
  failure: ElicitationResponseInvalid,
});

/** Bounds that keep each tools.search item short. Pages are also bounded by bytes. */
export const SearchLimits = Schema.Struct({
  /** Items a page holds when the caller gives no limit. */
  defaultItems: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Characters kept from the first line of a tool's description. */
  descriptionChars: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Characters kept from a tool's single-line input type. A longer type is cut and marked. */
  inputChars: Schema.Int.check(Schema.isGreaterThan(0)),
  /** Paths one tools.search.describe call accepts. */
  describePaths: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type SearchLimits = typeof SearchLimits.Type;
export const defaultSearchLimits = SearchLimits.make({
  defaultItems: 10,
  descriptionChars: 200,
  inputChars: 1_000,
  describePaths: 20,
});

/** Discovery accepts an empty query and supports paging through a large app catalog. */
export const SearchInput = Schema.Struct({
  query: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Words matched against tool paths, descriptions, input names, and app, profile and router labels. Omit it to list a namespace.",
    }),
  ),
  namespace: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "App slug, such as axiom, or a namespace inside it, such as axiom.profiles.ins_id or acme.issues.",
    }),
  ),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThan(0)).annotate({
      description: `Most items to return, ${defaultSearchLimits.defaultItems} by default. A page ends sooner when it reaches its size budget.`,
    }),
  ),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
/**
 * A namespace that search items share, listed once per result rather than in every item: an app,
 * one of its profiles with its accounts, or a titled router inside either.
 */
export const SearchNamespace = Schema.Struct({
  /** The callable prefix of every tool below it, such as tools.axiom.profiles.ins_id. */
  path: Schema.String,
  app: Schema.String,
  /** The profile's label. Its tools use that profile's saved accounts. */
  profile: Schema.optionalKey(Schema.String),
  /** The profile's account labels, each with its description. */
  accounts: Schema.optionalKey(Schema.String),
  /** The title of the router that groups these tools. */
  router: Schema.optionalKey(Schema.String),
});
export type SearchNamespace = typeof SearchNamespace.Type;
/** One tool, short enough that a page of them fits in an execute result. */
export const SearchItem = Schema.Struct({
  /** The exact callable path. */
  path: Schema.String,
  /** The first line of the tool's description. */
  description: Schema.String,
  /** The input type on one line, without documentation. */
  input: Schema.String,
  /** The input type was cut; tools.search.describe returns it whole. */
  inputTruncated: Schema.optionalKey(Schema.Literal(true)),
  /** The same tool, with the same signature, under the app's other profiles. */
  alsoAt: Schema.optionalKey(Schema.Array(Schema.String)),
});
/**
 * One page of ranked matches. `remaining` counts the matches after this page; `next` is the input
 * for the following page, or null when this page holds the last match.
 */
export const SearchResult = Schema.Struct({
  items: Schema.Array(SearchItem),
  namespaces: Schema.Array(SearchNamespace),
  remaining: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  next: Schema.NullOr(
    Schema.Struct({
      ...SearchInput.fields,
      offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    }),
  ),
});
/** Exact paths, as search returns them, whose full detail the caller wants. */
export const DescribeInput = Schema.Struct({
  paths: Schema.Array(Schema.String).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(defaultSearchLimits.describePaths),
  ),
});
/**
 * Full detail for each path found: the whole description and the TypeScript signature with its
 * input and output types. A path that names no tool is in `missing`, with the closest paths.
 */
export const DescribeResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({ path: Schema.String, description: Schema.String, signature: Schema.String }),
  ),
  namespaces: Schema.Array(SearchNamespace),
  missing: Schema.Array(
    Schema.Struct({ path: Schema.String, matches: Schema.Array(Schema.String) }),
  ),
});
/** Server-controlled execution budgets; clients cannot override them. */
export const McpLimits = Schema.Struct({
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  maxToolCalls: Schema.Int.check(Schema.isGreaterThan(0)),
  maxOutputBytes: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type McpLimits = typeof McpLimits.Type;
/** Default interpreter budgets; each product may supply different limits. */
export const defaultMcpLimits: McpLimits = {
  timeoutMs: 5 * 60_000,
  maxToolCalls: 100,
  maxOutputBytes: 65_536,
};
/**
 * UTF-8 bytes of JSON one search page may hold: a quarter of the execute output budget, so a
 * program can return a page beside other data without the result being truncated.
 */
export const searchPageBytes = (limits: McpLimits) => Math.floor(limits.maxOutputBytes / 4);

/** Execute programs over the host-provided app catalog. */
export const ExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps; find their tools with tools.search inside it and full signatures with tools.search.describe({ paths }). First read the Executor app's executor skill with the skills tool. Never ask the user for secrets in chat; accounts connect through Executor's secure links. If approval-required or input-required is returned, show it to the user and call resume with their answer; never run the program's source again. External effects are not rolled back on error or cancellation. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: ExecutionRejected,
});

/** Native-mode execution obtains policy decisions through server-initiated MCP requests. */
export const NativeExecuteTool = McpTool.make("execute", {
  description:
    "Run a JavaScript program over Executor apps; find their tools with tools.search inside it and full signatures with tools.search.describe({ paths }). First read the Executor app's executor skill with the skills tool. Never ask the user for secrets in chat; accounts connect through Executor's secure links. Approvals and tool input open the MCP client's own prompt, and execute continues the same program. Earlier tool calls may already have completed and are not rolled back; never rerun the program automatically after an error. Send feedback with the Executor app's feedback.submit tool when Executor gets in your way or something works especially well.",
  dependencies: [HttpServerRequest.HttpServerRequest, McpSchema.McpRequestContext],
  parameters: ExecuteInput,
  success: McpExecutionResult,
  failure: Schema.Union([NativeElicitationFailed, ElicitationResponseInvalid, ExecutionRejected]),
});
