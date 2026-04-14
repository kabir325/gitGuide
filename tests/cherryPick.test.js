import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing } from '../src/commands/cherryPick.js';

test('parseRecentCommits parses oneline log', () => {
  const input = [
    'abc1234 (HEAD -> main) feat: hello world',
    'def5678 fix: something',
    '',
    '  9876fed chore: spaced  '
  ].join('\n');

  const parsed = __testing.parseRecentCommits(input);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], { sha: 'abc1234', subject: '(HEAD -> main) feat: hello world' });
  assert.deepEqual(parsed[1], { sha: 'def5678', subject: 'fix: something' });
  assert.deepEqual(parsed[2], { sha: '9876fed', subject: 'chore: spaced' });
});

test('validateCommits de-duplicates and filters empty entries', () => {
  const commits = __testing.normalizeCommits(['', 'a', 'a', ' b ', 'b']);
  assert.deepEqual(commits, ['a', 'b']);
});
