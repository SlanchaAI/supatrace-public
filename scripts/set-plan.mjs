#!/usr/bin/env node
// Operator action: assign a plan to an organization without Stripe, or clear an operator-assigned plan.
// Enterprise has no self-serve checkout, so this is how an organization gets it after a contract.
//
//   node scripts/set-plan.mjs <table> <organization-id> <enterprise|pro|base|none> [--execute] [--keep-subscription]
//
// <organization-id> is the workspace id shown in Settings (for example github-12345 or org-<32 hex>).
// Without --execute it only prints what it would write. It needs AWS credentials that may update the metadata table.
// A plan assigned here is never changed by a Stripe subscription (src/plan-billing.mjs); `none` returns the
// organization to Free, or to whatever a later Checkout buys.
import {DynamoDBClient} from '@aws-sdk/client-dynamodb';
import {DynamoDBDocumentClient, GetCommand, TransactWriteCommand} from '@aws-sdk/lib-dynamodb';
import {operatorPlanUpdate} from '../src/plan-billing.mjs';
import {auditPut} from '../src/audit.mjs';
import {planOf} from '../src/entitlements.mjs';

const [table, org, wanted, ...flags] = process.argv.slice(2), flag = flags.includes('--execute') ? '--execute' : undefined, keep = flags.includes('--keep-subscription');
if (!table || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(org ?? '') || !wanted || flags.some(value => !['--execute', '--keep-subscription'].includes(value))) { console.error('usage: node scripts/set-plan.mjs <table> <organization-id> <enterprise|pro|base|none> [--execute] [--keep-subscription]'); process.exit(2); }
const plan = wanted === 'none' ? null : wanted, now = Math.floor(Date.now() / 1000);
const update = operatorPlanUpdate(org, plan, now);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({region: process.env.AWS_REGION || 'us-east-1'}));
const row = (await client.send(new GetCommand({TableName: table, Key: update.Key, ConsistentRead: true}))).Item;
if (!row) { console.error('No account row for ' + org + ' in ' + table + '.'); process.exit(1); }
const before = {plan: planOf(row.plan_id).id, source: row.plan_source ?? 'default'};
// An organization that pays through Stripe keeps being billed after an operator assignment, and Stripe can no longer
// change its plan. Cancel the subscription in Stripe first, or pass --keep-subscription to say that is intended.
if (plan !== null && typeof row.stripe_subscription_id === 'string' && !keep) { console.error('This organization has a Stripe subscription (' + (row.stripe_subscription_status ?? 'unknown') + '). Cancel it in Stripe first, or pass --keep-subscription.'); process.exit(1); }
console.log(JSON.stringify({organization: org, before, after: {plan: plan ?? 'free', source: plan ? 'operator' : 'default'}, execute: flag === '--execute'}));
if (flag !== '--execute') { console.log('Dry run: nothing was written. Add --execute to apply.'); process.exit(0); }
const event = auditPut(now, {workspace: org, actor: 'operator', ip: 'operator'}, 'billing.plan_changed', org, {from: before.plan, to: plan ?? 'free', source: 'operator'});
await client.send(new TransactWriteCommand({TransactItems: [{Update: {TableName: table, ...update}}, {Put: {TableName: table, ...event.Put}}]}));
console.log('Plan for ' + org + ' is now ' + (plan ?? 'free') + '.');
