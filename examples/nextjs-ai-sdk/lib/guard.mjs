// The chat route spends the operator's provider key and has no sign-in, so it only answers
// this app's own page on this machine:
//   - Host must be a loopback authority. A hostile hostname that resolves to 127.0.0.1
//     (DNS rebinding) arrives with that hostname in Host and is refused.
//   - The body must be application/json, which another site cannot send without a CORS
//     preflight this route never answers.
//   - Origin, when present, must be the same loopback authority, and Sec-Fetch-Site must
//     not say the request came from another site.
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const loopback = authority => {
  if (typeof authority !== "string" || !/^[a-z0-9.:[\]-]+$/i.test(authority)) return false;
  const host = authority.replace(/:\d{1,5}$/, "").toLowerCase();
  return LOOPBACK.has(host);
};

export function rejectCrossSite(request) {
  const host = request.headers.get("host");
  if (!loopback(host)) return { status: 403, error: "host_refused" };
  const type = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "json_required" };
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return { status: 403, error: "cross_site_refused" };
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { originHost = null; }
    if (originHost === null || originHost.toLowerCase() !== host.toLowerCase()) return { status: 403, error: "cross_site_refused" };
  }
  return null;
}
