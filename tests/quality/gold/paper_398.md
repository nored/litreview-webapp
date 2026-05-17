---
paper_id: "398"
title: "SmartEmbed: A Tool for Clone and Bug Detection in Smart Contracts through Structural Code Embedding"
authors:
  - "Zhipeng Gao"
  - "Vinoj Jayasundara"
  - "Lingxiao Jiang"
  - "Xin Xia"
  - "David Lo"
  - "John Grundy"
year: 2019
venue: "arXiv preprint (arXiv:1908.08615)"
pdf_path: "project/data/pdfs/paper_398.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "I. INTRODUCTION"
    para_count: 4
  - type: "methods"
    heading: "II. APPROACH"
    para_count: 12
  - type: "other"
    heading: "III. IMPLEMENTATION DETAILS & TOOL USAGE"
    para_count: 4
  - type: "results"
    heading: "IV. EVALUATION"
    para_count: 2
  - type: "conclusion"
    heading: "V. SUMMARY AND FUTURE WORK"
    para_count: 1
  - type: "acknowledgments"
    heading: "ACKNOWLEDGMENT"
    para_count: 1
  - type: "references"
    heading: "REFERENCES"
    para_count: 9

entities:
  - text: "SmartEmbed"
    type: "tool"
    section: "introduction"
  - text: "Ethereum"
    type: "platform"
    section: "introduction"
  - text: "Solidity"
    type: "other"
    section: "introduction"
  - text: "Fasttext"
    type: "algorithm"
    section: "methods"
  - text: "word2vec"
    type: "algorithm"
    section: "methods"
  - text: "ANTLR"
    type: "tool"
    section: "methods"
  - text: "EtherScan"
    type: "platform"
    section: "other"
  - text: "DECKARD"
    type: "tool"
    section: "results"
  - text: "SmartCheck"
    type: "tool"
    section: "results"
  - text: "Securify"
    type: "tool"
    section: "introduction"
  - text: "Eclone"
    type: "tool"
    section: "introduction"
  - text: "CCLearner"
    type: "tool"
    section: "introduction"
  - text: "abstract syntax tree"
    type: "concept"
    section: "methods"
  - text: "Euclidean distance"
    type: "metric"
    section: "methods"
  - text: "DAO"
    type: "other"
    section: "introduction"
  - text: "Parity"
    type: "other"
    section: "introduction"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we present SMARTEMBED, a web service tool which can be accessible at http://www.smartembed.net"
  - type: "first_in_area"
    stance: "asserts"
    section: "introduction"
    quote: "SMARTEMBED is unique in that it utilizes deep learning and similarity checking techniques to unify clone detection and bug detection together efficiently and accurately for Ethereum smart contracts"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "A major disadvantage is that all these existing tools require certain bug patterns or specification rules defined by human experts"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "the clone ratio of solidity code is at around 90%, much higher than traditional software"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "our tool reports 202 clone related bugs, we manually validate these candidate bugs and 194 of which are labelled as true bugs"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "SmartCheck can only detect 117 of these verified bugs by using the same bug pattern type within our bug database"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "We choose Fasttext [8] as the code embedding algorithm as it performed on par or better compared with traditional word2vec"
  - type: "releases_code"
    stance: "asserts"
    section: "other"
    quote: "The source code and data can be found in our Github repository"
  - type: "limitation"
    stance: "asserts"
    section: "other"
    quote: "we collected 22 well-known vulnerable smart contracts and pinpointed 37 buggy statements in the contracts, which served as the bug database for SMARTEMBED"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "we plan to enrich the contract and bug databases so that SMARTEMBED can detect more clones and bugs"

