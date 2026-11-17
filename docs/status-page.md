# Status page

`/status/` is a static page. It does two things:

1. **Live checks from the visitor's browser** when the page loads: `GET /build.json` (the static site, and the served commit when the build marker is stamped) and `GET /api/auth/providers` (a public, unauthenticated API route). They show what that browser can reach at that moment. They are not monitoring and not history.
2. **A monitored status feed, if one is published** at `/status.json`. The repository copy has `"updated_at": null`, which the page reads as "no monitoring feed is published yet". Nothing in this repository writes the feed.

No AWS resource, stack parameter, DNS record or secret is needed for the page itself.

## Feed format

```json
{
  "schema": 1,
  "source": "name of the probe",
  "updated_at": "2026-11-14T20:00:00Z",
  "components": [
    {"name": "Uploads", "status": "operational", "note": "optional, up to 300 characters"},
    {"name": "Dashboard", "status": "degraded"}
  ],
  "incidents": [
    {"title": "Uploads rejected", "started_at": "2026-11-14T18:00:00Z", "resolved_at": "2026-11-14T18:20:00Z", "body": "optional"}
  ]
}
```

`status` is `operational`, `degraded` or `outage`. Timestamps are full ISO 8601 with a zone (`Z` or an offset) and must be real calendar dates. `public/status/feed.js` validates the feed: an unreadable feed shows no monitored status, and a feed with more than 20 components or incidents is rejected rather than truncated, and a feed whose `updated_at` is more than 15 minutes old, or more than 2 minutes in the future (allowance for a visitor's clock), is shown as out of date, never as current. Optional fields (`note`, `resolved_at`, `body`) may be omitted; a supplied value that is invalid or too long rejects the whole feed. The page classifies the feed it last fetched against the current time every few seconds and when the tab becomes visible, without waiting for the network, and fetches it again every minute, so an open page stops showing a feed as current once it ages out. A probe must therefore rewrite the file at least every 15 minutes, including when nothing changed.

## Operator actions (not done)

These need an operator and are deliberately outside this change:

- **Publish the feed.** Run a scheduled probe outside the SupaTrace stack (so it still reports when the stack is down) that checks the site, a public API route and the batch upload path, then writes `status.json` to the static bucket with `aws s3 cp status.json s3://<static bucket>/status.json --cache-control no-store`. That needs a writer identity limited to that one object; do not reuse the deploy role.
- **Caching: three steps are required when the probe goes live, or visitors keep seeing "no feed".** Static files are served through CloudFront with the managed `CachingOptimized` policy (`aws/template.yaml`, default behavior), whose default TTL is 24 hours. The Deploy workflow uploads every static file, the repository's placeholder `status.json` included, with `Cache-Control: no-cache`. Browsers revalidate each one before using it, and CloudFront keeps a copy for at most the policy's one-second minimum. A release still overwrites whatever the probe last wrote, and a copy cached before that header existed can linger until it is invalidated.
  1. Exclude the file from the release upload before the first probe write: add `--exclude "status.json"` to the `aws s3 cp public/` step in `.github/workflows/deploy.yml`. Otherwise every release re-uploads the cacheable placeholder over the probe's file.
  2. Always write the feed with `--cache-control no-store`, so CloudFront keeps each probe-written copy only for the policy's one-second minimum.
  3. After the first probe write, run one invalidation: `aws cloudfront create-invalidation --distribution-id <id> --paths /status.json`. This removes any cached placeholder. It is needed once, not per write.

  None of these change a stack resource. Giving `/status.json` its own cache behavior with caching disabled would also work, but that is a template change.
- **Upload probe caveat.** The upload path exists today: `POST /api/batches`, the route `agent/upload.py` uses, authenticated with a write key. A probe should use a dedicated write key in a dedicated account and re-send one fixed synthetic batch, which the setup guide describes as idempotent. Confirm on that account that a repeat consumes neither more of the monthly span allowance (50,000 spans per UTC month on Free, which resets) nor more stored bytes (1 GB on Free, cumulative, which does not reset) before scheduling it. The alpha-wide cap of 50 GiB across the service applies too. Ingest keys from Home or API keys do not expire by default; agent-pairing keys last 30 days. Hosted OTLP/HTTP trace ingest is available on supatrace.dev.
- **Hosted status page.** For `status.supatrace.dev`, choose a managed status provider, add the one DNS record it asks for in Cloudflare (the only DNS change #120 allows), and point its monitors at `https://supatrace.dev/build.json` and `https://supatrace.dev/api/auth/providers`. Then link it from the `/status/` page. Email or RSS subscription and incident history come from that provider.
- **`GET /api/health`** with component checks is not implemented; #120 still tracks it.
