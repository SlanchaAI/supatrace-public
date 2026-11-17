// Only picker rejection can trigger a standard-download fallback. Once a file
// opens, read/write failures must retain the streaming writer's integrity checks.
export async function pickExportFile(pick, options) {
 try { return await pick(options); }
 catch (error) {
  throw new Error(error?.name === 'AbortError' ? 'export_file_cancelled' : 'export_picker_unavailable');
 }
}
