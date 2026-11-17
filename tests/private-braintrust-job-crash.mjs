// Synthetic subprocess fixture only. Never contacts a provider.
import {createPrivateBraintrustJobs} from '../src/importers/private-braintrust-jobs.mjs';
import {alphaProject} from '../src/alpha-projects.mjs';
import {fakeOptions, row} from './braintrust-fixtures.mjs';
const fake = fakeOptions([{data: {data: [row()], cursor: 'next'}}, () => {process.stdout.write('checkpoint-saved\n');return new Promise(() => {});}]);
const owner = {tenantId: 'github-4242', projectId: alphaProject('github-4242').id};
await createPrivateBraintrustJobs({...fake.options, directory: process.argv[2]}).execute(owner, process.argv[3]);
