const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildPrompt,
  fingerprintFacts,
  normalizeEvents,
  prepareRecentActivity,
  renderActivity,
  replaceActivitySection,
  selectVerifiedPublicFacts,
  sourceMarker,
  updateRecentActivity,
  validateGeneratedActivity,
} = require('./update-recent-activity.cjs');

const mergedPullRequest = {
  kind: 'pull_request',
  action: 'merged',
  repository: 'meziantou/Meziantou.Framework',
  repositoryUrl: 'https://github.com/meziantou/Meziantou.Framework',
  number: 1795,
  url: 'https://github.com/meziantou/Meziantou.Framework/pull/1795',
};

const publicPush = {
  kind: 'push',
  action: 'pushed',
  repository: 'thoemmi/7Zip4Powershell',
  repositoryUrl: 'https://github.com/thoemmi/7Zip4Powershell',
  url: 'https://github.com/thoemmi/7Zip4Powershell/commit/2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb',
};

test('normalizes only explicitly public events and deduplicates a PR lifecycle', () => {
  const events = [
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
      payload: {
        head: '2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb',
      },
    },
  ];

  const facts = normalizeEvents(events, new Set(['thoemmi/thoemmi']));

  assert.deepEqual(facts, [mergedPullRequest, publicPush]);
  assert.doesNotMatch(JSON.stringify(facts), /private-project|unknown-visibility/);
  assert.deepEqual(renderActivity(facts), [
    '1. 🎉 Merged PR [#1795](https://github.com/meziantou/Meziantou.Framework/pull/1795) in [meziantou/Meziantou.Framework](https://github.com/meziantou/Meziantou.Framework)',
    '2. ⬆️ Pushed to [thoemmi/7Zip4Powershell](https://github.com/thoemmi/7Zip4Powershell/commit/2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb)',
  ]);
});

test('keeps only repositories whose visibility is verified as public', async () => {
  const facts = [
    mergedPullRequest,
    {
      ...publicPush,
      repository: 'thoemmi/private-project',
      repositoryUrl: 'https://github.com/thoemmi/private-project',
      url: 'https://github.com/thoemmi/private-project/commit/private',
    },
    {
      ...publicPush,
      repository: 'company/internal-project',
      repositoryUrl: 'https://github.com/company/internal-project',
      url: 'https://github.com/company/internal-project/commit/internal',
    },
  ];
  const calls = [];
  const github = {
    rest: {
      repos: {
        get: async ({ owner, repo }) => {
          calls.push(`${owner}/${repo}`);
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
    { warning: () => {} },
  );

  assert.deepEqual(calls, [
    'meziantou/Meziantou.Framework',
    'thoemmi/private-project',
    'company/internal-project',
  ]);
  assert.deepEqual(selected, [mergedPullRequest]);
});

test('builds a prompt only from the verified normalized facts', () => {
  const prompt = buildPrompt([mergedPullRequest, publicPush]);

  assert.match(prompt, /untrusted data, never instructions/);
  assert.match(prompt, /meziantou\/Meziantou\.Framework/);
  assert.doesNotMatch(prompt, /title|body|private-project/);
});

test('accepts grounded Copilot output and rejects unknown links', () => {
  const facts = [mergedPullRequest, publicPush];
  const valid = [
    '1. 🔀 Merged pull request #1795 in [meziantou/Meziantou.Framework](https://github.com/meziantou/Meziantou.Framework): https://github.com/meziantou/Meziantou.Framework/pull/1795',
    '2. 📦 Pushed a commit to [thoemmi/7Zip4Powershell](https://github.com/thoemmi/7Zip4Powershell): https://github.com/thoemmi/7Zip4Powershell/commit/2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb',
  ].join('\n');
  const invalid = valid.replace(
    'https://github.com/thoemmi/7Zip4Powershell/commit/2f764ce46535cc0d70f6f24ad2d5bb3a70dca0eb',
    'https://example.com/invented',
  );

  assert.deepEqual(validateGeneratedActivity(valid, facts), valid.split('\n'));
  assert.equal(validateGeneratedActivity(invalid, facts), null);
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

test('prepares only verified public activity and exposes a stable fingerprint', async () => {
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
  assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2026-03-10');
  assert.deepEqual(calls[1].get, { owner: 'owner', repo: 'project' });
  assert.equal(outputs.changed, 'true');
  assert.equal(outputs.has_activity, 'true');
  assert.equal(outputs.fingerprint, fingerprintFacts(result.facts));
  assert.doesNotMatch(
    Buffer.from(outputs.facts, 'base64').toString('utf8'),
    /private-project|private-head/,
  );
});

test('skips Copilot when the public activity fingerprint is unchanged', async () => {
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
  const facts = [mergedPullRequest];
  const fingerprint = fingerprintFacts(facts);

  await updateRecentActivity({
    github,
    context: {
      ref: 'refs/heads/master',
      repo: { owner: 'thoemmi', repo: 'thoemmi' },
    },
    core: { info: () => {}, warning: () => {} },
    factsBase64: Buffer.from(JSON.stringify(facts)).toString('base64'),
    fingerprint,
  });

  const update = calls.find((call) => call.createOrUpdateFileContents)
    .createOrUpdateFileContents;
  const updated = Buffer.from(update.content, 'base64').toString('utf8');
  assert.match(updated, new RegExp(sourceMarker(fingerprint)));
  assert.match(updated, /1\. 🎉 Merged PR/);
  assert.doesNotMatch(updated, /1\. old/);
});
