// Parser and serializer for protocol/search_queries.md.
// Round-trips with the CLI repo's format. Form data ↔ markdown.

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export function defaults() {
  return {
    queries: [],
    manual_additions: [],
  };
}

export function parse(md) {
  const data = defaults();
  if (!md || !md.trim()) return data;

  // Query bank: first fenced code block under "## Query bank"
  const qbMatch = md.match(/##\s+Query bank[\s\S]*?```(?:\w*\n)?([\s\S]*?)```/);
  if (qbMatch) {
    data.queries = qbMatch[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !/^example topic/i.test(l));
  }

  // Manual additions: YAML fenced blocks under "## Manual additions"
  const maSection = md.match(/##\s+Manual additions[\s\S]*?(?=\n##\s|$)/);
  if (maSection) {
    const yamlBlocks = [...maSection[0].matchAll(/```(?:yaml)?\n([\s\S]*?)```/g)];
    for (const block of yamlBlocks) {
      try {
        const parsed = parseYaml(block[1]);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object' && (item.title || item.doi)) {
              data.manual_additions.push({
                title: item.title ?? '',
                authors: item.authors ?? '',
                year: item.year ?? '',
                venue: item.venue ?? '',
                doi: item.doi ?? '',
                url: item.url ?? '',
                pdf_url: item.pdf_url ?? '',
                reason: item.reason ?? '',
              });
            }
          }
        }
      } catch {
        /* skip malformed yaml */
      }
    }
  }

  return data;
}

const TEMPLATE = (data) => {
  const queryLines = data.queries.length
    ? data.queries.join('\n')
    : 'example topic core query\nexample topic synonym query';

  const manualBlock = data.manual_additions.length
    ? stringifyYaml(data.manual_additions.map((m) => ({
        title: m.title,
        authors: m.authors,
        year: m.year,
        venue: m.venue,
        doi: m.doi,
        url: m.url,
        pdf_url: m.pdf_url,
        reason: m.reason,
      })))
    : `- title: ""\n  authors: ""\n  year:\n  venue: ""\n  doi: ""\n  url: ""\n  reason: ""\n`;

  return `# Search Queries

Replace the example queries with queries for your topic before running stage one.

## Search sources

Three open APIs are queried at stage one. Paywalled databases are excluded from the automated pipeline.

\`\`\`
sources:
  - name: arxiv
    api: http://export.arxiv.org/api/query
    rate_limit: 1 request per 3 seconds
  - name: openalex
    api: https://api.openalex.org/works
    rate_limit: 10 requests per second
  - name: semantic_scholar
    api: https://api.semanticscholar.org/graph/v1/paper/search
    rate_limit: 1 request per second without API key
\`\`\`

## Query bank

List eight to twelve queries that cover your topic. Each query runs against all three sources.

\`\`\`
${queryLines}
\`\`\`

## Manual additions

The student lists papers that the automated search may miss. Each entry is appended to data/candidates_raw.csv with source_database = manual_addition.

\`\`\`yaml
${manualBlock.trim()}
\`\`\`

## Output

Stage one writes \`data/candidates_raw.csv\` with one row per result and \`data/search_log.jsonl\` with one line per query executed.
`;
};

export function serialize(data) {
  return TEMPLATE(data);
}
