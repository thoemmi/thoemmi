const MAX_ITEMS = 5;
const README_PATH = 'README.md';
const START_MARKER = '<!--RECENT_ACTIVITY:start-->';
const END_MARKER = '<!--RECENT_ACTIVITY:end-->';

function resourceNumber(event) {
  return event.payload?.number
    ?? event.payload?.issue?.number
    ?? event.payload?.pull_request?.number;
}

function repoLink(repo, url = `https://github.com/${repo}`) {
  return `[${repo}](${url})`;
}

function numberedLink(kind, number, url) {
  return `${kind} [#${number}](${url})`;
}

function renderPush(event, repo) {
  const head = event.payload?.head;
  const url = head
    ? `https://github.com/${repo}/commit/${head}`
    : `https://github.com/${repo}`;

  return `⬆️ Pushed to ${repoLink(repo, url)}`;
}

function renderIssue(event, repo) {
  const number = resourceNumber(event);
  if (!number) return null;

  const descriptions = {
    opened: ['❗', 'Opened'],
    closed: ['🔒', 'Closed'],
    reopened: ['🔓', 'Reopened'],
  };
  const [emoji, action] = descriptions[event.payload?.action] ?? ['ℹ️', 'Updated'];
  const issue = numberedLink('issue', number, `https://github.com/${repo}/issues/${number}`);

  return `${emoji} ${action} ${issue} in ${repoLink(repo)}`;
}

function renderPullRequest(event, repo) {
  const number = resourceNumber(event);
  if (!number) return null;

  const descriptions = {
    opened: ['💪', 'Opened'],
    closed: ['❌', 'Closed'],
    merged: ['🎉', 'Merged'],
    reopened: ['🔄', 'Reopened'],
  };
  const [emoji, action] = descriptions[event.payload?.action] ?? ['ℹ️', 'Updated'];
  const pullRequest = numberedLink('PR', number, `https://github.com/${repo}/pull/${number}`);

  return `${emoji} ${action} ${pullRequest} in ${repoLink(repo)}`;
}

function renderReview(event, repo) {
  const number = resourceNumber(event);
  if (!number) return null;

  const pullRequest = numberedLink('PR', number, `https://github.com/${repo}/pull/${number}`);
  return `🔎 Reviewed ${pullRequest} in ${repoLink(repo)}`;
}

function renderRelease(event, repo) {
  const tag = event.payload?.release?.tag_name;
  if (!tag) return null;

  const url = `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`;
  return `🚀 Published release [${tag}](${url}) in ${repoLink(repo)}`;
}

const renderers = {
  PushEvent: renderPush,
  IssuesEvent: renderIssue,
  PullRequestEvent: renderPullRequest,
  PullRequestReviewEvent: renderReview,
  ReleaseEvent: renderRelease,
};

function renderActivity(events, ignoredRepos = new Set()) {
  return events
    .filter((event) => !ignoredRepos.has(event.repo?.name))
    .map((event) => {
      const renderer = renderers[event.type];
      return renderer && event.repo?.name
        ? renderer(event, event.repo.name)
        : null;
    })
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
    .map((line, index) => `${index + 1}. ${line}`);
}

function replaceActivitySection(readme, lines) {
  const start = readme.indexOf(START_MARKER);
  const end = readme.indexOf(END_MARKER);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('Recent activity markers are missing or invalid.');
  }

  const before = readme.slice(0, start + START_MARKER.length);
  const after = readme.slice(end);
  const activity = lines.join('\n');

  return `${before}\n${activity}\n${after}`;
}

async function updateRecentActivity({ github, context, core }) {
  const { owner, repo } = context.repo;
  const branch = context.ref.replace('refs/heads/', '');

  const { data: events } = await github.request(
    'GET /users/{username}/events/public',
    {
      username: owner,
      per_page: 100,
      headers: {
        'X-GitHub-Api-Version': '2026-03-10',
      },
    },
  );

  const lines = renderActivity(events, new Set([`${owner}/${repo}`]));
  const { data: readmeFile } = await github.rest.repos.getContent({
    owner,
    repo,
    path: README_PATH,
    ref: branch,
  });

  if (Array.isArray(readmeFile) || readmeFile.type !== 'file') {
    throw new Error(`${README_PATH} is not a file.`);
  }

  const readme = Buffer.from(readmeFile.content, 'base64').toString('utf8');
  const updatedReadme = replaceActivitySection(readme, lines);

  if (updatedReadme === readme) {
    core.info('Recent activity is already up to date.');
    return;
  }

  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: README_PATH,
    branch,
    message: 'chore: update recent GitHub activity',
    content: Buffer.from(updatedReadme, 'utf8').toString('base64'),
    sha: readmeFile.sha,
  });

  core.info(`Updated README with ${lines.length} recent activities.`);
}

module.exports = updateRecentActivity;
module.exports.renderActivity = renderActivity;
module.exports.replaceActivitySection = replaceActivitySection;
