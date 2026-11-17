// Keep the SupaTrace SDK out of the server bundle: it is plain Node ESM that reads and
// writes local files.
export default { serverExternalPackages: ["@supatrace/client"] };
