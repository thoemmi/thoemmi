const assert = require('node:assert/strict');
const test = require('node:test');

const {
  renderActivity,
  replaceActivitySection,
} = require('./update-recent-activity.cjs');
const updateRecentActivity = require('./update-recent-activity.cjs');

test('renders current reduced event payloads without padding or undefined values', () => {
  const events = [
    {
      type: 'PushEvent',
      repo: { name: 'thoemmi/thoemmi' },
      payload: { head: 'profile-commit' },
    },
    {
      type: 'DiscussionEvent',
      repo: { name: 'example/discussions' },
      payload: { action: 'created' },
    },
    {
      type: 'PullRequestEvent',
      repo: { name: 'meziantou/Meziantou.Framework' },
      payload: {
        action: 'merged',
        number: 1795,
        pull_request: {
          number: 1795,
          url: 'https://api.github.com/repos/meziantou/Meziantou.Framework/pulls/1795',
        },
      },
    },
    {
      type: 'PullRequestEvent',
      repo: { name: 'meziantou/Meziantou.Framework' },
      payload: {
        action: 'opened',
        number: 1795,
        pull_request: { number: 1795 },
      },
    },
    {
      type: 'PushEvent',
      repo: { name: 'thoemmi/7Zip4Powershell' },
      payload: {
        before: 'previous',
        head: '2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb',
        ref: 'refs/heads/master',
      },
    },
  ];

  const lines = renderActivity(events, new Set(['thoemmi/thoemmi']));

  assert.deepEqual(lines, [
    '1. 🎉 Merged PR [#1795](https://github.com/meziantou/Meziantou.Framework/pull/1795) in [meziantou/Meziantou.Framework](https://github.com/meziantou/Meziantou.Framework)',
    '2. 💪 Opened PR [#1795](https://github.com/meziantou/Meziantou.Framework/pull/1795) in [meziantou/Meziantou.Framework](https://github.com/meziantou/Meziantou.Framework)',
    '3. ⬆️ Pushed to [thoemmi/7Zip4Powershell](https://github.com/thoemmi/7Zip4Powershell/commit/2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb)',
  ]);
  assert.doesNotMatch(lines.join('\n'), /undefined|^4\./m);
});

test('renders issues, reviews, and releases from stable identifiers', () => {
  const events = [
    {
      type: 'IssuesEvent',
      repo: { name: 'owner/project' },
      payload: { action: 'opened', issue: { number: 42 } },
    },
    {
      type: 'PullRequestReviewEvent',
      repo: { name: 'owner/project' },
      payload: { action: 'created', pull_request: { number: 43 } },
    },
    {
      type: 'ReleaseEvent',
      repo: { name: 'owner/project' },
      payload: { action: 'published', release: { tag_name: 'v1.2.3' } },
    },
  ];

  assert.deepEqual(renderActivity(events), [
    '1. ❗ Opened issue [#42](https://github.com/owner/project/issues/42) in [owner/project](https://github.com/owner/project)',
    '2. 🔎 Reviewed PR [#43](https://github.com/owner/project/pull/43) in [owner/project](https://github.com/owner/project)',
    '3. 🚀 Published release [v1.2.3](https://github.com/owner/project/releases/tag/v1.2.3) in [owner/project](https://github.com/owner/project)',
  ]);
});

test('replaces the complete generated section without leaving padded lines', () => {
  const readme = [
    '# Profile',
    '',
    '<!--RECENT_ACTIVITY:start-->',
    '1. old',
    '2. old',
    '3. <br>',
    '<!--RECENT_ACTIVITY:end-->',
    '',
    'Footer',
    '',
  ].join('\n');

  const updated = replaceActivitySection(readme, ['1. new', '2. newer']);

  assert.equal(updated, [
    '# Profile',
    '',
    '<!--RECENT_ACTIVITY:start-->',
    '1. new',
    '2. newer',
    '<!--RECENT_ACTIVITY:end-->',
    '',
    'Footer',
    '',
  ].join('\n'));
});

test('updates the README through GitHub using the public events endpoint', async () => {
  const readme = [
    '# Profile',
    '<!--RECENT_ACTIVITY:start-->',
    '1. old',
    '<!--RECENT_ACTIVITY:end-->',
    '',
  ].join('\n');
  const calls = [];
  const github = {
    request: async (route, options) => {
      calls.push({ route, options });
      return {
        data: [{
          type: 'PushEvent',
          repo: { name: 'owner/project' },
          payload: { head: 'new-head' },
        }],
      };
    },
    rest: {
      repos: {
        getContent: async (options) => {
          calls.push({ getContent: options });
          return {
            data: {
              type: 'file',
              sha: 'readme-sha',
              content: Buffer.from(readme).toString('base64'),
            },
          };
        },
        createOrUpdateFileContents: async (options) => {
          calls.push({ createOrUpdateFileContents: options });
        },
      },
    },
  };

  await updateRecentActivity({
    github,
    context: {
      ref: 'refs/heads/master',
      repo: { owner: 'thoemmi', repo: 'thoemmi' },
    },
    core: { info: () => {} },
  });

  assert.equal(calls[0].route, 'GET /users/{username}/events/public');
  assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.deepEqual(calls[1].getContent, {
    owner: 'thoemmi',
    repo: 'thoemmi',
    path: 'README.md',
    ref: 'master',
  });
  assert.equal(calls[2].createOrUpdateFileContents.branch, 'master');
  assert.equal(calls[2].createOrUpdateFileContents.sha, 'readme-sha');

  const updated = Buffer.from(
    calls[2].createOrUpdateFileContents.content,
    'base64',
  ).toString('utf8');
  assert.match(updated, /1\. ⬆️ Pushed to \[owner\/project\]/);
  assert.doesNotMatch(updated, /1\. old/);
});
