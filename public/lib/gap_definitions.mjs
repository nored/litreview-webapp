// public/lib/gap_definitions.mjs
//
// The seven research-gap categories per Miles (2017), with the operational
// definition this tool's detectors use to surface candidates. Cited so the
// research user can defend the framing in print.
//
// Source: Miles, D. A. (2017). A Taxonomy of Research Gaps: Identifying
// and Defining the Seven Research Gaps. Doctoral Student Workshop on
// Finding Research Gaps, Dallas, Texas. Synthesises Robinson, Saldanha &
// McKoy (2011) — 5 types — and Müller-Bloch & Kranz (2014) — 6 types —
// into a 7-point model.
//
// The `signals` field names the structured-store rows each detector reads
// from. Useful in the UI when explaining "why nothing was detected here"
// — the user sees the inputs the detector needs and which are empty.

export const MILES_2017_REFERENCE = {
  short: 'Miles (2017) · 7-gap taxonomy',
  long: 'Miles, D. A. (2017). A Taxonomy of Research Gaps: Identifying and Defining the Seven Research Gaps. Doctoral Student Workshop on Finding Research Gaps, Dallas, Texas.',
  link: 'https://www.academia.edu/35505149/ARTICLE_RESEARCH_A_Taxonomy_of_Research_Gaps_Identifying_and_Defining_the_Seven_Research_Gaps',
  see_also: [
    {
      cite: 'Adu & Miles (2024) ch. 5 — Understanding the Seven Types of Research Gaps',
      link: 'https://fenix.iseg.ulisboa.pt/downloadFile/844558074131852/Adu_Miles_2024_Cap5.pdf',
    },
    {
      cite: 'Robinson, Saldanha & McKoy (2011) — Frameworks for Determining Research Gaps During Systematic Reviews (AHRQ/NCBI)',
      link: 'https://www.ncbi.nlm.nih.gov/books/NBK62478/',
    },
    {
      cite: 'Müller-Bloch & Kranz (2014) — six-point model',
      link: '',
    },
  ],
};

export const GAP_DEFINITIONS = {
  evidence: {
    label: 'Evidence gap',
    definition: 'Findings on the same metric × dataset contradict each other, or a widely accepted conclusion is challenged by new evidence.',
    signals: ['results (metric, value, dataset, split)', 'claims with stance=challenges / validates'],
    detector_logic: 'High variance (range, coefficient of variation) over shared (metric, dataset) pairs.',
  },
  knowledge: {
    label: 'Knowledge gap',
    definition: 'A combination of category × method × domain that the literature has not yet explored, surrounded by neighbouring cells that have.',
    signals: ['paper_category', 'paper_field.method_family', 'paper_field.system_domain'],
    detector_logic: 'Empty cells in the (category × method × domain) tensor whose Hamming-1 neighbours are densely populated.',
  },
  practical: {
    label: 'Practical-knowledge gap',
    definition: 'Observed practitioner behaviour or applied studies diverge from what the theoretical / review literature recommends.',
    signals: ['claims (stance × claim_type)', 'paper_field.methodology_type'],
    detector_logic: 'Clusters where survey / observational / case-study papers dominate while experimental / formal / review work is sparse, or where critical and assertive claims sit on opposite sides of a methodology cut.',
  },
  methodological: {
    label: 'Methodological gap',
    definition: 'Conflicts that arise from the methodological choice itself — the cell warrants methods that no paper has applied.',
    signals: ['paper_category', 'paper_field.method_family'],
    detector_logic: 'Empty (category × method_family) cells where the row marginal is ≥ minPapersPerGroup — i.e. that category has plenty of papers but none of them used this method.',
  },
  empirical: {
    label: 'Empirical gap',
    definition: 'Claims that are theorised but never empirically validated — the assertion exists, the verification does not.',
    signals: ['claims with stance ∈ {theorises, validates}'],
    detector_logic: 'Per claim-embedding cluster: count theorises vs validates. Flag clusters with ≥2 "theorises" claims and zero "validates" claims.',
  },
  theoretical: {
    label: 'Theoretical gap',
    definition: 'Voids in the conceptual framework — orphan or disputed framework clusters where existing theory cannot explain phenomena.',
    signals: ['name_usage (kind=framework)', 'paper_field.challenges_existing'],
    detector_logic: 'Per category: ratio of papers to distinct cited frameworks ≥ 5 (orphan), or fraction of papers with challenges_existing=true ≥ 25% (disputed).',
  },
  population: {
    label: 'Population gap',
    definition: 'Populations or settings under-represented in the corpus relative to the cells around them.',
    signals: ['paper_field.system_domain', 'paper_field.sample_type', 'paper_population'],
    detector_logic: 'Sparse cells in the (system_domain × sample_type) sub-tensor with substantial marginals on each axis.',
  },
};

// Diagnose what's missing for a given gap type given the current
// coverage snapshot. Returns short strings the UI can render next to the
// detector's "no candidates" line. Mirrors the precondition checks in
// detectors/index.mjs but framed for the gap definition.
export function diagnoseMissingInputs(gapType, coverage) {
  if (!coverage) return [];
  const issues = [];
  const fieldPopulated = (name) =>
    (coverage.fields_by_name?.[name]?.populated_pct || 0);
  if (gapType === 'methodological') {
    if (fieldPopulated('method_family') < 30)
      issues.push(`method_family populated on only ${fieldPopulated('method_family').toFixed(0)}% of papers — extract first or auto-seed topic.md if methods are missing.`);
    if ((coverage.tables?.paper_category?.populated || 0) === 0)
      issues.push('no paper_category rows yet — auto-seed topic.md or run extraction.');
  }
  if (gapType === 'knowledge' || gapType === 'population') {
    if (fieldPopulated('system_domain') < 30)
      issues.push(`system_domain populated on only ${fieldPopulated('system_domain').toFixed(0)}% — re-run extraction.`);
  }
  if (gapType === 'evidence') {
    if ((coverage.tables?.results?.populated || 0) === 0)
      issues.push('results table is empty — the extractor found no numerical findings to compare.');
  }
  if (gapType === 'empirical' || gapType === 'practical') {
    if ((coverage.tables?.claims?.populated || 0) === 0)
      issues.push('claims table is empty — run extraction to populate substring-validated quote/stance pairs.');
  }
  if (gapType === 'theoretical') {
    // Look at every named-entity kind whose label resembles a theoretical
    // anchor. This matches resolveTheoreticalKinds() server-side.
    const namedKinds = coverage.named_entities || [];
    const ANCHOR_RE = /(framework|theory|concept|ideology|doctrine|paradigm|principle|model)/i;
    const anchorRows = namedKinds.filter((row) => ANCHOR_RE.test(row.kind || ''));
    const anchorTotal = anchorRows.reduce((s, r) => s + (r.total || 0), 0);
    if (anchorTotal === 0) {
      const knownKinds = namedKinds.map((r) => r.kind).filter(Boolean).join(', ') || '(none)';
      issues.push(`no theoretical-anchor entities extracted. Kinds present in the corpus: ${knownKinds}. Add a "framework / theory / concept / doctrine"-like type to topic.md entity_types and re-extract.`);
    }
  }
  return issues;
}
