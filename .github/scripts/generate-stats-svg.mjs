#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const GRAPHQL_QUERY = `
  query AggregateProfileStats($cursor: String) {
    viewer {
      createdAt
      contributionsCollection {
        contributionCalendar {
          totalContributions
        }
      }
      repositories(
        first: 100
        after: $cursor
        ownerAffiliations: OWNER
        isFork: false
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          name
          isPrivate
          isArchived
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

function parseArgs(argv) {
  const opts = { dryRun: false, outDir: 'assets' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      opts.dryRun = true;
    } else if (argv[i] === '--out-dir' && argv[i + 1]) {
      opts.outDir = argv[++i];
    } else if (argv[i].startsWith('--out-dir=')) {
      opts.outDir = argv[i].slice('--out-dir='.length);
    }
  }
  return opts;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const FALLBACK_COLORS = ['#f97316', '#38bdf8', '#a78bfa', '#10b981', '#f59e0b', '#fb7185'];

function normalizeColor(hex, index) {
  if (typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex)) {
    return hex;
  }
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}

async function fetchAggregateMetrics() {
  const token = process.env.GH_METRICS_TOKEN;
  if (!token) {
    throw new Error('GH_METRICS_TOKEN is required unless --dry-run is specified.');
  }

  const excluded = new Set(
    (process.env.EXCLUDED_REPOS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );

  let cursor = null;
  let hasNextPage = true;
  let createdAt = null;
  let totalContributions = 0;
  let privateRepos = 0;
  let publicRepos = 0;
  const languageTotals = new Map();

  while (hasNextPage) {
    const response = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'qchardesign-profile-telemetry'
      },
      body: JSON.stringify({ query: GRAPHQL_QUERY, variables: { cursor } })
    });

    if (!response.ok) {
      throw new Error(`GitHub GraphQL request failed with HTTP ${response.status}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      throw new Error(`GitHub GraphQL error: ${payload.errors[0].message}`);
    }

    const viewer = payload.data?.viewer;
    if (!viewer) {
      throw new Error('GitHub GraphQL response missing viewer object.');
    }

    if (!createdAt) {
      createdAt = viewer.createdAt;
      totalContributions = viewer.contributionsCollection?.contributionCalendar?.totalContributions ?? 0;
    }

    const repos = viewer.repositories?.nodes ?? [];
    for (const repo of repos) {
      if (!repo || repo.isArchived) continue;
      if (excluded.has(String(repo.name || '').toLowerCase())) continue;

      if (repo.isPrivate) {
        privateRepos += 1;
      } else {
        publicRepos += 1;
      }

      for (const edge of repo.languages?.edges ?? []) {
        const langName = edge?.node?.name;
        const size = Number(edge?.size || 0);
        if (!langName || size <= 0) continue;
        const prev = languageTotals.get(langName);
        if (prev) {
          prev.bytes += size;
        } else {
          languageTotals.set(langName, {
            name: langName,
            color: edge?.node?.color || '',
            bytes: size
          });
        }
      }
    }

    hasNextPage = Boolean(viewer.repositories?.pageInfo?.hasNextPage);
    cursor = viewer.repositories?.pageInfo?.endCursor ?? null;
  }

  const createdYear = createdAt ? new Date(createdAt).getUTCFullYear() : new Date().getUTCFullYear();
  const tenureYears = Math.max(1, new Date().getUTCFullYear() - createdYear);
  const allLangs = Array.from(languageTotals.values()).sort((a, b) => b.bytes - a.bytes);
  const totalBytes = allLangs.reduce((sum, item) => sum + item.bytes, 0);

  const topLanguages = allLangs
    .map((item, idx) => ({
      name: item.name,
      color: normalizeColor(item.color, idx),
      pct: totalBytes > 0 ? (item.bytes / totalBytes) * 100 : 0
    }))
    .filter((item) => item.pct >= 0.1)
    .slice(0, 6);

  return {
    totalRepos: privateRepos + publicRepos,
    privateRepos,
    publicRepos,
    totalContributions,
    languageCount: allLangs.length,
    createdYear,
    tenureYears,
    topLanguages
  };
}

function getDryRunMetrics() {
  return {
    totalRepos: 14,
    privateRepos: 13,
    publicRepos: 1,
    totalContributions: 642,
    languageCount: 8,
    createdYear: 2013,
    tenureYears: 13,
    topLanguages: [
      { name: 'TypeScript', color: '#3178c6', pct: 41.2 },
      { name: 'Astro', color: '#f97316', pct: 24.6 },
      { name: 'Shell', color: '#10b981', pct: 14.8 },
      { name: 'PHP', color: '#8b5cf6', pct: 9.4 },
      { name: 'Python', color: '#38bdf8', pct: 6.1 },
      { name: 'CSS', color: '#f59e0b', pct: 3.9 }
    ]
  };
}

function renderHeaderSvg() {
  const pills = [
    { label: 'Agentic AI &amp; MCP', color: '#f97316', x: 36, w: 142 },
    { label: 'Linux &amp; Edge SRE', color: '#10b981', x: 186, w: 144 },
    { label: 'Enterprise Magento 2', color: '#fb7185', x: 338, w: 168 },
    { label: 'Astro / React / Android', color: '#38bdf8', x: 514, w: 170 },
    { label: '26+ Yrs Brand &amp; UI', color: '#a78bfa', x: 692, w: 152 }
  ];

  const pillsSvg = pills
    .map(
      (p) => `
  <g transform="translate(${p.x}, 142)">
    <rect width="${p.w}" height="32" rx="10" fill="#18181b" stroke="${p.color}" stroke-opacity="0.45" stroke-width="1" />
    <circle cx="15" cy="16" r="4" fill="${p.color}" />
    <text x="27" y="20" fill="#e4e4e7" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11.5" font-weight="700">${p.label}</text>
  </g>`
    )
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 204" width="880" height="204" role="img" aria-label="QCHAR.DESIGN — Tomasz Kucharski | Lead AI DevOps Architect &amp; Senior SRE">
  <defs>
    <radialGradient id="qdGlowOrange" cx="90%" cy="10%" r="55%">
      <stop offset="0%" stop-color="#f97316" stop-opacity="0.28" />
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0" />
    </radialGradient>
    <radialGradient id="qdGlowViolet" cx="12%" cy="95%" r="50%">
      <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.18" />
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="qdAccentBar" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#f97316" />
      <stop offset="50%" stop-color="#f59e0b" />
      <stop offset="100%" stop-color="#8b5cf6" />
    </linearGradient>
    <linearGradient id="qdLogoSilver" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#B2BEC6" />
      <stop offset="100%" stop-color="#6A7B87" />
    </linearGradient>
    <linearGradient id="qdLogoOrange" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#F89F64" />
      <stop offset="100%" stop-color="#F37321" />
    </linearGradient>
  </defs>

  <rect width="880" height="204" rx="20" fill="#0A0A0A" stroke="#27272a" stroke-width="1.5" />
  <rect width="880" height="204" rx="20" fill="url(#qdGlowOrange)" />
  <rect width="880" height="204" rx="20" fill="url(#qdGlowViolet)" />

  <g transform="translate(36, 36)">
    <rect width="68" height="68" rx="16" fill="#18181b" stroke="#f97316" stroke-opacity="0.45" stroke-width="1.5" />
    <svg x="10" y="10" width="48" height="48" viewBox="168 56 438 456" fill="none">
      <polygon fill="url(#qdLogoSilver)" points="412.91,318.39 397.15,308.83 395.13,307.47 245.15,216.54 292.52,439.41 408.04,414.87 418.52,464.21 250.5,499.93 174.65,143.07 211.44,135.25 274.47,173.46 279.42,176.52 460.98,286.6 471.2,334.66 471.24,334.65 495.76,450 453.73,510.53" />
      <path fill="#8696A1" d="M210.92,137.78l57.1,34.62l-0.08,0.02l10.09,6.11l147.04,89.15l33.65,20.4l9.52,44.79l1.02,4.62l23.83,112.07L455,504.42l-39.42-185.6l-0.41-1.92l-1.73-1.05l-12.81-7.77l0.07-0.1l-4.18-2.53l-144.93-87.87l-10.08-6.11l2.37,11.17l45.69,214.97l0.98,4.63l4.92-1.05l110.6-23.49l9.49,44.71l-163.09,34.67L177.6,144.86L210.92,137.78z M171.66,141.27l0.24,0.97l76.64,360.52L421.47,466l-11.46-53.97l-115.52,24.54L248.8,221.6l144.93,87.87l-0.07,0.1l16.99,10.3l41.79,196.77l45.97-66.21l-25.22-118.61l-0.04,0.01l-9.93-46.71l-35.38-21.45l0,0l-147.04-89.15l0.07-0.02l-68.92-41.78l-39.25,8.34L171.66,141.27z" />
      <polygon fill="url(#qdLogoOrange)" points="499.84,352.7 499.76,351.58 489.66,304.1 520.58,322.84 547.55,284 546.28,283.22 540.22,254.72 539.82,252.4 512.28,122.91 308.15,166.29 245.14,128.09 554.32,62.36 592.85,243.62 593.02,243.58 603.77,294.17 514.68,422.49" />
      <path fill="#F37321" d="M552.35,65.2l37.53,176.57l1.01,4.75l0.18-0.04l10.04,47.26l-85.15,122.64l-13.45-63.25l0.12-0.17l-0.4-1.89l-8.91-41.9l23.79,14.42l4.18,2.53l2.79-4.01l24.19-34.83l2.73-4.05l-2.45-1.48l-1.36-6.42l-3.97-18.67l0.09-0.02l-1.01-4.75L515.23,124.7l-0.98-4.63l-4.92,1.05l-200.65,42.64l-57.11-34.62L552.35,65.2z M556.29,59.53l-317.58,67.51l68.92,41.78l202.69-43.08l27.05,127.18l-0.09,0.02l0.72,3.35l4.27,20.07l1.77,8.34l0.06,0.03l-24.19,34.83l-33.88-20.54l11.28,53.08l-0.12,0.17l16.23,76.32l92.98-133.92l0.06-0.01l-11.47-53.99l-0.18,0.04L556.29,59.53z" />
    </svg>
  </g>

  <rect x="122" y="24" width="56" height="3" rx="1.5" fill="url(#qdAccentBar)" />

  <g transform="translate(658, 28)">
    <rect width="186" height="28" rx="14" fill="#052e16" stroke="#10b981" stroke-opacity="0.5" stroke-width="1" />
    <circle cx="16" cy="14" r="3.5" fill="#10b981" />
    <text x="27" y="18" fill="#6ee7b7" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10.5" font-weight="700" letter-spacing="0.4">100/100 AGENTSCAN A</text>
  </g>

  <text id="qd-header-wordmark" x="122" y="72" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="34" font-weight="900" letter-spacing="-0.5">
    <tspan fill="#ffffff">QCHAR</tspan><tspan fill="#f97316">.DESIGN</tspan>
  </text>

  <text id="qd-header-subtitle" x="122" y="100" fill="#d4d4d8" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="14.5" font-weight="600">
    Tomasz Kucharski  •  Lead AI DevOps Architect &amp; Senior SRE  •  17+ Yrs Linux &amp; Magento 2
  </text>
  ${pillsSvg}
</svg>
`;
}

function renderStatsSvg(metrics) {
  const cards = [
    {
      x: 36,
      title: 'ACTIVE PROJECTS',
      value: String(metrics.totalRepos),
      sub: `${metrics.privateRepos} Private • ${metrics.publicRepos} Public`,
      accent: '#f97316'
    },
    {
      x: 240,
      title: '12-MONTH ACTIVITY',
      value: metrics.totalContributions.toLocaleString('en-GB'),
      sub: 'Aggregate Commits & Ops',
      accent: '#10b981'
    },
    {
      x: 444,
      title: 'STACK FOOTPRINT',
      value: `${metrics.languageCount} Languages`,
      sub: 'Cross-Repo Production Code',
      accent: '#38bdf8'
    },
    {
      x: 648,
      title: 'GITHUB TENURE',
      value: `${metrics.tenureYears}+ Years`,
      sub: `Archive Since ${metrics.createdYear}`,
      accent: '#a78bfa'
    }
  ];

  const cardsSvg = cards
    .map(
      (c) => `
  <g transform="translate(${c.x}, 56)">
    <rect width="196" height="94" rx="14" fill="#18181b" fill-opacity="0.85" stroke="#27272a" stroke-width="1" />
    <rect x="0" y="0" width="196" height="3" rx="1.5" fill="${c.accent}" fill-opacity="0.7" />
    <text x="16" y="26" fill="${c.accent}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" font-weight="700" letter-spacing="1">${escapeXml(c.title)}</text>
    <text x="16" y="57" fill="#ffffff" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="900">${escapeXml(c.value)}</text>
    <text x="16" y="79" fill="#a1a1aa" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="11" font-weight="600">${escapeXml(c.sub)}</text>
  </g>`
    )
    .join('');

  const barWidth = 808;
  const totalTopPct = metrics.topLanguages.reduce((sum, l) => sum + l.pct, 0) || 100;
  let offsetX = 0;
  const barSegments = metrics.topLanguages
    .map((lang, idx) => {
      const segW =
        idx === metrics.topLanguages.length - 1
          ? Math.max(4, barWidth - offsetX)
          : Math.max(4, Math.round((lang.pct / totalTopPct) * barWidth));
      const rect = `<rect x="${offsetX}" y="0" width="${segW}" height="12" fill="${lang.color}" />`;
      offsetX += segW;
      return rect;
    })
    .join('');

  const legendItems = metrics.topLanguages
    .map((lang, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const lx = 36 + col * 276;
      const ly = 216 + row * 24;
      return `
  <g transform="translate(${lx}, ${ly})">
    <circle cx="5" cy="6" r="4.5" fill="${lang.color}" />
    <text x="18" y="10" fill="#f4f4f5" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12" font-weight="700">${escapeXml(lang.name)}</text>
    <text x="242" y="10" text-anchor="end" fill="#a1a1aa" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11.5" font-weight="700">${lang.pct.toFixed(1)}%</text>
  </g>`;
    })
    .join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 880 290" width="880" height="290" role="img" aria-label="Aggregate Engineering Telemetry">
  <defs>
    <clipPath id="qdLangBarClip">
      <rect x="0" y="0" width="${barWidth}" height="12" rx="6" />
    </clipPath>
    <radialGradient id="qdStatsGlow" cx="85%" cy="15%" r="55%">
      <stop offset="0%" stop-color="#f97316" stop-opacity="0.16" />
      <stop offset="100%" stop-color="#0A0A0A" stop-opacity="0" />
    </radialGradient>
  </defs>

  <rect width="880" height="290" rx="20" fill="#0A0A0A" stroke="#27272a" stroke-width="1.5" />
  <rect width="880" height="290" rx="20" fill="url(#qdStatsGlow)" />

  <text x="36" y="34" fill="#f97316" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="11" font-weight="800" letter-spacing="1.2">AGGREGATE ENGINEERING TELEMETRY</text>

  <g transform="translate(626, 17)">
    <rect width="218" height="24" rx="12" fill="#18181b" stroke="#f97316" stroke-opacity="0.45" stroke-width="1" />
    <circle cx="14" cy="12" r="3" fill="#f97316" />
    <text x="25" y="16" fill="#fdba74" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10" font-weight="700">PRIVATE SOURCE PROTECTED</text>
  </g>
  ${cardsSvg}

  <text x="36" y="176" fill="#d4d4d8" font-family="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="12" font-weight="800">Aggregate Language Distribution (Cross-Repository Byte Share)</text>

  <g transform="translate(36, 188)" clip-path="url(#qdLangBarClip)">
    <rect width="${barWidth}" height="12" fill="#18181b" />
    ${barSegments}
  </g>
  ${legendItems}

  <text x="36" y="272" fill="#71717a" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="10.5">
    Zero private repository names, commit messages, or timestamps exposed • Auto-synced weekly
  </text>
</svg>
`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const metrics = opts.dryRun ? getDryRunMetrics() : await fetchAggregateMetrics();

  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(path.join(opts.outDir, 'header.svg'), renderHeaderSvg(), 'utf8');
  fs.writeFileSync(path.join(opts.outDir, 'stats.svg'), renderStatsSvg(metrics), 'utf8');

  console.log('Generated aggregate profile SVGs (zero private repo names or timestamps exposed).');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
