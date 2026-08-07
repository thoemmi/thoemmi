const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPrompt,
  fingerprintFacts,
  normalizeEvents,
  parseGeneratedPresentations,
  prepareRecentActivity,
  renderActivity,
  replaceActivitySection,
  selectVerifiedPublicFacts,
  sourceMarker,
  updateRecentActivity,
} = require('./update-recent-activity.cjs');

const mergedPullRequest = {
  id: 'pull_request:meziantou/Meziantou.Framework:1795',
  kind: 'pull_request',
  repository: 'meziantou/Meziantou.Framework',
  repositoryUrl: 'https://github.com/meziantou/Meziantou.Framework',
  number: 1795,
  url: 'https://github.com/meziantou/Meziantou.Framework/pull/1795',
  actions: ['opened', 'merged'],
};

const publicPush = {
  id: 'push:thoemmi/7Zip4Powershell',
  kind: 'push',
  repository: 'thoemmi/7Zip4Powershell',
  repositoryUrl: 'https://github.com/thoemmi/7Zip4Powershell',
  pushCount: 2,
  url: 'https://github.com/thoemmi/7Zip4Powershell/commit/new-head',
  actions: ['pushed'],
};

test('builds lifecycle stories, groups pushes, and keeps only explicit public events', () => {
  const events = [
    {
      public: true,
      type: 'PushEvent',
      repo: { name: 'thoemmi/7Zip4Powershell' },
      payload: { head: 'new-head' },
    },
    {
      public: true,
      type: 'PushEvent',
      repo: { name: 'thoemmi/thoemmi' },
      payload: { head: 'profile-commit' },
    },
    {
      public: false,
      type: 'PushEvent',
      repo: { name: 'thoemmi/private-project' },
      payload: { head: 'private-commit' },
    },
    {
      type: 'PushEvent',
      repo: { name: 'thoemmi/unknown-visibility' },
      payload: { head: 'unknown-commit' },
    },
    {
      public: true,
      type: 'PullRequestEvent',
      repo: { name: 'meziantou/Meziantou.Framework' },
      payload: { action: 'merged', number: 1795 },
    },
    {
      public: true,
      type: 'PullRequestEvent',
      repo: { name: 'meziantou/Meziantou.Framework' },
      payload: { action: 'opened', number: 1795 },
    },
    {
      public: true,
      type: 'PushEvent',
      repo: { name: 'thoemmi/7Zip4Powershell' },
      payload: { head: 'old-head' },
    },
  ];

  const facts = normalizeEvents(events, new Set(['thoemmi/thoemmi']));

  assert.deepEqual(facts, [mergedPullRequest, publicPush]);
  assert.doesNotMatch(JSON.stringify(facts), /private-project|unknown-visibility/);
});

test('ranks meaningful activity ahead of newer routine pushes', () => {
  const events = [
    {
      public: true,
      type: 'PushEvent',
      repo: { name: 'owner/new-push' },
      payload: { head: 'head' },
    },
    {
      public: true,
      type: 'IssuesEvent',
      repo: { name: 'owner/project' },
      payload: { action: 'opened', number: 42 },
    },
    {
      public: true,
      type: 'PullRequestReviewEvent',
      repo: { name: 'owner/project' },
      payload: { pull_request: { number: 43 } },
    },
    {
      public: true,
      type: 'ReleaseEvent',
      repo: { name: 'owner/project' },
      payload: { release: { tag_name: 'v1.2.3' } },
    },
  ];

  assert.deepEqual(
    normalizeEvents(events).map((fact) => fact.kind),
    ['release', 'pull_request', 'issue', 'push'],
  );
});

