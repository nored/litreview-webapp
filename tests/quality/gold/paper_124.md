---
paper_id: "124"
title: "Adversarial Machine Learning in Network Security: A Systematic Review of Threat Vectors and Defense Mechanisms"
authors:
  - "Abdul Awal Mintoo"
  - "Ashrafur Rahman Nabil"
  - "Md Ashraful Alam"
year: 2024
venue: "Innovatech Engineering Journal"
pdf_path: "project/data/pdfs/paper_124.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "ABSTRACT"
    para_count: 1
  - type: "introduction"
    heading: "1 INTRODUCTION"
    para_count: 5
  - type: "related_work"
    heading: "2 LITERATURE REVIEW"
    para_count: 18
  - type: "methods"
    heading: "3 METHOD"
    para_count: 6
  - type: "results"
    heading: "4 FINDINGS"
    para_count: 6
  - type: "discussion"
    heading: "5 DISCUSSION"
    para_count: 5
  - type: "conclusion"
    heading: "6 CONCLUSION"
    para_count: 1
  - type: "references"
    heading: "REFERENCES"
    para_count: 1

entities:
  - text: "Adversarial Machine Learning"
    type: "concept"
    section: "abstract"
  - text: "PRISMA"
    type: "framework"
    section: "abstract"
  - text: "evasion attacks"
    type: "attack"
    section: "abstract"
  - text: "poisoning attacks"
    type: "attack"
    section: "abstract"
  - text: "model extraction attacks"
    type: "attack"
    section: "abstract"
  - text: "adversarial training"
    type: "defense"
    section: "abstract"
  - text: "input preprocessing"
    type: "defense"
    section: "abstract"
  - text: "robust model design"
    type: "defense"
    section: "abstract"
  - text: "Fast Gradient Sign Method"
    type: "method"
    section: "related_work"
  - text: "FGSM"
    type: "method"
    section: "related_work"
  - text: "Projected Gradient Descent"
    type: "method"
    section: "related_work"
  - text: "PGD"
    type: "method"
    section: "related_work"
  - text: "defensive distillation"
    type: "defense"
    section: "related_work"
  - text: "gradient obfuscation"
    type: "defense"
    section: "related_work"
  - text: "ensemble defenses"
    type: "defense"
    section: "related_work"
  - text: "generative adversarial networks"
    type: "method"
    section: "related_work"
  - text: "GANs"
    type: "method"
    section: "related_work"
  - text: "intrusion detection systems"
    type: "system"
    section: "related_work"
  - text: "IEEE Xplore"
    type: "tool"
    section: "methods"
  - text: "PubMed"
    type: "tool"
    section: "methods"
  - text: "SpringerLink"
    type: "tool"
    section: "methods"
  - text: "Scopus"
    type: "tool"
    section: "methods"
  - text: "MNIST"
    type: "dataset"
    section: "related_work"
  - text: "CIFAR-10"
    type: "dataset"
    section: "related_work"
  - text: "ImageNet"
    type: "dataset"
    section: "related_work"
  - text: "blockchain"
    type: "concept"
    section: "related_work"
  - text: "federated learning"
    type: "concept"
    section: "related_work"
  - text: "edge computing"
    type: "concept"
    section: "related_work"
  - text: "differential privacy"
    type: "defense"
    section: "related_work"
  - text: "feature denoising"
    type: "defense"
    section: "related_work"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "The primary objective of this systematic review is to provide a comprehensive analysis of adversarial machine learning (AML) within the context of network security, with a specific focus on identifying and categorizing threat vectors and evaluating defense mechanisms"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "This study adhered to the Preferred Reporting Items for Systematic Reviews and Meta-Analyses (PRISMA) guidelines, which provided a structured framework for conducting a systematic, transparent, and rigorous review process"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "The systematic review highlighted that evasion attacks are the most extensively researched adversarial threat vector, with 65 of the 135 reviewed articles addressing their mechanisms, consequences, and defense strategies"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "In analyzing defense mechanisms, adversarial training emerged as the most frequently proposed solution, discussed in 55 reviewed articles with over 5,000 citations"
  - type: "baseline_comparison"
    stance: "extends"
    section: "discussion"
    quote: "This study extends those findings by highlighting how evasion attacks have evolved in sophistication, incorporating black-box and query-based techniques that challenge even advanced detection systems"
  - type: "challenges_existing"
    stance: "challenges"
    section: "discussion"
    quote: "Unlike prior research, which often viewed model extraction attacks as a niche threat, this study emphasizes their broader implications for commercial and proprietary ML systems"
  - type: "limitation"
    stance: "asserts"
    section: "discussion"
    quote: "approximately 60% of the articles emphasized that adversarial training alone is insufficient, particularly against adaptive attacks that evolve to bypass defenses"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "over 60% of these articles underlined the challenges of detecting poisoning attacks, especially in large-scale datasets"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "Addressing these challenges requires a multifaceted approach that combines technical innovation, policy support, and industry-academic partnerships to develop versatile, real-time, and future-ready defenses against adversarial threats in network security"
  - type: "finding"
    stance: "asserts"
    section: "conclusion"
    quote: "This review also identifies the lack of standardized evaluation frameworks and interdisciplinary collaboration as critical gaps that hinder the practical implementation of AML solutions"

