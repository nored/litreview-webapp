// Parser and serializer for protocol/topic.md.
// Round-trips with the on-disk schema written by server/templates.mjs.
// V2 schema: target_includes / minimum_includes (single pair, was MSc/BSc
// before the research-domain repositioning).

export function defaults() {
  return {
    title: '',
    description: '',
    categories: [],
    // No method-family defaults: every prior set was field-specific (the
    // CS/ML labels were a thesis-tool artefact). Method families are
    // axis labels for the methodological-gap and knowledge-gap detectors;
    // they must match the actual domain to be useful. Empty by default;
    // either edit them in Setup or click "Auto-seed from corpus" on the
    // Deep Read view to derive them from your imported papers.
    method_families: [],
    entity_types: [],
    year_min: 2018,
    year_max: 'present',
    target_includes: 40,
    minimum_includes: 20,
    contact_email: '',
  };
}

function indentLines(text, prefix) {
  if (!text) return prefix;
  return text.split('\n').map((l) => prefix + l).join('\n');
}

const TEMPLATE = (d) => `# Topic configuration

Fill this file before running stage one. Every other stage reads it for context.

## Active review focus

State the title or focus of the review in one line.

\`\`\`
title: ${d.title}
\`\`\`

## Description

Three to five sentences. State the problem, the angle of attack, and what would make the result scientifically interesting.

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

## Entity types

What KINDS of named entities the type-prompted NER should look for in each paper. Domain-specific: for CS expect "library / dataset / model"; for history "person / treaty / regime"; for business "company / kpi / regulation". The extractor classifies every span it finds into one of these types via cosine similarity to type prototypes + NLI verification.

\`\`\`
entity_types:
${(d.entity_types?.length ? d.entity_types : ['concept']).map((c) => `  - ${c}`).join('\n')}
\`\`\`

## Time window

\`\`\`
year_min: ${d.year_min}
year_max: ${d.year_max}
\`\`\`

## Target literature volume

\`\`\`
target_includes: ${d.target_includes}
minimum_includes: ${d.minimum_includes}
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

  // v2 schema fields. Fall back to v1 MSc target if present (migration
  // path for projects that still have the old shape on disk).
  for (const k of ['target_includes', 'minimum_includes']) {
    const m = md.match(new RegExp(`${k}:\\s*(\\d+)`));
    if (m) data[k] = parseInt(m[1], 10);
  }
  const legacyMscTarget = md.match(/msc_target_includes:\s*(\d+)/);
  if (legacyMscTarget && data.target_includes === defaults().target_includes) {
    data.target_includes = parseInt(legacyMscTarget[1], 10);
  }
  const legacyMscMin = md.match(/msc_minimum_includes:\s*(\d+)/);
  if (legacyMscMin && data.minimum_includes === defaults().minimum_includes) {
    data.minimum_includes = parseInt(legacyMscMin[1], 10);
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

  const entBlock = md.match(/entity_types:\s*\n((?:[ \t]*-[ \t]*\S.*\n?)+)/);
  if (entBlock) {
    const items = (entBlock[1].match(/-\s*([^\n]+)/g) || [])
      .map((s) => s.replace(/^-\s*/, '').trim())
      .filter((s) => s && !/^replace_with/.test(s));
    if (items.length) data.entity_types = items;
  }

  return data;
}

export function serialize(data) {
  return TEMPLATE(data);
}
