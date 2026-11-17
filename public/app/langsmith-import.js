import {normalizeLangsmithScope} from './langsmith-scope.js';

// This module prepares the existing local runner's spec. It never reads tokens,
// fetches a source, submits a job, persists form values, or uploads trace data.
export function mountLangsmithImport({document, getProject, download, clipboard} = {}) {
  const $ = id => document.getElementById(id);
  let draft = null, generation = 0;
  const status = text => { $('langsmith-status').textContent = text; };
  function invalidate(message = 'Scope changed. Review it again before downloading.') {
    generation++; draft = null;
    $('langsmith-output').hidden = true;
    $('langsmith-spec').textContent = '';
    $('langsmith-command').textContent = '';
    $('langsmith-reviewed').checked = false;
    $('langsmith-download').disabled = true;
    $('langsmith-copy').disabled = true;
    status(message);
  }
  function current() {
    return draft && draft.scope.destinationProject === getProject();
  }
  function mayUse() {
    if (!current()) { invalidate('Workspace needs rechecking. Reload and review the scope again.'); return false; }
    return $('langsmith-reviewed').checked;
  }
  $('langsmith-form').oninput = () => invalidate();
  $('langsmith-form').onsubmit = event => {
    event.preventDefault(); invalidate();
    try {
      const traces = $('langsmith-traces').value.trim().split(/\r?\n/).map(v => v.trim());
      const scope = normalizeLangsmithScope({
        origin: $('langsmith-origin').value,
        sourceProject: $('langsmith-source').value.trim(),
        destinationProject: getProject(),
        namespace: $('langsmith-namespace').value.trim(),
        traceIds: traces,
        sourceWorkspace: $('langsmith-workspace').value.trim(),
        minStartTime: $('langsmith-from').value.trim(),
        maxStartTime: $('langsmith-to').value.trim(),
        content: $('langsmith-content').checked ? 'include' : 'metadata',
        maxRows: Number($('langsmith-rows').value),
        maxPages: Number($('langsmith-pages').value),
        pageSize: Number($('langsmith-page-size').value),
        maxRetries: 2, maxBytes: 12582912
      });
      draft = {scope, json: JSON.stringify(scope, null, 2) + '\n'};
      $('langsmith-spec').textContent = draft.json;
      $('langsmith-command').textContent = 'node agent/import_langsmith.mjs langsmith-import.json /absolute/private/workspace --fetch --stage' + (scope.content === 'include' ? ' --include-content' : '');
      $('langsmith-output').hidden = false;
      status('Scope ready for review. Nothing has been fetched, staged or uploaded.');
    } catch {
      status('Check workspace/project UUIDs, 1–25 distinct trace UUIDs, namespace and limits. Use valid UTC timestamps ending in Z, with an increasing window of at most 401 days. Your destination workspace must be available.');
    }
  };
  $('langsmith-reviewed').onchange = () => {
    const enabled = mayUse();
    $('langsmith-download').disabled = !enabled;
    $('langsmith-copy').disabled = !enabled;
  };
  $('langsmith-download').onclick = () => {
    if (!mayUse()) return;
    try {
      const blob = new Blob([draft.json], {type: 'application/json'});
      if (download) download(blob, 'langsmith-import.json');
      else {
        const href = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = href; link.download = 'langsmith-import.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }
      status('Spec download requested. Check browser downloads; no import has started.');
    } catch { status('Spec download failed. You can copy the reviewed JSON instead.'); }
  };
  $('langsmith-copy').onclick = async () => {
    if (!mayUse()) return;
    const version = generation;
    try {
      const writer = clipboard ?? globalThis.navigator?.clipboard;
      if (!writer) throw Error('clipboard_unavailable');
      await writer.writeText(draft.json);
      if (version === generation) status('Reviewed spec copied. Save it as langsmith-import.json; no import has started.');
    } catch { if (version === generation) status('Clipboard unavailable. Select and copy the reviewed JSON or download it.'); }
  };
  return {invalidate};
}
