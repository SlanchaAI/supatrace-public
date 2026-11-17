// Contract for issue #58 (one-tap approve link). No server, browser, Docker or network.
// Run: node --test tests/contracts/pairing-link.contract.mjs
// Interface: DynamoMetadataStore.createSetup(keyHash, projectId?, environmentId?) returns
// verification_uri that opens the Agents view with the setup code in the hash, so connect.py can print
// a link that approves in one tap:
//   default project:  /app/#agents?code=<user_code>
//   named project:    /app/?project=<proj_id>&environment=<env>#agents?code=<user_code>
// The path must still start with /app/ and stay at most 512 characters (agent/connect.py accepts only that).
import test from 'node:test';
import assert from 'node:assert/strict';
import {DynamoMetadataStore, digest} from '../../src/dynamodb-store.mjs';
import {MemoryDynamo, commandClasses} from '../memory-dynamo.mjs';

const store = () => new DynamoMetadataStore({client: new MemoryDynamo(), commands: commandClasses(), tableName: 'metadata'});
const key = digest('contract-key-58');

test('default-project setup returns a link that opens Agents with the code', async () => {
  const setup = await store().createSetup(key);
  assert.equal(setup.verification_uri, `/app/#agents?code=${setup.user_code}`);
});

test('named-project setup keeps project and environment, then opens Agents with the code', async () => {
  const project = 'proj_' + 'a'.repeat(32);
  const setup = await store().createSetup(key, project);
  assert.equal(setup.verification_uri, `/app/?project=${project}&environment=default#agents?code=${setup.user_code}`);
});

test('a named environment is carried into the link', async () => {
  const project = 'proj_' + 'c'.repeat(32);
  const setup = await store().createSetup(key, project, 'staging');
  assert.equal(setup.verification_uri, `/app/?project=${project}&environment=staging#agents?code=${setup.user_code}`);
});

test('link stays within what connect.py accepts', async () => {
  const setup = await store().createSetup(key);
  assert.ok(setup.verification_uri.startsWith('/app/') && setup.verification_uri.length <= 512);
});
