import {mkdir, writeFile} from "node:fs/promises";

const username = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "zly2006";
const token = process.env.GITHUB_TOKEN;
const apiRoot = "https://api.github.com/";
const outputDirectory = new URL("../profile-summary-card-output/transparent/", import.meta.url);

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "profile-card-generator",
  "X-GitHub-Api-Version": "2026-03-10",
  ...(token ? {Authorization: `Bearer ${token}`} : {}),
};

async function request(path, {allowEmptyRepository = false} = {}) {
  const response = await fetch(new URL(path, apiRoot), {headers});
  if (allowEmptyRepository && response.status === 409) {
    return {data: [], headers: response.headers};
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return {data: await response.json(), headers: response.headers};
}

async function getOwnedRepositories() {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const {data} = await request(
      `users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
    );
    repositories.push(...data.filter((repository) => !repository.fork));
    if (data.length < 100) break;
  }
  return repositories;
}

async function getSearchCount(query, resource = "issues") {
  const {data} = await request(`search/${resource}?q=${encodeURIComponent(query)}&per_page=1`);
  return data.total_count;
}

function lastPage(linkHeader) {
  if (!linkHeader) return null;
  const lastLink = linkHeader.split(",").find((part) => part.includes('rel="last"'));
  if (!lastLink) return null;
  const match = lastLink.match(/<([^>]+)>/);
  return match ? Number(new URL(match[1]).searchParams.get("page")) : null;
}

async function getRepositoryCommitCount(repository) {
  const path = `repos/${encodeURIComponent(repository.owner.login)}/${encodeURIComponent(repository.name)}/commits?author=${encodeURIComponent(username)}&per_page=1`;
  const {data, headers: responseHeaders} = await request(path, {allowEmptyRepository: true});
  if (data.length === 0) return 0;
  return lastPage(responseHeaders.get("link")) || data.length;
}

async function getLanguageCommitCounts(repositories) {
  const counts = new Map();
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < repositories.length) {
      const repository = repositories[nextIndex++];
      if (!repository.language) continue;
      const commits = await getRepositoryCommitCount(repository);
      counts.set(repository.language, (counts.get(repository.language) || 0) + commits);
    }
  }

  await Promise.all(Array.from({length: Math.min(6, repositories.length)}, () => worker()));
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function compactNumber(value) {
  if (value < 1000) return String(value);
  const scaled = value / 1000;
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits).replace(/\.0$/, "")}k`;
}

function svgDocument(content, metadata) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200" viewBox="0 0 340 200" role="img">
  <metadata>${escapeXml(JSON.stringify(metadata))}</metadata>
  <style>
    text { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', sans-serif; }
    .title { fill: #006aff; font-size: 22px; }
    .label, .value { fill: #417e87; font-size: 14px; }
    .value { font-weight: 600; }
  </style>
  <rect x="1" y="1" width="338" height="198" rx="5" fill="transparent"/>
  ${content}
</svg>
`;
}

function renderStatsCard(stats) {
  const rows = [
    ["Total Stars", stats.totalStars],
    ["Public Commits", stats.publicCommits],
    ["Total PRs", stats.pullRequests],
    ["Total Issues", stats.issues],
    ["Public Repos", stats.publicRepositories],
  ];
  const colors = ["#f1c40f", "#0579c3", "#8250df", "#d73a49", "#2da44e"];
  const body = rows
    .map(([label, value], index) => {
      const y = 70 + index * 25;
      return `<circle cx="36" cy="${y - 5}" r="5" fill="${colors[index]}"/>
  <text x="50" y="${y}" class="label">${escapeXml(label)}:</text>
  <text x="210" y="${y}" class="value">${escapeXml(compactNumber(value))}</text>`;
    })
    .join("\n  ");
  return svgDocument(`<text x="30" y="40" class="title">Stats</text>\n  ${body}`, stats);
}

const languageColors = new Map([
  ["Kotlin", "#a97bff"],
  ["Vue", "#41b883"],
  ["Java", "#b07219"],
  ["Rust", "#dea584"],
  ["Python", "#3572a5"],
  ["TypeScript", "#3178c6"],
  ["JavaScript", "#f1e05a"],
  ["C++", "#f34b7d"],
  ["C", "#555555"],
  ["Shell", "#89e051"],
]);

function renderLanguagesCard(languages) {
  const total = languages.reduce((sum, [, count]) => sum + count, 0) || 1;
  const body = languages
    .map(([language, count], index) => {
      const y = 65 + index * 27;
      const ratio = count / total;
      const width = Math.max(2, Math.round(145 * ratio));
      const color = languageColors.get(language) || "#6e7781";
      return `<text x="30" y="${y}" class="label">${escapeXml(language)}</text>
  <rect x="115" y="${y - 11}" width="145" height="10" rx="5" fill="#d8dee4" fill-opacity="0.45"/>
  <rect x="115" y="${y - 11}" width="${width}" height="10" rx="5" fill="${color}"/>
  <text x="274" y="${y}" class="value">${Math.round(ratio * 100)}%</text>`;
    })
    .join("\n  ");
  return svgDocument(`<text x="30" y="35" class="title">Top Languages by Commit</text>\n  ${body}`, {
    username,
    languages: Object.fromEntries(languages),
  });
}

const repositories = await getOwnedRepositories();
const [publicCommits, pullRequests, issues, languages] = await Promise.all([
  getSearchCount(`author:${username}`, "commits"),
  getSearchCount(`author:${username} type:pr`),
  getSearchCount(`author:${username} type:issue`),
  getLanguageCommitCounts(repositories),
]);

const stats = {
  username,
  totalStars: repositories.reduce((sum, repository) => sum + repository.stargazers_count, 0),
  publicCommits,
  pullRequests,
  issues,
  publicRepositories: repositories.length,
};

await mkdir(outputDirectory, {recursive: true});
await Promise.all([
  writeFile(new URL("2-most-commit-language.svg", outputDirectory), renderLanguagesCard(languages)),
  writeFile(new URL("3-stats.svg", outputDirectory), renderStatsCard(stats)),
]);

console.log(JSON.stringify({stats, languages: Object.fromEntries(languages)}, null, 2));
