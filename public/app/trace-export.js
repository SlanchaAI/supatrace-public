// A single-trace version-1 writer. The caller supplies the existing validated,
// project-bound event traversal; no new endpoint, fallback or stored handle.
export const TRACE_FILE_TIMEOUT_MS = 120000;
const fail = code => { throw new Error(code); };
const check = signal => { if (signal?.aborted) fail('export_file_cancelled'); };

function fileStep(work, {signal, timeoutMs, onLate} = {}) {
  check(signal);
  return new Promise((resolve, reject) => {
    let settled = false, timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error('export_file_cancelled'));
    signal?.addEventListener('abort', abort, {once:true});
    if (timeoutMs) timer = setTimeout(() => finish(reject, new Error('export_file_unconfirmed')), timeoutMs);
    let result;
    try { result = work(); } catch (error) { finish(reject, error); return; }
    Promise.resolve(result).then(value => {
      if (settled) {
        if (onLate) Promise.resolve().then(() => onLate(value)).catch(() => {});
        return;
      }
      finish(resolve, value);
    }, error => finish(reject, error));
  });
}

export async function saveTraceFile({runId, projectId, environmentId='default', signal = new AbortController().signal,
  pick, readEvents, onCommit = () => {}, fileTimeoutMs = TRACE_FILE_TIMEOUT_MS} = {}) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(environmentId) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(runId || '') ||
      !/^proj_[a-f0-9]{32}$/.test(projectId || '') ||
      ![pick, readEvents, onCommit].every(value => typeof value === 'function') ||
      !Number.isSafeInteger(fileTimeoutMs) || fileTimeoutMs < 1 || fileTimeoutMs > TRACE_FILE_TIMEOUT_MS) {
    fail('export_file_unconfirmed');
  }
  let writable, committing = false, active = true, first = true, count = 0;
  const abortFile = stream => fileStep(() => stream.abort(), {timeoutMs:fileTimeoutMs});
  const write = text => {
    if (!active) fail('export_file_unconfirmed');
    return fileStep(() => writable.write(text), {signal, timeoutMs:fileTimeoutMs});
  };
  try {
    // Dispatch within the click gesture. Choosing a file has no deadline, but
    // cancelling/navigation stops the wait and a late selection is never used.
    const handle = await fileStep(() => pick({suggestedName:'supatrace-run.json',
      types:[{description:'SupaTrace JSON', accept:{'application/json':['.json']}}]}), {signal});
    check(signal);
    writable = await fileStep(() => handle.createWritable({keepExistingData:false}),
      {signal, timeoutMs:fileTimeoutMs, onLate:abortFile});
    check(signal);
    await write('{"version":1,"run_id":' + JSON.stringify(runId) + (environmentId!=='default'?',"project_id":'+JSON.stringify(projectId)+',"environment_id":'+JSON.stringify(environmentId):'') + ',"events":[');
    const result = await readEvents(runId, signal, async events => {
      if (!active || !Array.isArray(events)) fail('export_file_unconfirmed');
      for (const event of events) {
        check(signal);
        const json = JSON.stringify(event);
        if (typeof json !== 'string') fail('export_file_unconfirmed');
        await write((first ? '' : ',') + json);
        first = false;
        count++;
        if (!Number.isSafeInteger(count)) fail('export_file_unconfirmed');
      }
    }, projectId);
    check(signal);
    if (result?.events !== count) fail('export_file_unconfirmed');
    await write(']}');
    check(signal);
    onCommit();
    check(signal);
    active = false;
    committing = true;
    // A timeout here cannot establish rollback. Ignore cancellation once close
    // starts and never turn late completion into a second success result.
    await fileStep(() => writable.close(), {timeoutMs:fileTimeoutMs});
    return count;
  } catch (error) {
    active = false;
    if (committing) fail('export_file_unconfirmed');
    if (writable) {
      try { await abortFile(writable); } catch { fail('export_file_unconfirmed'); }
    }
    if (error?.name === 'AbortError' || signal.aborted || error?.message === 'export_file_cancelled') {
      fail('export_file_cancelled');
    }
    fail('export_file_unconfirmed');
  } finally {
    active = false;
  }
}
