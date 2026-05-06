import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT, 'public');
export const PROJECT_DIR = process.env.LITREVIEW_PROJECT
  ? path.resolve(process.env.LITREVIEW_PROJECT)
  : path.join(ROOT, 'project');

export const PROTOCOL_DIR = path.join(PROJECT_DIR, 'protocol');
export const DATA_DIR = path.join(PROJECT_DIR, 'data');
export const PDFS_DIR = path.join(DATA_DIR, 'pdfs');
export const NOTES_DIR = path.join(PROJECT_DIR, 'notes');
export const SYNTHESIS_DIR = path.join(PROJECT_DIR, 'synthesis');

export const PROTOCOL_FILES = {
  topic: path.join(PROTOCOL_DIR, 'topic.md'),
  search_queries: path.join(PROTOCOL_DIR, 'search_queries.md'),
  inclusion_criteria: path.join(PROTOCOL_DIR, 'inclusion_criteria.md'),
  note_schema: path.join(PROTOCOL_DIR, 'note_schema.md'),
  indicator_rubric: path.join(PROTOCOL_DIR, 'indicator_rubric.md'),
};

export const DATA_FILES = {
  candidates_raw: path.join(DATA_DIR, 'candidates_raw.csv'),
  candidates_triaged: path.join(DATA_DIR, 'candidates_triaged.csv'),
  search_log: path.join(DATA_DIR, 'search_log.jsonl'),
  triage_summary: path.join(DATA_DIR, 'triage_summary.md'),
  download_log: path.join(DATA_DIR, 'download_log.csv'),
  manual_retrieval_list: path.join(DATA_DIR, 'manual_retrieval_list.md'),
  deep_read_log: path.join(DATA_DIR, 'deep_read_log.csv'),
};

export const SYNTHESIS_FILES = {
  gap_matrix: path.join(SYNTHESIS_DIR, 'gap_matrix.md'),
  gap_candidates: path.join(SYNTHESIS_DIR, 'gap_candidates.md'),
  indicator_assessment: path.join(SYNTHESIS_DIR, 'indicator_assessment.md'),
  shortlist: path.join(SYNTHESIS_DIR, 'shortlist.md'),
  positioning_statement: path.join(SYNTHESIS_DIR, 'positioning_statement.md'),
  prisma_flow: path.join(SYNTHESIS_DIR, 'prisma_flow.md'),
};
