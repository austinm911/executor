/** Durable app source lives in a host-owned revision store, independently of SQL and builds. */
import { Effect, Schema } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { AppCodeId, type AppId, type OwnerId, type StorageError } from "./shared.ts";
import type { AppNotFound } from "./apps.ts";

/**
 * Canonical relative POSIX path inside a deployment: no absolute paths,
 * backslashes, NUL bytes, or empty/`.`/`..` segments. Plain refined
 * strings — callers need not brand every path.
 */
export const SourceFilePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((path: string) => {
      if (path.includes("\0")) return "expected no NUL bytes";
      if (path.includes("\\")) return "expected POSIX separators";
      if (path.startsWith("/")) return "expected a relative path";
      return path.length > 0 && path.split("/").every((s) => s !== "" && s !== "." && s !== "..")
        ? true
        : "expected canonical segments (non-empty, no `.` or `..`)";
    }),
  ),
);

export type SourceFilePath = typeof SourceFilePath.Type;

/** One UTF-8 text file of a deployment. Content may be empty. */
export const SourceFile = Schema.Struct({ path: SourceFilePath, content: Schema.String });

export type SourceFile = typeof SourceFile.Type;

/**
 * A deployment's complete source: at least one file, unique paths, and a
 * root `index.ts` entrypoint. `package.json` is optional — the host
 * supplies `apps`, and extra dependencies may come from an
 * optional `package.json`. MCP/OpenAPI/GraphQL importers
 * emit ordinary files like these (their remote discovery still runs live at
 * evaluation); they are not special execution paths.
 */
export const SourceFiles = Schema.NonEmptyArray(SourceFile).pipe(
  Schema.check(
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      new Set(files.map((f) => f.path)).size === files.length ? true : "expected unique paths",
    ),
    Schema.makeFilter((files: ReadonlyArray<SourceFile>) =>
      files.some((f) => f.path === "index.ts") ? true : "expected a root index.ts",
    ),
  ),
);

export type SourceFiles = typeof SourceFiles.Type;

/** File order is presentation; path and contents define source identity. */
export const sourceFilesEqual = (left: SourceFiles, right: SourceFiles): boolean => {
  if (left.length !== right.length) return false;
  const contents = new Map(left.map((file) => [file.path, file.content]));
  return right.every((file) => contents.get(file.path) === file.content);
};

/** A full immutable Git commit, never a mutable branch name. */
export const SourceCommit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u));
/** Source references keep the code lineage explicit so revisions cannot cross repositories. */
export const SourceRevision = Schema.Struct({ code: AppCodeId, commit: SourceCommit });
export type SourceRevision = typeof SourceRevision.Type;

/** Editable app source at one confirmed Git revision. */
export const SourceSnapshot = Schema.Struct({ revision: SourceRevision, files: SourceFiles });
export type SourceSnapshot = typeof SourceSnapshot.Type;

/**
 * The listed removals stay small beside the revision, however many files a save drops: `bytes`
 * bounds the encoded JSON of `paths`, so the whole result stays far below an execute result.
 */
export const removalLimits = { paths: 100, bytes: 16 * 1024 } as const;

/** What a save removed: the total and the first paths, bounded so the result is never cut off. */
export const SourceRemovals = Schema.Struct({
  count: Schema.Int.annotate({
    description: "How many files of the `expected` revision this save removed. 0 when none.",
  }),
  paths: Schema.Array(SourceFilePath).annotate({
    description:
      "The first removed paths, sorted: at most 100, fewer when they are long. When `count` is larger, the rest are the paths of the files you read at `expected` that you did not send. The removed files stay readable at `expected`.",
  }),
});
export type SourceRemovals = typeof SourceRemovals.Type;

/**
 * A saved commit. The caller already holds the files it sent, so they are not echoed back.
 * A save replaces the complete file list, so it names the files the previous revision had that
 * the new one does not; a commit does not deploy, so an unintended removal shows before it runs.
 */
export const CommittedSource = Schema.Struct({ revision: SourceRevision, removed: SourceRemovals });
export type CommittedSource = typeof CommittedSource.Type;

