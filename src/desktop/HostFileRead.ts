import { stat } from "node:fs/promises";

import { AnalysisCleanupLease } from "../artifacts/AnalysisCleanupLease.js";
import { ArtifactFileCleanupFailure } from "../artifacts/ArtifactFileOperation.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../filesystem/OwnedRegularFile.js";
import {
  NonRegularFileReadError,
  RegularFileChangedError,
  isSelectedRegularFileError,
} from "../filesystem/RegularFile.js";
import {
  RegularFileCapacityError,
  readStableFileBytes,
} from "../filesystem/readStableFileBytes.js";

const DENIED_CODES = new Set(["EACCES", "EPERM"]);

/** A read the inventory reports as unreadable rather than failing on. */
export const isRefusedRead = (cause: unknown): boolean =>
  cause instanceof RegularFileCapacityError ||
  cause instanceof RegularFileChangedError ||
  cause instanceof NonRegularFileReadError ||
  isSelectedRegularFileError(cause) ||
  DENIED_CODES.has((cause as NodeJS.ErrnoException).code ?? "");

/**
 * A host read whose close failed, as a cleanup failure with a lease on the
 * exact handle: the capture reports the file and keeps its owner, even when
 * cancelled or beside another failure.
 */
export const hostCloseFailure = (
  cause: RegularFileCleanupFailure,
): ArtifactFileCleanupFailure =>
  new ArtifactFileCleanupFailure(
    cause,
    new AnalysisCleanupLease(() => cause.owner.close(), [cause.path]),
  );

/** A small host file's bytes, following links; `missing` when the path names nothing. */
export const readHostFile = async (
  path: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  preserveCapacity = false,
): Promise<Buffer | "missing" | "unreadable"> => {
  const options = {
    symlinks: "follow" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await withOwnedRegularFile(path, options, ({ handle }) =>
      readStableFileBytes(handle, path, maximumBytes, options),
    );
  } catch (cause: unknown) {
    if (cause instanceof RegularFileCleanupFailure)
      throw hostCloseFailure(cause);
    if (preserveCapacity && cause instanceof RegularFileCapacityError)
      throw cause;
    signal?.throwIfAborted();
    if (!isRefusedRead(cause)) throw cause;
    return (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? "missing"
      : "unreadable";
  }
};

/** Whether a failed identity probe means the path names nothing, rather than a probe that could not be answered. Only a missing path establishes absence. */
export const isMissingProbe = (cause: unknown): boolean => {
  const code = (cause as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** What a host identity probe established: a regular file, something else, or nothing there. */
export type HostFileKind = "file" | "other" | "absent";

/**
 * A host path's identity as its probe could establish it; a probe that
 * fails for another reason stays unresolved with its cause, rather than
 * being read as a confirmed absence.
 */
export const probeHostFile = async (
  path: string,
): Promise<Result<HostFileKind, unknown>> => {
  try {
    return ok((await stat(path)).isFile() ? "file" : "other");
  } catch (cause: unknown) {
    return isMissingProbe(cause) ? ok("absent") : err(cause);
  }
};

/** Whether a host path names a regular file, following links. */
export const isHostFile = async (path: string): Promise<boolean> => {
  const probed = await probeHostFile(path);
  return probed.ok && probed.value === "file";
};
