# Trace drains

A drain is an HTTPS webhook that receives every batch the workspace accepts, signed, so traces can flow on to your own systems.

## Add a drain

Open **Settings** in the workspace and add the address under **Trace drains**. Workspace owners and admins can manage drains; a workspace can have up to 3. The signing secret is shown once, when the drain is created.

- **Public HTTPS only.** The address must be `https://` with a host name and the default port. IP addresses, internal names and addresses that resolve to private, loopback or link-local ranges are refused. Redirects are not followed.
- **Every environment.** A drain receives accepted batches from all environments of the workspace; each delivery names its environment.
- **Send test** posts a signed `drain.test` event so you can check your receiver.

## What is delivered

One `POST` per accepted batch, with `Content-Type: application/json`:

```json
{
  "id": "5f1c0e…",
  "type": "batch.accepted",
  "created_at": "2026-11-14T20:00:00.000Z",
  "workspace_id": "…",
  "project_id": "proj_…",
  "environment_id": "default",
  "batch_id": "…",
  "run_id": "…",
  "request_hash": "…",
  "event_count": 2,
  "byte_count": 412,
  "batch": {"version": 1, "batch_id": "…", "run_id": "…", "events": []}
}
```

`batch` is the stored batch, up to 512 KiB. It can contain prompts, tool output and secrets, exactly as uploaded. `id` is the same on every retry of one delivery; use it to ignore duplicates.

## Verify the signature

Each request carries `X-Supatrace-Signature: t=<unix seconds>,v1=<hex>`. The value of `v1` is the HMAC-SHA256 of `<t>.<raw request body>` with the signing secret. Compare in constant time and reject old timestamps.

```js
import {createHmac, timingSafeEqual} from 'node:crypto';

function verified(secret, header, rawBody) {
  const match = /^t=(\d+),v1=([a-f0-9]{64})$/.exec(header || '');
  if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300) return false;
  const expected = createHmac('sha256', secret).update(match[1] + '.' + rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(match[2], 'hex'));
}
```

## Delivery and retries

- **Retried, not guaranteed.** A delivery is queued once its batch is accepted, before the upload is answered. If an upload fails after the batch was accepted, resending it within a day queues the delivery. A queued delivery is removed when the endpoint answers `2xx` within 3 seconds, or when it is given up (see below). A failing endpoint never fails an upload.
- **Possibly more than once.** The same delivery can arrive twice, for example when your `2xx` is lost. Use `id` to ignore repeats.
- **When attempts happen.** Queued deliveries are attempted right after uploads to the workspace, oldest first, and when you press **Deliver queued now**. There is no background scheduler yet: if uploads stop, queued deliveries wait for the next upload or the button.
- **Failures pause the drain** for 30 seconds, then 1, 5, 15 and 60 minutes, so a dead endpoint does not slow uploads.
- **When a delivery is given up.** After 8 failed attempts or 3 days it is removed and counted as failed. It is not retried again. The batch itself stays stored and exportable.
- **Queue limit.** Up to 500 deliveries wait per drain. A batch accepted while the queue is full is not delivered to that drain; it is counted as dropped, once.
- **Uploads can take longer.** An upload request may spend up to about 8 seconds attempting deliveries before it answers; whatever is unfinished stays queued.
- **Cost.** Each authenticated ingest request makes one extra DynamoDB query to find the workspace's drains.

## Not available yet

- Drains to an S3 bucket, Datadog or an OTLP endpoint.
- Background retries on a schedule, a per-delivery log and replay of failed deliveries.
- Per-project or per-environment drains, event filters and secret rotation (delete and add the drain again).
- Plan gating and billing for drains. The proposed plans treat drains as a Team add-on; nothing is charged in this alpha.
- A page for drains on the public docs site.
