import test from 'node:test';
import assert from 'node:assert/strict';
import {start as startHarness} from './harness.mjs';
// Pro: the invitation in this scenario carries the Read-only (viewer) role, which the Free plan does not include.
const start = (options = {}) => startHarness({plan: 'pro', ...options});
import {launch} from './browser.mjs';

test('an invited account finds and accepts its invitation in the dashboard without the link',async()=>{
 const live=await start(),browser=await launch(),contexts=[];
 try{
  const make=async id=>{const c=await browser.newContext();contexts.push(c);await c.route(/^(?!http:\/\/127\.0\.0\.1)/,r=>r.abort());const tenant=await live.signIn(c,id);return {c,tenant,p:await c.newPage()};};
  const owner=await make(4242),member=await make(5252),outsider=await make(6262),errors=[];
  for(const who of [owner,member,outsider])who.p.on('pageerror',e=>errors.push(e.message));
  await owner.p.goto(live.origin+'/app/#members');await owner.p.locator('#shell:not([hidden])').waitFor();
  await owner.p.locator('#share-workspace input').fill('Product team');await owner.p.locator('#share-workspace button').click();await owner.p.locator('#team-members:not([hidden])').waitFor();
  await owner.p.locator('#invite-member input').fill(member.tenant);await owner.p.locator('#invite-member select').selectOption('viewer');await owner.p.locator('#invite-member button').click();
  await owner.p.locator('#invitation-link a').waitFor();
  // The owner and an uninvolved account see no pending invitation.
  await outsider.p.goto(live.origin+'/app/#members');await outsider.p.locator('#shell:not([hidden])').waitFor();
  assert.equal(await outsider.p.locator('#pending-invitations').isHidden(),true);assert.equal(await outsider.p.locator('.pending-invite').count(),0);
  assert.equal(await owner.p.locator('.pending-invite').count(),0);
  // The invitee opens the plain dashboard URL: no joinWorkspace or invite parameter anywhere.
  await member.p.goto(live.origin+'/app/');await member.p.locator('#shell:not([hidden])').waitFor();
  assert.equal(new URL(member.p.url()).search,'');
  assert.match(await member.p.locator('#scope-notice').innerText(),/1 pending workspace invitation/);
  await member.p.locator('#scope-notice a').click();await member.p.locator('#pending-invitations:not([hidden])').waitFor();
  const row=member.p.locator('.pending-invite');assert.equal(await row.count(),1);
  const text=await row.innerText();assert.match(text,/Product team/);assert.match(text,/viewer/);assert.ok(text.includes(owner.tenant));
  await row.locator('button').click();await member.p.waitForURL(u=>u.searchParams.get('workspace')===owner.tenant);await member.p.locator('#shell:not([hidden])').waitFor();
  assert.match(await member.p.locator('#members-role').innerText(),/viewer/);
  assert.equal(await member.p.locator('.pending-invite').count(),0);assert.equal(await member.p.locator('#pending-invitations').isHidden(),true);
  assert.deepEqual(errors,[]);
 }finally{await Promise.all(contexts.map(c=>c.close()));await browser.close();await live.close();}
});
