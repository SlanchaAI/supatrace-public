// Two-factor discoverability (issue #90): the Settings summary states the real state, the template default is unchanged,
// and the documented operator action names the real stack, parameter and function.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MFA_STATES, mfaState} from '../public/app/mfa-status.js';
import {deployParameters, templateParameterNames, templateParameterDefaults} from '../aws/deploy-parameters.mjs';
import {mfaEnabled} from '../src/dashboard-auth.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');

test('the summary state follows what the server reported, and says unavailable when the switch is off', () => {
  assert.equal(mfaState({sectionHidden: true, enrollHidden: false}), 'unavailable'); assert.equal(mfaState({sectionHidden: true, enrollHidden: true}), 'unavailable');
  assert.equal(mfaState({sectionHidden: false, enrollHidden: false}), 'off'); assert.equal(mfaState({sectionHidden: false, enrollHidden: true}), 'on');
  assert.equal(MFA_STATES.unavailable.action, null); assert.match(MFA_STATES.unavailable.text, /not available on this deployment/);
  assert.match(MFA_STATES.off.action, /^Set up /); assert.match(MFA_STATES.on.action, /^Manage /);
  const app = read('public/app/app.js');
  assert.match(app, /^import '\.\/mfa-status\.js';$/m);
  // The two signals the summary reads are the ones app.js sets from /api/me.
  assert.ok(app.includes("$('mfa-section').hidden=me.mfa_enabled!==true")); assert.ok(app.includes("$('mfa-enroll').hidden=enrolled"));
});

test('the template default stays off and a normal deploy keeps whatever the operator set', () => {
  const template = read('aws/template.yaml');
  assert.equal(templateParameterDefaults(template).MfaEnabled, 'false'); assert.match(template, /MFA_ENABLED: !Ref MfaEnabled/);
  assert.equal(mfaEnabled({MFA_ENABLED: 'true'}), true); assert.equal(mfaEnabled({MFA_ENABLED: 'false'}), false); assert.equal(mfaEnabled({}), false);
  const names = templateParameterNames(template), live = names.map(name => ({ParameterKey: name, ParameterValue: name === 'MfaEnabled' ? 'true' : 'x'}));
  const next = deployParameters(names, live, 'releases/abc/supatrace-lambda.zip', templateParameterDefaults(template));
  assert.deepEqual(next.find(parameter => parameter.ParameterKey === 'MfaEnabled'), {ParameterKey: 'MfaEnabled', UsePreviousValue: true}, 'an operator-enabled switch survives later deploys');
});

test('the documented operator action matches the repository', () => {
  const doc = read('docs/sign-in.md'), deploy = read('.github/workflows/deploy.yml'), template = read('aws/template.yaml');
  const section = doc.slice(doc.indexOf('### Turning two-factor authentication on (operator)'), doc.indexOf('## SSO'));
  assert.ok(section.includes('${STACK_NAME:?set your deployment stack name}'));
  assert.ok(deploy.includes('AWS_REGION: us-east-1') && section.includes('--region us-east-1'));
  assert.ok(section.includes('ParameterKey:k,ParameterValue:"true"') && section.includes('UsePreviousValue:true') && section.includes('--use-previous-template') && section.includes('CAPABILITY_NAMED_IAM'));
  // The function whose environment carries the switch is the logical resource the doc tells the operator to expect.
  const api = template.slice(template.indexOf('\n  Api:\n'), template.indexOf('\n  ApiUrl:\n')); assert.match(api, /Type: AWS::Lambda::Function/); assert.match(api, /MFA_ENABLED: !Ref MfaEnabled/);
  assert.match(section, /Modify, Api, False/); assert.match(section, /have not been run by this change/); assert.match(section, /"mfa_enabled":true/);
  assert.match(read('src/dashboard-auth.mjs'), /mfa_enabled:mfaEnabled\(env\)/);
  assert.doesNotMatch(doc, /\bMenu\b/, 'the controls are in Settings');
  assert.match(read('docs/sign-in.md'), /MFA is enabled on supatrace.dev/);
});
