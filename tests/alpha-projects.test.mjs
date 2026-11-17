import test from 'node:test';
import assert from 'node:assert/strict';
import {alphaProject, requireAlphaProject} from '../src/alpha-projects.mjs';

test('one stable project id per GitHub account', () => {
  const project = alphaProject('github-42');
  assert.equal(project.id, alphaProject('github-42').id);
  assert.match(project.id, /^proj_[a-f0-9]{32}$/);
  assert.equal(project.name, 'Default project');
  assert.equal(project.additional_projects_available, false);
  assert.notEqual(project.id, alphaProject('github-43').id);
});

test('project check accepts a Google account id and rejects a different project', () => {
  const googleId = 'google-' + 'ab'.repeat(32);
  const project = alphaProject(googleId);
  assert.match(project.id, /^proj_[a-f0-9]{32}$/);
  assert.equal(requireAlphaProject(googleId, project.id).id, project.id);
  assert.equal(project.additional_projects_available, false);
  for (const requested of [null, undefined, alphaProject('github-7').id]) {
    assert.equal(requireAlphaProject('github-7', requested).id, alphaProject('github-7').id);
  }
  assert.throws(() => requireAlphaProject('github-7', ''), error => error.code === 'project_unavailable');
  assert.notEqual(project.id, alphaProject('github-7').id);
  assert.throws(() => requireAlphaProject('github-7', 'proj_' + 'cd'.repeat(16)), error => error.status === 403 && error.code === 'project_unavailable');
  assert.throws(() => alphaProject('google-ab'), error => error.code === 'invalid_tenant');
});
