import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {reviewArtifactChangeSet} from './change-set-guard.mjs';

// Explicit API pagination: do not rely on CLI aggregation, which can discard or
// merge the metadata used to bind the reviewed proposal to the stack snapshot.
export function readCompleteChangeSet(fetchPage) {
  let next, metadata;
  const tokens = new Set(), changes = [];
  for (let count = 0; count < 100; count++) {
    const page = fetchPage(next);
    if (!page || !Array.isArray(page.Changes)) throw new Error('changes page missing');
    const {Changes, NextToken, ...rest} = page;
    if (metadata && !isDeepStrictEqual(metadata, rest)) throw new Error('proposal metadata changed between pages');
    metadata = rest;
    changes.push(...Changes);
    if (NextToken == null) return {...metadata, Changes: changes};
    if (typeof NextToken !== 'string' || !NextToken.length || tokens.has(NextToken)) throw new Error('invalid or repeated pagination token');
    tokens.add(NextToken);
    next = NextToken;
  }
  throw new Error('proposal pagination exceeded bound');
}

export function inspectArtifactChangeSet({stack, changeSetId, artifactKey, fetchPage, submitted, accountId}) {
  const plan = readCompleteChangeSet(fetchPage);
  const result = reviewArtifactChangeSet(plan, stack, changeSetId, artifactKey, submitted, accountId);
  if (result.problems.length) {
    const error = new Error(result.problems.join('; '));
    if (result.modeDiagnostic) error.modeDiagnostic = result.modeDiagnostic;
    throw error;
  }
  return {plan, executionId: result.noChanges ? null : plan.ChangeSetId};
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const [snapshot, changeSetId, artifactKey, receipt, request, ...extra] = process.argv.slice(2);
    if (!snapshot || !receipt || extra.length) throw new Error('expected stack snapshot, change set ARN, artifact key, local receipt path and optional submitted parameters path');
    const submitted = request ? JSON.parse(readFileSync(request, 'utf8')) : undefined;
    const stacks = JSON.parse(readFileSync(snapshot, 'utf8')).Stacks;
    if (!Array.isArray(stacks) || stacks.length !== 1) throw new Error('expected one stack snapshot');
    const stack = stacks[0];
    const result = inspectArtifactChangeSet({stack, changeSetId, artifactKey, submitted, fetchPage(next) {
      const args = ['cloudformation', 'describe-change-set', '--stack-name', stack.StackId, '--change-set-name', changeSetId,
        '--include-property-values', '--no-paginate', '--no-cli-pager', '--output', 'json'];
      if (next) args.push('--next-token', next);
      let response;
      try { response = execFileSync('aws', args, {encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000}); }
      catch { throw new Error('AWS DescribeChangeSet failed; proposal was not approved'); }
      try { return JSON.parse(response); }
      catch { throw new Error('invalid DescribeChangeSet JSON; proposal was not approved'); }
    }});
    // Keep property contexts in the runner only; do not print or upload them.
    writeFileSync(receipt, JSON.stringify(result.plan), {mode: 0o600});
    console.error(JSON.stringify({StackId: result.plan.StackId, ChangeSetId: result.plan.ChangeSetId,
      PreviousArtifactKey: stack.Parameters.find(row => row.ParameterKey === 'ArtifactKey').ParameterValue,
      IntendedArtifactKey: artifactKey, outcome: result.executionId ? 'artifact-only-approved' : 'verified-no-change'}));
    console.log(result.executionId || 'NO_CHANGES');
  } catch (error) {
    if (error.modeDiagnostic) console.error(JSON.stringify({outcome: 'artifact-only-rejected', reason: 'unsupported-proposal-mode', ...error.modeDiagnostic}));
    console.error(`Refusing artifact release: ${error instanceof SyntaxError ? 'invalid stack snapshot JSON' : error.message}`);
    process.exitCode = 1;
  }
}
