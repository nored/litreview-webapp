// Default content for protocol files. Used to seed a fresh project so the
// student has something to edit instead of an empty box.

export const TOPIC_DEFAULT = `# Topic configuration

Fill this file before running stage one. Every other stage reads it for context.

## Active topic

State the working title of your thesis in one line.

\`\`\`
title: A Reproducible Title for the Working Thesis Topic
\`\`\`

## Topic description

Write three to five sentences. State the problem, the proposed angle, and why the topic matters.

\`\`\`
description: |
  Replace with a short description of your topic. State the problem the thesis
  addresses, the proposed angle of attack, and what would make the result
  scientifically interesting. Keep it concrete.
\`\`\`

## Topic categories

The gap matrix at stage five uses these labels as row headers. List five to twelve categories you expect to see in the literature for your topic. Always include \`other\` as the final category.

\`\`\`
categories:
  - replace_with_category_one
  - replace_with_category_two
  - replace_with_category_three
  - replace_with_category_four
  - replace_with_category_five
  - other
\`\`\`

## Method families

The gap matrix uses these labels as column headers. They name how a paper attacks the problem.

\`\`\`
method_families:
  - rule_based
  - classical_ml
  - deep_learning
  - llm
  - hybrid
  - formal_methods
  - other
\`\`\`

## Time window

\`\`\`
year_min: 2018
year_max: present
\`\`\`

## Target literature volume

\`\`\`
msc_target_includes: 50
msc_minimum_includes: 30
bsc_target_includes: 30
bsc_minimum_includes: 15
\`\`\`

## Contact email

Set the email that goes into the User-Agent header of every API request. Many open APIs require this for politeness.

\`\`\`
contact_email: REPLACE_WITH_YOUR_EMAIL
\`\`\`
`;

export const SEARCH_QUERIES_DEFAULT = `# Search Queries

Replace the example queries with queries for your topic before running stage one.

## Query bank

List eight to twelve queries that cover your topic. Each query runs against all three sources.

\`\`\`
example topic core query
example topic synonym query
example topic alternative phrasing
example topic methodology angle one
example topic methodology angle two
example topic adjacent domain transfer
\`\`\`

## Manual additions

Papers added by hand that the automated search may miss.

\`\`\`yaml
- title: ""
  authors: ""
  year:
  venue: ""
  doi: ""
  url: ""
  reason: ""
\`\`\`
`;

export const INCLUSION_CRITERIA_DEFAULT = `# Inclusion and Exclusion Criteria

PRISMA-style criteria for triage at stage two. Triage operates on title and abstract only.

## Inclusion criteria

A paper is included if all of the following hold.

The paper is published in a peer-reviewed venue, an arXiv preprint, a recognized industry research publication, or a thesis from an accredited university.

The paper addresses the topic configured in topic.md either directly or through a methodology that plausibly transfers to that topic.

The paper proposes a method, presents an empirical evaluation, or contributes a benchmark or dataset.

The publication year is within the time window stated in topic.md.

The paper is in a language the student can read.

## Exclusion criteria

A paper is excluded if any of the following hold.

The paper addresses a different problem class with no transfer to the active topic.

The paper is a duplicate of an already included paper.

The paper is a vendor white paper or marketing piece without methodology disclosure.

The paper is a tutorial, a textbook chapter, or a workshop poster without empirical content.

## Triage decision values

\`include\` means the paper passes all inclusion criteria and fails no exclusion criterion.

\`exclude\` means the paper fails at least one exclusion criterion.

\`maybe\` means the abstract is ambiguous and full text is needed to decide.
`;