const sourceFailures = {
  "not-found": "The requested app source revision does not exist.",
  conflict:
    "The app's source changed since it was read. Read the latest source, reapply the change, then commit against the new revision.",
  "invalid-source":
    "The app source is not valid: files must be UTF-8 text with supported paths and file modes.",
  git: "Executor's Git storage could not complete this source operation. Try again.",
  storage: "Executor could not read or write this app's source. Try again.",
  limit: "The app source exceeds Executor's file count or total size limit.",
  protected:
    "The app's Git history is protected from this change, such as deleting or recreating its main branch, or an unsupported push format.",
} as const;
/** Safe source failures; command output and remote credentials remain inside adapters. */
export const SourceError = ApiError.define({
  tag: "SourceError",
  status: 500,
  fields: {
    reason: Schema.Literals([
      "not-found",
      "conflict",
      "invalid-source",
      "git",
      "storage",
      "limit",
      "protected",
    ]),
  },
  message: ({ reason }) => sourceFailures[reason],
  recorded: ({ reason }) => sourceFailures[reason],
});
export type SourceError = typeof SourceError.Type;

/**
 * Git stores a path as either a file or a folder, so a file list that has both `a` and `a/b`
 * would silently lose one of them. Saves refuse it, naming the file and a path inside it.
 */
export const SourcePathConflict = ApiError.define({
  tag: "SourcePathConflict",
  status: 400,
  fields: { file: SourceFilePath, nested: SourceFilePath },
  message: ({ file, nested }) =>
    `The files use ${file} as both a file and a folder: ${nested} is inside it. Git can store only one of them. Rename or remove one, then save again. Nothing was saved.`,
  recorded: () => "The files use one path as both a file and a folder. Nothing was saved.",
});
export type SourcePathConflict = typeof SourcePathConflict.Type;

/**
 * Git stores paths as UTF-8, which cannot hold a lone UTF-16 surrogate: encoding replaces it
 * with U+FFFD, so two paths that differ here could become one file. Saves refuse it.
 */
export const SourcePathNotUnicode = ApiError.define({
  tag: "SourcePathNotUnicode",
  status: 400,
  fields: { path: SourceFilePath },
  message: ({ path }) =>
    `The file path ${JSON.stringify(path)} is not valid Unicode: it has a lone surrogate, a \\uD800-\\uDFFF character without its pair. Git stores paths as UTF-8, which cannot hold it. Rename the file, then save again. Nothing was saved.`,
  recorded: () => "A file path is not valid Unicode. Nothing was saved.",
});
export type SourcePathNotUnicode = typeof SourcePathNotUnicode.Type;

/**
 * Refuse a file list whose paths would not each be one distinct Git path: a path that is not
 * valid Unicode, or a file's path that is also a folder of another file.
 */
export const sourcePathsFit = (files: ReadonlyArray<SourceFile>) => {
  // With the `u` flag, a surrogate pair is one code point, so this matches only a lone surrogate.
  const lone = files.find((file) => /\p{Cs}/u.test(file.path));
  if (lone !== undefined) return Effect.fail(new SourcePathNotUnicode({ path: lone.path }));
  const paths = new Set(files.map((file) => file.path));
  for (const nested of [...paths].sort()) {
    const segments = nested.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const file = segments.slice(0, depth).join("/");
      if (paths.has(file)) return Effect.fail(new SourcePathConflict({ file, nested }));
    }
  }
  return Effect.void;
};

/** Transport status follows the failure reason while preserving the SourceError domain value. */
export const sourceErrors = [
  SourceError.check(Schema.makeFilter((error) => error.reason === "conflict")).annotate({
    identifier: "SourceConflict",
    httpApiStatus: 409,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "not-found")).annotate({
    identifier: "SourceMissing",
    httpApiStatus: 404,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "protected")).annotate({
    identifier: "SourceProtected",
    httpApiStatus: 403,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "invalid-source")).annotate({
    identifier: "SourceInvalid",
    httpApiStatus: 400,
  }),
  SourceError.check(Schema.makeFilter((error) => error.reason === "limit")).annotate({
    identifier: "SourceLimit",
    httpApiStatus: 413,
  }),
  SourceError.check(
    Schema.makeFilter((error) => error.reason === "git" || error.reason === "storage"),
  ).annotate({ identifier: "SourceUnavailable", httpApiStatus: 503 }),
  SourcePathNotUnicode,
  SourcePathConflict,
] as const;