test('keeps only repositories whose visibility is verified as public', async () => {
  const facts = [
    mergedPullRequest,
    {
      ...publicPush,
      id: 'push:thoemmi/private-project',
      repository: 'thoemmi/private-project',
      repositoryUrl: 'https://github.com/thoemmi/private-project',
      url: 'https://github.com/thoemmi/private-project/commit/private',
    },
    {
      ...publicPush,
      id: 'push:company/internal-project',
      repository: 'company/internal-project',
      repositoryUrl: 'https://github.com/company/internal-project',
      url: 'https://github.com/company/internal-project/commit/internal',
    },
    {
      ...publicPush,
      id: 'push:owner/unverifiable',
      repository: 'owner/unverifiable',
      repositoryUrl: 'https://github.com/owner/unverifiable',
      url: 'https://github.com/owner/unverifiable/commit/unknown',
    },
  ];
  const calls = [];
  const warnings = [];
  const github = {
    rest: {
      repos: {
        get: async ({ owner, repo }) => {
          calls.push(`${owner}/${repo}`);
          if (repo === 'unverifiable') throw new Error('Not available');
          return {
            data: {
              private: repo === 'private-project',
              visibility: repo === 'internal-project'
                ? 'internal'
                : repo === 'private-project' ? 'private' : 'public',
            },
          };
        },
      },
    },
  };

  const selected = await selectVerifiedPublicFacts(
    github,
    facts,
    { warning: (message) => warnings.push(message) },
  );

  assert.deepEqual(calls, [
    'meziantou/Meziantou.Framework',
    'thoemmi/private-project',
    'company/internal-project',
    'owner/unverifiable',
  ]);
  assert.deepEqual(selected, [mergedPullRequest]);
  assert.equal(warnings.length, 1);
});

