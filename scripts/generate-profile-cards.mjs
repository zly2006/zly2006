import {mkdir, writeFile} from "node:fs/promises";

const username = process.env.PROFILE_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || "zly2006";
const token = process.env.GITHUB_TOKEN;
const outputDirectory = new URL("../profile-summary-card-output/transparent/", import.meta.url);

if (!token) throw new Error("GITHUB_TOKEN is required");

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
  "User-Agent": "profile-card-generator",
  "X-GitHub-Api-Version": "2026-03-10",
};

async function rest(path) {
  const response = await fetch(new URL(path, "https://api.github.com/"), {headers});
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub REST API ${response.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return response.json();
}

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers,
    body: JSON.stringify({query, variables}),
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) {
    throw new Error(`GitHub GraphQL API failed: ${JSON.stringify(body.errors || body).slice(0, 600)}`);
  }
  return body.data;
}

async function getOwnedRepositories() {
  const repositories = [];
  for (let page = 1; ; page += 1) {
    const data = await rest(
      `users/${encodeURIComponent(username)}/repos?type=owner&sort=full_name&per_page=100&page=${page}`,
    );
    repositories.push(...data.filter((repository) => !repository.fork));
    if (data.length < 100) break;
  }
  return repositories;
}

async function getProfileStats() {
  const data = await graphql(
    `query ProfileStats($login: String!) {
      user(login: $login) {
        pullRequests(first: 1) { totalCount }
        issues(first: 1) { totalCount }
        repositoriesContributedTo(
          first: 1
          includeUserRepositories: true
          privacy: PUBLIC
          contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY]
        ) { totalCount }
        contributionsCollection { contributionYears }
      }
    }`,
    {login: username},
  );
  return data.user;
}

async function getYearData(year) {
  const data = await graphql(
    `query ContributionYear($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          totalCommitContributions
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              nameWithOwner
              primaryLanguage { name color }
            }
            contributions { totalCount }
          }
        }
      }
    }`,
    {
      login: username,
      from: `${year}-01-01T00:00:00Z`,
      to: `${year}-12-31T23:59:59Z`,
    },
  );
  return data.user.contributionsCollection;
}

async function getAllYearData(years) {
  const result = [];
  const sortedYears = [...years].sort((left, right) => right - left);
  for (let index = 0; index < sortedYears.length; index += 5) {
    result.push(...(await Promise.all(sortedYears.slice(index, index + 5).map(getYearData))));
  }
  return result;
}

function compactNumber(value) {
  if (value < 1000) return String(value);
  const scaled = value / 1000;
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits)}k`;
}

const icons = {
  star: '<path fill-rule="evenodd" d="M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25zm0 2.445L6.615 5.5a.75.75 0 01-.564.41l-3.097.45 2.24 2.184a.75.75 0 01.216.664l-.528 3.084 2.769-1.456a.75.75 0 01.698 0l2.77 1.456-.53-3.084a.75.75 0 01.216-.664l2.24-2.183-3.096-.45a.75.75 0 01-.564-.41L8 2.694v.001z"></path>',
  commit: '<path fill-rule="evenodd" d="M10.5 7.75a2.5 2.5 0 11-5 0 2.5 2.5 0 015 0zm1.43.75a4.002 4.002 0 01-7.86 0H.75a.75.75 0 110-1.5h3.32a4.001 4.001 0 017.86 0h3.32a.75.75 0 110 1.5h-3.32z"></path>',
  pullRequest: '<path fill-rule="evenodd" d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"></path>',
  issue: '<path fill-rule="evenodd" d="M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM0 8a8 8 0 1116 0A8 8 0 010 8zm9 3a1 1 0 11-2 0 1 1 0 012 0zm-.25-6.25a.75.75 0 00-1.5 0v3.5a.75.75 0 001.5 0v-3.5z"></path>',
  repos: '<path fill-rule="evenodd" d="M2 2.5A2.5 2.5 0 014.5 0h8.75a.75.75 0 01.75.75v12.5a.75.75 0 01-.75.75h-2.5a.75.75 0 110-1.5h1.75v-2h-8a1 1 0 00-.714 1.7.75.75 0 01-1.072 1.05A2.495 2.495 0 012 11.5v-9zm10.5-1V9h-8c-.356 0-.694.074-1 .208V2.5a1 1 0 011-1h8zM5 12.25v3.25a.25.25 0 00.4.2l1.45-1.087a.25.25 0 01.3 0L8.6 15.7a.25.25 0 00.4-.2v-3.25a.25.25 0 00-.25-.25h-3.5a.25.25 0 00-.25.25z"></path>',
  github: '<path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>',
};

function cardStart(title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200" viewBox="0 0 340 200"><style>* {
          font-family: 'Segoe UI', Ubuntu, "Helvetica Neue", Sans-Serif
        }</style><g class="gpsc-root"><rect x="1" y="1" rx="5" ry="5" height="99%" width="99.41176470588235%" stroke="#000000" stroke-width="1" fill="#00000000" stroke-opacity="0"></rect><text x="30" y="40" class="gpsc-item" style="--gpsc-i: 0; font-size: 22px; fill: #006AFF;">${title}</text><g transform="translate(0,40)">`;
}

