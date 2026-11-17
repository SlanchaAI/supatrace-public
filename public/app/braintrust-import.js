import {normalizeBraintrustScope} from './braintrust-scope.js';

// This module prepares the existing local runner's spec. It never reads tokens,
// fetches a source, submits a job, persists form values, or uploads trace data.
export function mountBraintrustImport({document, getProject, download, clipboard} = {}) {
  const $ = id => document.getElementById(id);
  let draft = null, generation = 0;
  const status = text => { $('braintrust-status').textContent = text; };
  function invalidate(message = 'Scope changed. Review it again before downloading.') {
    generation++; draft = null;
    $('braintrust-output').hidden = true;
    $('braintrust-spec').textContent = '';
    $('braintrust-command').textContent = '';
    $('braintrust-reviewed').checked = false;
    $('braintrust-download').disabled = true;
    $('braintrust-copy').disabled = true;
    status(message);
  }
  function current() {
    return draft && draft.scope.destinationProject === getProject();
  }
  function mayUse() {
    if (!current()) { invalidate('Workspace needs rechecking. Reload and review the scope again.'); return false; }
    return $('braintrust-reviewed').checked;
  }
  $('braintrust-form').oninput = () => invalidate();
  $('braintrust-form').onsubmit = event => {
    event.preventDefault(); invalidate();
    try {
      const roots = $('braintrust-roots').value.trim().split(/\r?\n/).map(v => v.trim());
      const scope = normalizeBraintrustScope({
        origin: $('braintrust-origin').value,
        sourceProject: $('braintrust-source').value.trim(),
        destinationProject: getProject(),
        namespace: $('braintrust-namespace').value.trim(),
        rootSpanIds: roots,
        content: $('braintrust-content').checked ? 'include' : 'metadata',
        maxRows: Number($('braintrust-rows').value),
        maxPages: Number($('braintrust-pages').value),
        pageSize: Number($('braintrust-page-size').value),
        maxRetries: 2, maxBytes: 12582912
      });
      draft = {scope, json: JSON.stringify(scope, null, 2) + '\n'};
      $('braintrust-spec').textContent = draft.json;
      $('braintrust-command').textContent = 'node agent/import_braintrust.mjs braintrust-import.json /absolute/private/workspace --fetch --stage' + (scope.content === 'include' ? ' --include-content' : '');
      $('braintrust-output').hidden = false;
      status('Scope ready for review. Nothing has been fetched, staged or uploaded.');
    } catch {
      status('Check the source project UUID, 1–25 distinct root span IDs, namespace and limits. Use letters, numbers, dots, underscores, colons or hyphens for IDs and namespace. Your destination workspace must be available.');
    }
  };
  $('braintrust-reviewed').onchange = () => {
    const enabled = mayUse();
    $('braintrust-download').disabled = !enabled;
    $('braintrust-copy').disabled = !enabled;
  };
  $('braintrust-download').onclick = () => {
    if (!mayUse()) return;
    try {
      const blob = new Blob([draft.json], {type: 'application/json'});
      if (download) download(blob, 'braintrust-import.json');
      else {
        const href = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = href; link.download = 'braintrust-import.json'; link.click();
        setTimeout(() => URL.revokeObjectURL(href), 1000);
      }
      status('Spec download requested. Check browser downloads; no import has started.');
    } catch { status('Spec download failed. You can copy the reviewed JSON instead.'); }
  };
  $('braintrust-copy').onclick = async () => {
    if (!mayUse()) return;
    const version = generation;
    try {
      const writer = clipboard ?? globalThis.navigator?.clipboard;
      if (!writer) throw Error('clipboard_unavailable');
      await writer.writeText(draft.json);
      if (version === generation) status('Reviewed spec copied. Save it as braintrust-import.json; no import has started.');
    } catch { if (version === generation) status('Clipboard unavailable. Select and copy the reviewed JSON or download it.'); }
  };
  return {invalidate};
}