numerical:
  - metric: "clone_ratio"
    value: 0.90
    dataset: "Ethereum Solidity contracts"
    split: null
    quote: "the clone ratio of solidity code is close to 90%"
  - metric: "precision"
    value: 0.96
    dataset: "SmartEmbed bug database"
    split: null
    quote: "194 clonerelated bugs can be identified efficiently and accurately based on our small bug database with a precision of 96%"
  - metric: "contracts_count"
    value: 22275
    dataset: "EtherScan"
    split: null
    quote: "We collected 22,275 verified Solidity smart contracts using EtherScan"
  - metric: "subcontracts_count"
    value: 135239
    dataset: "EtherScan"
    split: null
    quote: "The contracts contain 135,239 subcontracts"
  - metric: "functions_count"
    value: 631261
    dataset: "EtherScan"
    split: null
    quote: "631,261 functions"
  - metric: "bug_contracts_count"
    value: 22
    dataset: "SmartEmbed bug database"
    split: null
    quote: "we collected 22 well-known vulnerable smart contracts"
  - metric: "buggy_statements_count"
    value: 37
    dataset: "SmartEmbed bug database"
    split: null
    quote: "pinpointed 37 buggy statements in the contracts"
  - metric: "similarity_threshold"
    value: 0.95
    dataset: "SmartEmbed bug database"
    split: null
    quote: "When the similarity threshold is set to 0.95, our tool reports 202 clone related bugs"
  - metric: "candidate_bugs"
    value: 202
    dataset: "SmartEmbed bug database"
    split: null
    quote: "our tool reports 202 clone related bugs"
  - metric: "true_bugs"
    value: 194
    dataset: "SmartEmbed bug database"
    split: null
    quote: "194 of which are labelled as true bugs"
  - metric: "smartcheck_true_bugs"
    value: 117
    dataset: "SmartEmbed bug database"
    split: null
    quote: "SmartCheck can only detect 117 of these verified bugs"
  - metric: "clone_lines"
    value: 6600000
    dataset: "Ethereum Solidity contracts"
    split: null
    quote: "both tools identified around 6.6 million lines of code as code clones"
  - metric: "total_lines"
    value: 7300000
    dataset: "Ethereum Solidity contracts"
    split: null
    quote: "while the total lines are just 7.3 million"

citation_stance:
  - ref_key: "ref_1"
    stance: "background"
    quote: "Many prior works have investigated bug detection of smart contracts (e.g., [1]–[3])"
  - ref_key: "ref_3"
    stance: "contrasts"
    quote: "We compared SMARTEMBED with two well-known tools that are specific for clone detection (DECKARD [9] extended for Solidity) and bug detection (SmartCheck [3]) respectively"
  - ref_key: "ref_4"
    stance: "contrasts"
    quote: "Recently, there are also studies on clones and clone detection for Ethereum smart contracts (e.g., [4], [5]). However, they use expensive symbolic transaction sketch or pair-wise comparisons which affect their efficiency and they are limited to clone detection"
  - ref_key: "ref_5"
    stance: "contrasts"
    quote: "they use expensive symbolic transaction sketch or pair-wise comparisons which affect their efficiency and they are limited to clone detection"
  - ref_key: "ref_6"
    stance: "background"
    quote: "Machine learning and deep learning techniques have been used for clone detection and bug detection problems (e.g. [6], [7]) in traditional software programs too, but little has been applied for smart contracts"
  - ref_key: "ref_8"
    stance: "extends"
    quote: "We choose Fasttext [8] as the code embedding algorithm as it performed on par or better compared with traditional word2vec"
  - ref_key: "ref_9"
    stance: "contrasts"
    quote: "We compared SMARTEMBED with two well-known tools that are specific for clone detection (DECKARD [9] extended for Solidity)"

quality_flags:
  self_constructed_ground_truth: true
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false
---

## Limitations and unexamined dimensions

- The bug database is small, containing only 22 vulnerable contracts and 37 pinpointed buggy statements, which bounds the variety of bugs the tool can recognise by similarity.
- Bug validation of the 202 reported candidates is performed manually by the authors, with no inter-rater agreement or external audit reported.
- The approach only detects bugs that resemble entries already in the bug database, so genuinely novel vulnerabilities outside the seeded patterns cannot be flagged.
- Evaluation against baselines is limited to one clone detector (DECKARD) and one bug detector (SmartCheck), with no comparison to other Ethereum analysers such as Securify or Oyente.
- The similarity threshold of 0.95 for bug detection is fixed without a sensitivity analysis or precision-recall curve over alternative thresholds.
- The work is restricted to Solidity contracts collected from EtherScan, with no evaluation on Vyper, other EVM languages, or non-EVM smart contract platforms.