function renderStatsCard(stats) {
  const rows = [
    [icons.star, "Total Stars:", stats.totalStars],
    [icons.commit, "Total Commits:", stats.totalCommits],
    [icons.pullRequest, "Total PRs:", stats.pullRequests],
    [icons.issue, "Total Issues:", stats.issues],
    [icons.repos, "Contributed to:", stats.contributedTo],
  ];
  const iconNodes = rows
    .map(
      ([icon], index) =>
        `<g class="gpsc-item" style="--gpsc-i: ${index};"><g transform="translate(0,${14 * index * 1.8})" width="14" height="14" fill="#0579C3">${icon}</g></g>`,
    )
    .join("");
  const labels = rows
    .map(
      ([, label], index) =>
        `<text x="21" y="${14 * index * 1.8 + 14}" class="gpsc-item" style="--gpsc-i: ${index}; fill: #417E87; font-size: 14px;">${label}</text>`,
    )
    .join("");
  const values = rows
    .map(
      ([, , value], index) =>
        `<text x="130" y="${14 * index * 1.8 + 14}" class="gpsc-item" style="--gpsc-i: ${index}; fill: #417E87; font-size: 14px;">${compactNumber(value)}</text>`,
    )
    .join("");
  return `${cardStart("Stats")}<g transform="translate(30,20)">${iconNodes}${labels}${values}</g><g transform="translate(220,20)"><g transform="scale(6)" style="fill: #0579C3;">${icons.github}</g></g></g></g></svg>`;
}

function point(radius, angle) {
  const adjustedAngle = angle - Math.PI / 2;
  return [radius * Math.cos(adjustedAngle), radius * Math.sin(adjustedAngle)];
}

function arcPath(startAngle, endAngle) {
  const outerRadius = 60;
  const innerRadius = 35;
  const [outerStartX, outerStartY] = point(outerRadius, startAngle);
  const [outerEndX, outerEndY] = point(outerRadius, endAngle);
  const [innerEndX, innerEndY] = point(innerRadius, endAngle);
  const [innerStartX, innerStartY] = point(innerRadius, startAngle);
  const largeArc = endAngle - startAngle >= Math.PI ? 1 : 0;
  return `M${outerStartX},${outerStartY}A${outerRadius},${outerRadius},0,${largeArc},1,${outerEndX},${outerEndY}L${innerEndX},${innerEndY}A${innerRadius},${innerRadius},0,${largeArc},0,${innerStartX},${innerStartY}Z`;
}

function renderLanguagesCard(languages) {
  const total = languages.reduce((sum, language) => sum + language.value, 0) || 1;
  const anglePerUnit = (Math.PI * 2) / total;
  let angle = 0;
  const segments = languages.map((language, index) => {
    const startAngle = angle;
    angle += language.value * anglePerUnit;
    return {...language, index, startAngle, endAngle: angle};
  });
  const swatches = segments
    .map(
      (language) =>
        `<rect y="${14 * language.index * 1.8 + 200 / 2 - 70 - 12}" width="14" height="14" class="gpsc-item" style="--gpsc-i: ${language.index}; stroke-width: 1px;" fill="${language.color}" stroke="#00000000"></rect>`,
    )
    .join("");
  const labels = segments
    .map(
      (language) =>
        `<text x="16.8" y="${14 * language.index * 1.8 + 200 / 2 - 70}" class="gpsc-item" style="--gpsc-i: ${language.index}; fill: #417E87; font-size: 14px;">${language.name}</text>`,
    )
    .join("");
  const arcs = segments
    .map(
      (language) =>
        `<g class="arc" style="--gpsc-i: ${language.index};"><path d="${arcPath(language.startAngle, language.endAngle)}" style="fill: ${language.color}; stroke-width: 2px;" stroke="#00000000"></path></g>`,
    )
    .join("");
  return `${cardStart("Top Languages by Commit")}<g transform="translate(40,0)">${swatches}${labels}</g><g transform="translate( 230, 80 )">${arcs}</g></g></g></svg>`;
}

const [repositories, profile] = await Promise.all([getOwnedRepositories(), getProfileStats()]);
const yearlyData = await getAllYearData(profile.contributionsCollection.contributionYears);
const languageCounts = new Map();

for (const year of yearlyData) {
  for (const contribution of year.commitContributionsByRepository) {
    const language = contribution.repository.primaryLanguage;
    if (!language) continue;
    const current = languageCounts.get(language.name) || {name: language.name, value: 0, color: language.color || "#586e75"};
    current.value += contribution.contributions.totalCount;
    languageCounts.set(language.name, current);
  }
}

const languages = [...languageCounts.values()].sort((left, right) => right.value - left.value).slice(0, 5);
const stats = {
  totalStars: repositories.reduce((sum, repository) => sum + repository.stargazers_count, 0),
  totalCommits: yearlyData.reduce((sum, year) => sum + year.totalCommitContributions, 0),
  pullRequests: profile.pullRequests.totalCount,
  issues: profile.issues.totalCount,
  contributedTo: profile.repositoriesContributedTo.totalCount,
};

await mkdir(outputDirectory, {recursive: true});
await Promise.all([
  writeFile(new URL("2-most-commit-language.svg", outputDirectory), renderLanguagesCard(languages)),
  writeFile(new URL("3-stats.svg", outputDirectory), renderStatsCard(stats)),
]);

console.log(JSON.stringify({stats, languages}, null, 2));
