// /security and /enterprise state only what the repository supports. Every security fact is
// tied to the deployment template or source here, so a template change that makes the page
// wrong fails this test, and the pages cannot claim a certification, SLA or contact inbox
// that does not exist.
import {PLANS} from '../src/plans.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {CONTACT, salesContact, pageUrl} from '../scripts/site-pages.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const read = file => readFileSync(pageUrl(file), 'utf8');
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const template = readFileSync(repo + 'aws/template.yaml', 'utf8');
const security = read('security/index.html'), enterprise = read('enterprise/index.html');

test('each security fact on /security matches the deployment template or source', () => {
  const shown = text(security);
  const facts = [
    ['AWS us-east-1', /AWS_REGION: us-east-1/.test(readFileSync(repo + '.github/workflows/deploy.yml', 'utf8')) && /us-east-1/.test(template)],
    ['SSE-S3, AES-256', (template.match(/ServerSideEncryptionByDefault: \{SSEAlgorithm: AES256\}/g) || []).length === (template.match(/Type: AWS::S3::Bucket\n/g) || []).length && !/aws:kms/.test(template)],
    ['DynamoDB table has server-side encryption enabled', /SSESpecification: \{SSEEnabled: true\}/.test(template)],
    ['block all public access', (template.match(/RestrictPublicBuckets: true/g) || []).length === (template.match(/Type: AWS::S3::Bucket\n/g) || []).length],
    ['origin access control', /AWS::CloudFront::OriginAccessControl/.test(template)],
    ['redirects HTTP to HTTPS', /ViewerProtocolPolicy: redirect-to-https/.test(template)],
    ['TLSv1.2_2021', /MinimumProtocolVersion: TLSv1\.2_2021/.test(template)],
    ['HSTS for one year', /StrictTransportSecurity: \{AccessControlMaxAgeSec: 31536000/.test(template)],
    ['API origin is HTTPS only', /ViewerProtocolPolicy: https-only/.test(template)],
    ['HttpOnly, Secure and SameSite=Lax', /HttpOnly; Secure; SameSite=\$\{options\.sameSite\|\|'Lax'\}/.test(readFileSync(repo + 'src/aws-auth.mjs', 'utf8'))],
    ['SHA-256 digest of the session token', /createHash\('sha256'\)/.test(readFileSync(repo + 'src/aws-auth.mjs', 'utf8')) && /deleteSession\(digest\(token\)\)/.test(readFileSync(repo + 'src/aws-api.mjs', 'utf8'))],
    ['kept for 7 days', /RetentionInDays: 7\b/.test(template)],
    ['X-Frame-Options DENY', /frame-ancestors 'none'/.test(template) && /script-src 'self'/.test(template)],
    ['Google OAuth where configured', /GOOGLE_CLIENT_ID/.test(readFileSync(repo + 'src/aws-auth.mjs', 'utf8'))],
    ['Admin, Developer or Read-only', /Owners invite existing accounts and assign plan-enabled roles/.test(read('agent-setup.html'))]
  ];
  for (const [phrase, backed] of facts) {
    assert.ok(shown.includes(phrase), 'page states: ' + phrase);
    assert.ok(backed, 'repository backs: ' + phrase);
  }
  // Capture paths that store without a per-batch review are disclosed.
  assert.match(shown, /Claude Code hook beta uploads the events it captured when Claude completes if you enabled --upload-on-stop/);
  assert.ok(readFileSync(repo + 'agent/claude_hook.py', 'utf8').includes('--upload-on-stop'));
  assert.doesNotMatch(shown, /upload only batches you chose/);
  // The template default is separate from operator-enabled production acceptance.
  assert.match(template, /MfaEnabled:\n    Type: String\n    Default: 'false'/);
  assert.match(shown, /MFA is enabled on supatrace.dev; Enterprise SAML login and enforcement have live acceptance/);
});

test('/security lists what is not in place and claims no certification', () => {
  const shown = text(security);
  const missing = security.slice(security.indexOf('id="not-yet"'));
  for (const item of ['SOC 2:', 'ISO 27001:', 'HIPAA:', 'DPA:', 'Penetration test:', 'Security contact and disclosure policy:', 'Deletion:', 'Terms of service and privacy policy:']) assert.ok(missing.includes(`<strong>${item}</strong>`), item);
  assert.match(shown, /SupaTrace holds no security certification/);
  assert.doesNotMatch(shown, /SOC 2 (Type|compliant|certified)|ISO 27001 certified|HIPAA[- ]compliant|GDPR[- ]compliant|bank-grade|military-grade|end-to-end encrypt/i);
  // Only providers the deployment really uses are listed; Stripe is not live.
  const table = security.slice(security.indexOf('id="subprocessors"'), security.indexOf('id="not-yet"'));
  assert.deepEqual([...table.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map(match => match[1]), ['Amazon Web Services', 'GitHub', 'Google', 'Stripe', 'Cloudflare']);
  assert.doesNotMatch(table, /Datadog|Sentry|OpenAI|Anthropic/);
  // The verified inbox is published; a security.txt policy remains unavailable.
  assert.equal(CONTACT.security, 'security@supatrace.dev');
  assert.equal(existsSync(pageUrl('.well-known/security.txt')), false);
  assert.match(security, /mailto:security@supatrace\.dev/);
  assert.match(shown, /Stripe handles TEST-mode checkout/);
  assert.match(shown, /scheduled worker erases payload versions/);
  assert.match(shown, /Self-service account, organization, project and environment deletion/);
});

test('/enterprise offers no SLA, sells by contract, and marks what is available and what is not built', () => {
  const shown = text(enterprise);
  assert.match(shown, /No SLA document or support commitment is published yet/);
  assert.match(shown, /There is no self-serve checkout: you talk to sales and an operator assigns the plan/);
  assert.match(shown, /Terms are pending: no uptime percentage, service credit or response time has been decided/);
  assert.doesNotMatch(shown, /99\.\d|\b\d+ ?% uptime|guaranteed|we guarantee|dedicated support engineer|response within|SOC 2 (Type|compliant|certified)|\$\d/i);
  const rows = Object.fromEntries([...enterprise.matchAll(/<tr><th scope="row">([^<]+)<\/th><td><span class="status ([a-z]+)">([^<]+)<\/span>/g)].map(match => [match[1], [match[2], match[3]]]));
  // Built and gated by plan (tests/entitlements.test.mjs proves each gate).
  for (const name of ['Single sign-on (SAML)', 'SCIM provisioning', 'Audit log', 'Roles', 'Retention', 'Data export']) assert.equal(rows[name]?.[0], 'available', name);
  // Not built, or no terms: never shown as available.
  for (const name of ['Data residency', 'Private networking (VPC, PrivateLink)', 'Uptime SLA', 'Support SLA']) assert.equal(rows[name]?.[0], 'planned', name);
  assert.deepEqual(rows['Uptime SLA'], ['planned', 'terms pending']);
  // The page's retention numbers are the plan table's.
  for (const plan of PLANS.plans) assert.ok(shown.includes(plan.id === 'enterprise' ? '1 year on Enterprise' : plan.retention_days + (plan.id === 'free' ? ' days on Free' : ' on ' + plan.name)), plan.id + ' retention');
  assert.ok(read('pricing/index.html').includes('<a href="/enterprise/">What Enterprise includes</a>'));
});

test('sales and support route to the verified inbox without a form backend', () => {
  assert.equal(CONTACT.sales, 'support@supatrace.dev');
  assert.ok(enterprise.includes(salesContact()));
  assert.match(enterprise, /Sales and support share/);
  assert.doesNotMatch(enterprise, /Sales contact is not open yet/);
  assert.match(enterprise, /<form id="sales-form" data-to="support@supatrace\.dev">/);
  assert.match(read('app/index.html'), /href="mailto:support@supatrace\.dev">Contact support<\/a>/);
  const open = salesContact('sales@example.com'), script = read('enterprise/contact.js');
  assert.match(open, /<form id="sales-form" data-to="sales@example\.com">/);
  assert.match(open, /<script type="module" src="\/enterprise\/contact\.js"><\/script>/);
  assert.doesNotMatch(open, /action=|method=|https?:\/\//, 'no form endpoint or third party');
  // Without the script the form cannot submit (which would put the fields in a GET URL).
  assert.match(open, /<button class="button" type="submit" disabled>/);
  assert.match(script, /querySelector\('button\[type=submit\]'\)\.disabled = false/);
  assert.ok(script.indexOf('addEventListener') < script.indexOf('.disabled = false'), 'enabled only after the handler is attached');
  for (const field of ['name', 'email', 'company', 'size', 'message']) assert.ok(open.includes(`name="${field}"`), field);
  for (const bad of ['not-an-address', 'a@b', 'x@y.z"><script>', '']) assert.throws(() => salesContact(bad));
  assert.doesNotMatch(script, /fetch\(|XMLHttpRequest|sendBeacon|innerHTML/);
  assert.match(script, /encodeURIComponent/);
});
