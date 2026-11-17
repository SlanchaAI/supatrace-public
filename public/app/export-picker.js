// Only picker rejection can trigger a standard-download fallback. Once a file
// opens, read/write failures must retain the streaming writer's integrity checks.
export const PICKER_CANCEL_MIN_MS = 750;
export async function pickExportFile(pick, options, clock = () => performance.now()) {
 const started = clock();
 try { return await pick(options); }
 catch (error) {
  // Automated Chromium can reject immediately without ever showing a dialog.
  const cancelled = error?.name === 'AbortError' && clock() - started >= PICKER_CANCEL_MIN_MS;
  const failure = new Error(cancelled ? 'export_file_cancelled' : 'export_picker_unavailable');
  if (cancelled) failure.pickerCancelled = true;
  throw failure;
 }
}