numerical:
  - metric: "articles_retrieved"
    value: 1237
    dataset: null
    split: null
    quote: "A total of 1,237 articles were initially retrieved from this step"
  - metric: "articles_after_dedup"
    value: 952
    dataset: null
    split: null
    quote: "After duplicates were excluded, 952 articles remained"
  - metric: "articles_after_screening"
    value: 531
    dataset: null
    split: null
    quote: "531 articles were deemed relevant and carried forward for a more detailed assessment"
  - metric: "articles_eligible"
    value: 157
    dataset: null
    split: null
    quote: "157 articles met the eligibility criteria and were included in the final dataset for analysis"
  - metric: "articles_final"
    value: 135
    dataset: null
    split: null
    quote: "leaving 135 high-quality articles for final synthesis"
  - metric: "evasion_articles"
    value: 65
    dataset: null
    split: null
    quote: "evasion attacks are the most extensively researched adversarial threat vector, with 65 of the 135 reviewed articles"
  - metric: "evasion_citations"
    value: 4000
    dataset: null
    split: null
    quote: "Across these articles, with a collective citation count exceeding 4,000"
  - metric: "poisoning_articles"
    value: 45
    dataset: null
    split: null
    quote: "Poisoning attacks were identified as the second most extensively discussed adversarial technique, with 45 reviewed articles"
  - metric: "poisoning_citations"
    value: 3200
    dataset: null
    split: null
    quote: "approximately 3,200 total citations emphasizing their impact on training datasets and model performance"
  - metric: "model_extraction_articles"
    value: 30
    dataset: null
    split: null
    quote: "Model extraction attacks emerged as another significant threat, with 30 reviewed articles and a combined citation count of 2,500"
  - metric: "model_extraction_citations"
    value: 2500
    dataset: null
    split: null
    quote: "Model extraction attacks emerged as another significant threat, with 30 reviewed articles and a combined citation count of 2,500"
  - metric: "adversarial_training_articles"
    value: 55
    dataset: null
    split: null
    quote: "adversarial training emerged as the most frequently proposed solution, discussed in 55 reviewed articles with over 5,000 citations"
  - metric: "adversarial_training_citations"
    value: 5000
    dataset: null
    split: null
    quote: "discussed in 55 reviewed articles with over 5,000 citations"
  - metric: "emerging_defense_articles"
    value: 25
    dataset: null
    split: null
    quote: "represent a promising direction, as highlighted in 25 reviewed articles with approximately 2,800 citations"
  - metric: "emerging_defense_citations"
    value: 2800
    dataset: null
    split: null
    quote: "25 reviewed articles with approximately 2,800 citations"

citation_stance:
  - ref_key: "Liu2018"
    stance: "supports"
    quote: "studies have revealed that even well-trained ML models can be deceived with imperceptible perturbations to input data, making the systems vulnerable to significant breaches (Liu et al., 2018)"
  - ref_key: "Olowononi2021"
    stance: "supports"
    quote: "Olowononi et al. (2021) demonstrated that black-box attacks could reverse-engineer models with minimal queries, underlining the pressing need for robust countermeasures"
  - ref_key: "Zhao2022"
    stance: "supports"
    quote: "Zhao et al. (2022) demonstrated that adversarial examples could bypass ML-based image recognition systems in physical-world settings, raising concerns about the reliability of these models in high-stakes environments"
  - ref_key: "Pierazzi2020"
    stance: "supports"
    quote: "Pierazzi et al. (2020) demonstrated that adversarial training could significantly enhance the resilience of deep neural networks to gradient-based attacks like FGSM and Projected Gradient Descent (PGD)"
  - ref_key: "Duddu2018"
    stance: "supports"
    quote: "Duddu (2018) demonstrated that gradient-based attacks, such as the Fast Gradient Sign Method (FGSM), exploit predictable decision boundaries in machine learning models, rendering traditional defenses inadequate"
  - ref_key: "CarliniWagner2018"
    stance: "supports"
    quote: "Carlini and Wagner (2018) highlighted how poisoning attacks could render cybersecurity systems ineffective, especially in collaborative or federated learning scenarios where data is sourced from multiple untrusted entities"
  - ref_key: "Papernot2016"
    stance: "extends"
    quote: "Earlier studies, such as Papernot et al. (2016), highlighted adversarial training as a promising solution for improving model robustness against specific attack types. This review expands on those findings by noting the scalability challenges associated with adversarial training"
  - ref_key: "LowdMeek2005"
    stance: "extends"
    quote: "Earlier studies, such as those by Lowd and Meek (2005), explored the feasibility of extracting model parameters through systematic querying of ML APIs, highlighting the risks associated with model theft. This study builds on those findings"
  - ref_key: "Yan2019"
    stance: "supports"
    quote: "Yan et al. (2019) demonstrated the feasibility of poisoning attacks in corrupting datasets to degrade model accuracy significantly. This study corroborates those findings"
  - ref_key: "Menendez2019"
    stance: "supports"
    quote: "Menéndez et al. (2019) reported that evasion attacks on financial transaction monitoring systems resulted in undetected fraudulent transactions, causing millions of dollars in losses"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: true
  hobby_project_scale: false
  predictable_outcome: false
---

## Limitations and unexamined dimensions

- The review limits its search window to peer-reviewed articles published between 2015 and 2023, so newer 2024 work and pre-2015 foundational studies are out of scope.
- Article identification draws on four databases (IEEE Xplore, PubMed, SpringerLink, Scopus) and English-language sources, leaving venues outside this set unsearched.
- Quality appraisal and thematic categorisation are described as checklist-based but no inter-rater agreement, kappa, or independent screening protocol is reported.
- The synthesis is purely narrative and counts articles or citations per theme; no quantitative meta-analysis, effect sizes, or pooled performance numbers across primary studies are computed.
- Findings rely on counts of how many reviewed articles discuss each attack or defense, which conflates research attention with empirical effectiveness and is not adjusted for publication bias.
- The review identifies the lack of standardised evaluation benchmarks for AML defenses but does not itself propose or pilot a benchmark, leaving the gap descriptive rather than addressed.
