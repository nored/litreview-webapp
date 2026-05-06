// Parser and serializer for protocol/topic.md.
// Round-trips with the CLI repo's format. Form data ↔ markdown.

export function defaults() {
  return {
    title: '',
    description: '',
    categories: [],
    method_families: [
      'rule_based', 'classical_ml', 'deep_learning',
      'llm', 'hybrid', 'formal_methods', 'other',
    ],
    year_min: 2018,
    year_max: 'present',
    msc_target_includes: 50,
    msc_minimum_includes: 30,
    bsc_target_includes: 30,
    bsc_minimum_includes: 15,
    contact_email: '',
  };
}

function indentLines(text, prefix) {
  if (!text) return prefix;
  return text.split('\n').map((l) => prefix + l).join('\n');
}

const TEMPLATE = (d) => `# Topic configuration

Fill this file before running stage one. Every other stage reads it for context.

## Active topic

State the working title of your thesis in one line.

\`\`\`
title: ${d.title}
\`\`\`

## Topic description

Three to five sentences. State the problem, the proposed angle, and why the topic matters.

\`\`\`
description: |
${indentLines(d.description, '  ')}
\`\`\`

## Topic categories

The gap matrix at stage five uses these labels as row headers. Five to twelve categories. Always include \`other\` last.

\`\`\`
categories:
${(d.categories.length ? d.categories : ['other']).map((c) => `  - ${c}`).join('\n')}
\`\`\`

## Method families

The gap matrix uses these labels as column headers. They name how a paper attacks the problem.

\`\`\`
method_families:
${d.method_families.map((c) => `  - ${c}`).join('\n')}
\`\`\`

## Time window

\`\`\`
year_min: ${d.year_min}
year_max: ${d.year_max}
\`\`\`

## Target literature volume

\`\`\`
msc_target_includes: ${d.msc_target_includes}
msc_minimum_includes: ${d.msc_minimum_includes}
bsc_target_includes: ${d.bsc_target_includes}
bsc_minimum_includes: ${d.bsc_minimum_includes}
\`\`\`

## Contact email

The email goes into the User-Agent header of every API request. Many open APIs require this for politeness.

\`\`\`
contact_email: ${d.contact_email || 'REPLACE_WITH_YOUR_EMAIL'}
\`\`\`
`;

export function parse(md) {
  const data = defaults();
  if (!md || !md.trim()) return data;

  const titleMatch = md.match(/title:\s*(.+)/);
  if (titleMatch) {
    const v = titleMatch[1].trim();
    if (!/^a reproducible title/i.test(v)) data.title = v;
  }

  const emailMatch = md.match(/contact_email:\s*(\S+)/);
  if (emailMatch && !emailMatch[1].toUpperCase().startsWith('REPLACE')) {
    data.contact_email = emailMatch[1];
  }

  const yearMin = md.match(/year_min:\s*(\d+)/);
  if (yearMin) data.year_min = parseInt(yearMin[1], 10);
  const yearMax = md.match(/year_max:\s*(\S+)/);
  if (yearMax) data.year_max = yearMax[1].trim();

  for (const k of [
    'msc_target_includes', 'msc_minimum_includes',
    'bsc_target_includes', 'bsc_minimum_includes',
  ]) {
    const m = md.match(new RegExp(`${k}:\\s*(\\d+)`));
    if (m) data[k] = parseInt(m[1], 10);
  }

  // Description block scalar (description: |\n  …)
  const descBlock = md.match(/description:\s*\|\s*\n((?:[ \t]+.*\n?)+)/);
  if (descBlock) {
    const lines = descBlock[1].split('\n');
    const trimmed = lines.map((l) => l.replace(/^[ \t]{2}/, '')).join('\n').trim();
    if (trimmed && !/^replace with/i.test(trimmed)) data.description = trimmed;
  }

  const catBlock = md.match(/categories:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (catBlock) {
    const items = (catBlock[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter((s) => s && !/^replace_with/.test(s));
    if (items.length) data.categories = items;
  }

  const methodBlock = md.match(/method_families:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (methodBlock) {
    const items = (methodBlock[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter(Boolean);
    if (items.length) data.method_families = items;
  }

  return data;
}

export function serialize(data) {
  return TEMPLATE(data);
}
