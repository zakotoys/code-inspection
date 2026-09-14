# Inspection changes and freshness

The workspace service exposes diagnostic changes on `get_run` as an optional
`changes` object. These are comparisons between completed inspections, not a log
of editor saves. One inspection may combine several requests, and one save may
start several inspectors.

## Baselines

The first complete, valid result establishes a baseline without reporting its
existing findings as additions. Later results contain `added` and `resolved`
diagnostics. Unchanged results produce empty arrays.

Baselines are separated by check, project and scope kind. File-scoped inspections
update only the requested files, including files that produce no findings. A
project-wide result establishes coverage for the whole project. When coverage
expands, previously unobserved files are initialized rather than reported as new
problems. `initializedFiles` identifies these file URIs; `baseline` is true when
none of the covered result groups had a previous baseline. A mixed result can
initialize some files while comparing others.

Failed, cancelled, superseded, dirty or truncated results do not advance the
baseline and do not contain `changes`. Absence of `changes` does not mean that
problems have been repaired. `summary.truncated` identifies results cut off by
`maxFindings`. Configuration changes establish a new baseline. Deleted files are
removed from baseline data without treating deletion as a repair.

The service retains each comparison independently of subsequent results while
its run record is retained. This is not a persistent history or cursor-based
event stream. Restarting the service clears baselines. The existing `findings`
field of `get_run` still reads the service's current findings; only `changes` is
the stored comparison for that run.

## Diagnostic identity

Diagnostics are normalized and deduplicated before applying `maxFindings`.
Their IDs depend on the check, source, language, project, file, full range,
severity, rule code, message and related information. Run IDs, generations,
staleness and result ordering do not change diagnostic identity. Related
information ordering does not affect identity.

This is structural comparison, not semantic defect tracking. Moving a diagnostic
to another line can produce one removal and one addition. Consumers must not
interpret an unseen run ID as a new problem or treat historical changes as proof
that the problem still exists.

## Scheduling and file events

LSP document notifications are forwarded in order, but waiting for inspection
completion no longer blocks later edit or deletion notifications. Completion
publication runs separately. A dirty or superseded inspection cannot publish a
fresh result or establish a baseline.

Queued requests merge their scopes. A running request is reused only when it
covers the new request. Otherwise it is superseded by a replacement that covers
the union of both requests. Callers of the old run observe `superseded` and may
query the current findings or request a new run.

The watcher no longer drops events merely because they arrive within 50 ms of
another event or within 1500 ms of a save. Save echoes are suppressed only when
the current file content hash matches the saved content. A read failure is
handled conservatively as a change. Hashing currently reads the saved file
synchronously; very large source files can delay event handling. The cache holds
at most 1000 hashes, not file contents. Directory and unknown-path notifications
retain their conservative invalidation behavior. Filesystem watching does not
provide an audit log of every intermediate write and does not automatically run
inspections for external edits.

The IPC protocol version is 3. Restart existing service processes and clients
when switching to this implementation; no compatibility adapter is provided.

## Validation

Run `npm run check`, then `node scripts/smoke-lsp.mjs`,
`node scripts/smoke-mcp.mjs` and `npm run smoke:pressure`.

Focused coverage lives in:

- `packages/core/test/findings.test.ts`: stable identity, deduplication, metadata
  distinctions and truncation.
- `packages/runtime/test/finding-baselines.test.ts`: initialization, coverage,
  repairs, configuration changes and independent result ownership.
- `packages/runtime/test/observation-regression.test.ts`: scope replacement,
  external writes after saving, failed/incomplete/dirty results, actual LSP edit
  and deletion notifications during a blocked inspection, and the MCP response.
