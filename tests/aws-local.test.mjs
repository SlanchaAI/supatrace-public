import test from 'node:test';
import assert from 'node:assert/strict';
import {handler} from '../aws/handler.mjs';

test('the lambda entry answers locally when AWS is not configured', async () => {
  for (const name of ['SUPATRACE_ENABLED', 'TABLE_NAME', 'PAYLOAD_BUCKET', 'GITHUB_SECRET_ARN', 'GITHUB_CLIENT_ID', 'GOOGLE_CLIENT_ID', 'GOOGLE_SECRET_ARN', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete process.env[name];
  const result = await handler({rawPath: '/api/me', requestContext: {http: {method: 'GET', sourceIp: '127.0.0.1'}}, headers: {}});
  assert.equal(result.statusCode, 503);
  assert.equal(JSON.parse(result.body).error, 'service_not_configured');
  assert.equal(result.headers['cache-control'], 'no-store');
});