/** Count the previous revision's paths that a complete file list leaves out, and list the first. */
export const removedPaths = (
  previous: Iterable<string>,
  files: ReadonlyArray<SourceFile>,
): SourceRemovals => {
  const kept = new Set(files.map((file) => file.path));
  const removed = [...previous].filter((path) => !kept.has(path)).sort();
  const paths: string[] = [];
  // Measure the JSON the list is sent as, where an escaped character can take six bytes.
  let bytes = "[]".length;
  for (const path of removed.slice(0, removalLimits.paths)) {
    bytes += new TextEncoder().encode(JSON.stringify(path)).length + (paths.length > 0 ? 1 : 0);
    if (bytes > removalLimits.bytes) break;
    paths.push(path);
  }
  return { count: removed.length, paths };
};

/** Hosts must retain successful writes while any deployment or release references them. */
export interface AppSourceStorage {
  readonly retain: (
    code: AppCodeId,
    files: SourceFiles,
  ) => Effect.Effect<SourceRevision, SourceError>;
  readonly read: (revision: SourceRevision) => Effect.Effect<SourceFiles, SourceError>;
  readonly workspace: (code: AppCodeId) => Effect.Effect<SourceSnapshot | null, SourceError>;
  readonly commit: (input: {
    readonly code: AppCodeId;
    readonly expected: string | null;
    readonly files: SourceFiles;
    readonly message: string;
  }) => Effect.Effect<SourceSnapshot & Pick<CommittedSource, "removed">, SourceError>;
}

/** Portable branch names, including the private retention prefix used by the source service. */
export const Branch = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9/_-]{0,127}$/u),
  Schema.makeFilter((value) => !value.endsWith("/") && !value.includes("//")),
);
/** The source budget is identical for complete writes and incremental reads on every host. */
export const sourceLimits = { files: 4096, bytes: 16 * 1024 * 1024 } as const;
/** Reject invalid counters and stop readers before they accumulate an oversized source tree. */
export const sourceFits = (files: number, bytes: number): boolean =>
  Number.isSafeInteger(files) &&
  files >= 0 &&
  files <= sourceLimits.files &&
  Number.isSafeInteger(bytes) &&
  bytes >= 0 &&
  bytes <= sourceLimits.bytes;
/** Recent source history is metadata, separate from the files at each immutable revision. */
export const GitCommit = Schema.Struct({
  commit: SourceCommit,
  author: Schema.String,
  message: Schema.String,
  timestamp: Schema.Int,
});
export type GitCommit = typeof GitCommit.Type;
/** Bounded UTF-8 source; generated dependency paths are legal in retained deployment snapshots. */
export const sourceFiles = (files: SourceFiles) =>
  sourceFits(
    files.length,
    files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0),
  )
    ? Effect.succeed(files)
    : Effect.fail(new SourceError({ reason: "limit" }));

/**
 * The Git backend a host supplies to `createExecutor`. Platform mechanics only: app ownership
 * and public package names never reach it. The executor derives its source storage from it.
 */
export interface RepositoryBackend {
  readonly history: (id: AppCodeId) => Effect.Effect<ReadonlyArray<GitCommit>, SourceError>;
  readonly create: (id: AppCodeId) => Effect.Effect<void, SourceError>;
  readonly head: (id: AppCodeId, branch: string) => Effect.Effect<string | null, SourceError>;
  /** Read one coherent snapshot; an absent branch fails with not-found, never another branch's files. */
  readonly read: (
    id: AppCodeId,
    ref: string,
  ) => Effect.Effect<{ readonly commit: string; readonly files: SourceFiles }, SourceError>;
  /**
   * Create the repository for an initial write; existing writes must match the supplied revision.
   * Returns the new commit and the paths of the expected revision that the files leave out.
   */
  readonly commit: (input: {
    readonly id: AppCodeId;
    readonly branch: string;
    readonly expected: string | null;
    readonly files: SourceFiles;
    readonly message: string;
  }) => Effect.Effect<
    { readonly commit: typeof SourceCommit.Type; readonly removed: SourceRemovals },
    SourceError
  >;
  /** Serve one Git smart-HTTP request against the repository. */
  readonly request: (id: AppCodeId, request: Request) => Effect.Effect<Response, SourceError>;
}

/** Git protocol access is host-only, outside the public HTTP/Promise facade. */
export const RepositoryHost = Symbol("executor.RepositoryHost");
/** Hosts authorize the caller and then hand the raw Git request to the app's repository. */
export interface RepositoryHost {
  readonly request: (
    input: { readonly app: AppId; readonly owner?: OwnerId | undefined },
    request: Request,
  ) => Effect.Effect<Response, SourceError | AppNotFound | StorageError>;
  /** Retry pending repository creation with bounded parallel work. */
  readonly recover: Effect.Effect<void, StorageError>;
}