test('gives Copilot abstract timelines without repositories, numbers, or links', () => {
  const prompt = buildPrompt([mergedPullRequest, publicPush]);

  assert.match(prompt, /"actions": \[\s*"opened",\s*"merged"/);
  assert.match(prompt, /"multiplePushes": true/);
  assert.match(prompt, /"id": "activity-1"/);
  assert.doesNotMatch(prompt, /Meziantou|7Zip4Powershell|1795|https:\/\//);
});

test('accepts structured presentation text and renders only trusted links', () => {
  const facts = [mergedPullRequest, publicPush];
  const generated = JSON.stringify([
    {
      id: 'activity-1',
      emoji: '🔀',
      text: 'Opened a pull request that was later merged',
    },
    {
      id: 'activity-2',
      emoji: '🧰',
      text: 'Continued development with several pushes',
    },
  ]);
  const presentations = parseGeneratedPresentations(generated, facts);

  assert.deepEqual(presentations, [
    { emoji: '🔀', text: 'Opened a pull request that was later merged' },
    { emoji: '🧰', text: 'Continued development with several pushes' },
  ]);
  assert.deepEqual(renderActivity(facts, presentations), [
    '1. 🔀 Opened a pull request that was later merged — [PR #1795](https://github.com/meziantou/Meziantou.Framework/pull/1795) in [meziantou/Meziantou.Framework](https://github.com/meziantou/Meziantou.Framework)',
    '2. 🧰 Continued development with several pushes — [latest push](https://github.com/thoemmi/7Zip4Powershell/commit/new-head) in [thoemmi/7Zip4Powershell](https://github.com/thoemmi/7Zip4Powershell)',
  ]);
});

test('rejects Copilot output containing unknown fields, Markdown, or invented numbers', () => {
  const valid = [
    { id: 'activity-1', emoji: '🔀', text: 'Opened and later merged a pull request' },
  ];

  assert.equal(parseGeneratedPresentations(JSON.stringify([
    { ...valid[0], url: 'https://example.com' },
  ]), [mergedPullRequest]), null);
  assert.equal(parseGeneratedPresentations(JSON.stringify([
    { ...valid[0], text: 'Merged [PR](https://example.com)' },
  ]), [mergedPullRequest]), null);
  assert.equal(parseGeneratedPresentations(JSON.stringify([
    { ...valid[0], text: 'Merged PR 1795' },
  ]), [mergedPullRequest]), null);
});

test('renders a complete deterministic fallback story', () => {
  assert.deepEqual(renderActivity([mergedPullRequest, publicPush]), [
    '1. 🔀 Opened a pull request that was later merged — [PR #1795](https://github.com/meziantou/Meziantou.Framework/pull/1795) in [meziantou/Meziantou.Framework](https://github.com/meziantou/Meziantou.Framework)',
    '2. ⬆️ Continued development with multiple pushes — [latest push](https://github.com/thoemmi/7Zip4Powershell/commit/new-head) in [thoemmi/7Zip4Powershell](https://github.com/thoemmi/7Zip4Powershell)',
  ]);
});

test('replaces the generated section with a source fingerprint', () => {
  const readme = [
    '# Profile',
    '',
    '<!--RECENT_ACTIVITY:start-->',
    '1. old',
    '<!--RECENT_ACTIVITY:end-->',
    '',
  ].join('\n');

  const updated = replaceActivitySection(readme, ['1. new'], 'abc123');

  assert.equal(updated, [
    '# Profile',
    '',
    '<!--RECENT_ACTIVITY:start-->',
    '<!--RECENT_ACTIVITY:source:abc123-->',
    '1. new',
    '<!--RECENT_ACTIVITY:end-->',
    '',
  ].join('\n'));
});

function createGitHubMock({ events, readme, visibility = {} }) {
  const calls = [];
  const github = {
    request: async (route, options) => {
      calls.push({ route, options });
      return { data: events };
    },
    rest: {
      repos: {
        get: async ({ owner, repo }) => {
          calls.push({ get: { owner, repo } });
          return {
            data: {
              private: visibility[`${owner}/${repo}`] ?? false,
              visibility: visibility[`${owner}/${repo}`] ? 'private' : 'public',
            },
          };
        },
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

  return { calls, github };
}

test('prepares only verified public stories and exposes a stable fingerprint', async () => {
  const events = [
    {
      public: false,
      type: 'PushEvent',
      repo: { name: 'thoemmi/private-project' },
      payload: { head: 'private-head' },
    },
    {
      public: true,
      type: 'PushEvent',
      repo: { name: 'owner/project' },
      payload: { head: 'public-head' },
    },
  ];
  const readme = [
    '# Profile',
    '<!--RECENT_ACTIVITY:start-->',
    '1. old',
    '<!--RECENT_ACTIVITY:end-->',
    '',
  ].join('\n');
  const { calls, github } = createGitHubMock({ events, readme });
  const outputs = {};

  const result = await prepareRecentActivity({
    github,
    context: {
      ref: 'refs/heads/master',
      repo: { owner: 'thoemmi', repo: 'thoemmi' },
    },
    core: {
      info: () => {},
      warning: () => {},
      setOutput: (name, value) => { outputs[name] = value; },
    },
  });

  assert.equal(calls[0].route, 'GET /users/{username}/events/public');
  assert.deepEqual(calls[1].get, { owner: 'owner', repo: 'project' });
  assert.equal(outputs.changed, 'true');
  assert.equal(outputs.has_activity, 'true');
  assert.equal(outputs.fingerprint, fingerprintFacts(result.facts));
  assert.doesNotMatch(
    Buffer.from(outputs.prompt, 'base64').toString('utf8'),
    /private-project|owner\/project|public-head/,
  );
});

test('skips Copilot when the grouped public stories are unchanged', async () => {
  const events = [{
    public: true,
    type: 'PushEvent',
    repo: { name: 'owner/project' },
    payload: { head: 'public-head' },
  }];
  const facts = normalizeEvents(events);
  const fingerprint = fingerprintFacts(facts);
  const readme = [
    '# Profile',
    '<!--RECENT_ACTIVITY:start-->',
    sourceMarker(fingerprint),
    '1. existing text',
    '<!--RECENT_ACTIVITY:end-->',
    '',
  ].join('\n');
  const { github } = createGitHubMock({ events, readme });
  const outputs = {};

  await prepareRecentActivity({
    github,
    context: {
      ref: 'refs/heads/master',
      repo: { owner: 'thoemmi', repo: 'thoemmi' },
    },
    core: {
      info: () => {},
      warning: () => {},
      setOutput: (name, value) => { outputs[name] = value; },
    },
  });

  assert.equal(outputs.changed, 'false');
});

test('updates the README with deterministic fallback text', async () => {
  const readme = [
    '# Profile',
    '<!--RECENT_ACTIVITY:start-->',
    '1. old',
    '<!--RECENT_ACTIVITY:end-->',
    '',
  ].join('\n');
  const { calls, github } = createGitHubMock({ events: [], readme });
  const fingerprint = fingerprintFacts([mergedPullRequest]);

  await updateRecentActivity({
    github,
    context: {
      ref: 'refs/heads/master',
      repo: { owner: 'thoemmi', repo: 'thoemmi' },
    },
    core: { info: () => {}, warning: () => {} },
    factsBase64: Buffer.from(JSON.stringify([mergedPullRequest])).toString('base64'),
    fingerprint,
  });

  const update = calls.find((call) => call.createOrUpdateFileContents)
    .createOrUpdateFileContents;
  const updated = Buffer.from(update.content, 'base64').toString('utf8');
  assert.match(updated, new RegExp(sourceMarker(fingerprint)));
  assert.match(updated, /Opened a pull request that was later merged/);
  assert.doesNotMatch(updated, /1\. old/);
});
