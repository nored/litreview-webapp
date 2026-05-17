---
paper_id: "431"
title: "Observation of a Vector Charmoniumlike State at 4.7 GeV/c2 and Search for Zcs in e+e- -> K+K- J/psi"
authors:
  - "M. Ablikim"
  - "BESIII Collaboration"
year: 2023
venue: "Physical Review Letters 131, 211902"
pdf_path: "project/data/pdfs/paper_431.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "Introduction"
    para_count: 4
  - type: "experimental_setup"
    heading: "Detector and event selection"
    para_count: 6
  - type: "methods"
    heading: "Cross section measurement and resonance fit"
    para_count: 4
  - type: "methods"
    heading: "Systematic uncertainties"
    para_count: 3
  - type: "results"
    heading: "Search for Zcs in K J/psi"
    para_count: 3
  - type: "conclusion"
    heading: "Summary"
    para_count: 2
  - type: "acknowledgments"
    heading: "Acknowledgments"
    para_count: 1
  - type: "references"
    heading: "References"
    para_count: 1

entities:
  - text: "BESIII"
    type: "system"
    section: "introduction"
  - text: "BEPCII"
    type: "hardware"
    section: "experimental_setup"
  - text: "GEANT4"
    type: "software"
    section: "experimental_setup"
  - text: "EVTGEN"
    type: "software"
    section: "experimental_setup"
  - text: "VLL"
    type: "model"
    section: "experimental_setup"
  - text: "PHSP"
    type: "model"
    section: "experimental_setup"
  - text: "MDC"
    type: "hardware"
    section: "experimental_setup"
  - text: "EMC"
    type: "hardware"
    section: "experimental_setup"
  - text: "MUC"
    type: "hardware"
    section: "experimental_setup"
  - text: "Y(4710)"
    type: "concept"
    section: "results"
  - text: "Y(4230)"
    type: "concept"
    section: "results"
  - text: "Y(4500)"
    type: "concept"
    section: "results"
  - text: "Y(4660)"
    type: "concept"
    section: "introduction"
  - text: "Y(4260)"
    type: "concept"
    section: "introduction"
  - text: "Y(4360)"
    type: "concept"
    section: "introduction"
  - text: "X(3872)"
    type: "concept"
    section: "introduction"
  - text: "Zc(3900)"
    type: "concept"
    section: "introduction"
  - text: "Zcs(3985)"
    type: "concept"
    section: "introduction"
  - text: "Zcs(4000)"
    type: "concept"
    section: "introduction"
  - text: "Zcs(4220)"
    type: "concept"
    section: "introduction"
  - text: "LHCb"
    type: "system"
    section: "introduction"
  - text: "Belle"
    type: "system"
    section: "introduction"
  - text: "Breit-Wigner"
    type: "method"
    section: "methods"
  - text: "Bhabha"
    type: "method"
    section: "experimental_setup"
  - text: "Particle Data Group"
    type: "organisation"
    section: "methods"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "much lower back- ground levels and to improve the statistics, both full reconstruction and partial reconstruction methods are applied"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we report the first observation of the charmoniumlike candidate"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "is observed with a statistical significance over 5"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "which is one of the heaviest vector charmonium- like states"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "our new results confirm that the structure previously reported as evidence in ref. [28] is indeed the"
  - type: "finding"
    stance: "asserts"
    section: "conclusion"
    quote: "we also investigate the zcs states in the kj= ψ system, but no significant structure is observed"
  - type: "first_in_area"
    stance: "asserts"
    section: "introduction"
    quote: "new data above 4.6 gev is analyzed for the first time, which enables us to investigate the y states above 4.6 gev with improved precision"
  - type: "baseline_comparison"
    stance: "extends"
    section: "methods"
    quote: "a maxi- mum likelihood method is used to fit the dressed cross sections obtained in this letter and the dressed cross sections"
  - type: "reports_uncertainty"
    stance: "asserts"
    section: "methods"
    quote: "the total sys- tematic uncertainty is calculated by adding them in quad- rature, resulting in 6.9% (9.4%) for the cross section measurement"
  - type: "challenges_existing"
    stance: "challenges"
    section: "conclusion"
    quote: "the suppression of the decay zcs ð 3985 þ þ → k þ j= ψ dis- favors the qcd sum rule calculation under the mole- cular state assumption"
  - type: "challenges_existing"
    stance: "challenges"
    section: "conclusion"
    quote: "it supports the zcs ð 3985 þ þ and zcs ð 4000 þ þ as two different states"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "the datasets at ffiffiffi s p ¼ 4 . 61 and 4.95 gev are not included in the fit due to their relatively low statistics"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "to further improve studies of the potential zcs state, more statistics are necessary to conduct a partial wave analysis"
  - type: "framework"
    stance: "theorises"
    section: "conclusion"
    quote: "it was suggested that the y ð 4710 þ contains a significant 1 -- charmonium hybrid"

numerical:
  - metric: "integrated_luminosity_fb"
    value: 5.85
    dataset: "BESIII 4.61-4.95 GeV"
    split: null
    quote: "using data samples with an integrated luminosity of 5 . 85 fb"
  - metric: "energy_range_lower_GeV"
    value: 4.61
    dataset: "BESIII scan"
    split: null
    quote: "collected at center-of-mass energies from 4.61 to 4.95 gev"
  - metric: "significance_sigma"
    value: 5.7
    dataset: "three-resonance vs two-resonance fit"
    split: null
    quote: "the statistical significance for the three-resonance assump- tion over the two-resonance assumption is 5 . 7"
  - metric: "delta_minus_2_lnL"
    value: 43.2
    dataset: "three- vs two-resonance fit"
    split: null
    quote: "the change in the likelihood value from the three-resonance model to the two-resonance model is"
  - metric: "Y4710_mass_MeV"
    value: 4708
    dataset: "e+e- -> K+K- J/psi"
    split: null
    quote: "m 3 ¼ 4708 þ 17 - 15 mev =c 2"
  - metric: "Y4710_width_MeV"
    value: 126
    dataset: "e+e- -> K+K- J/psi"
    split: null
    quote: "γ 3 ¼ 126 þ 27 - 23 mev"
  - metric: "Y4230_mass_MeV"
    value: 4226.0
    dataset: "e+e- -> K+K- J/psi"
    split: null
    quote: "m 1 ¼ 4226 . 0 þ 1 . 4 - 1 . 4 mev =c 2"
  - metric: "Y4500_mass_MeV"
    value: 4499.4
    dataset: "e+e- -> K+K- J/psi"
    split: null
    quote: "m 2 ¼ 4499 . 4 þ 8 . 1 - 7 . 6 mev =c 2"
  - metric: "Zcs_significance_sigma"
    value: 2.3
    dataset: "Mmax(K J/psi) simultaneous fit"
    split: null
    quote: "the statistical significance is determined to be 2 . 3"
  - metric: "branching_ratio_upper_limit"
    value: 0.03
    dataset: "Zcs(3985)+ KJ/psi vs DDs"
    split: null
    quote: "is measured to be less than 0.03 at 90% confidence level"
  - metric: "luminosity_systematic"
    value: 0.006
    dataset: "Bhabha"
    split: null
    quote: "the integrated lumi- nosity is measured using bhabha events with an uncertainty of 0.6%"
  - metric: "kinematic_fit_systematic"
    value: 0.021
    dataset: null
    split: null
    quote: "the differ- ence in efficiencies with and without the correction, 2.1%, is assigned as the systematic uncertainty from the kinematic fit"

citation_stance:
  - ref_key: "ref_1"
    stance: "background"
    quote: "the spectrum of c ¯ c charmonium states is well described by a potential model [1]"
  - ref_key: "ref_2"
    stance: "background"
    quote: "there are still many missing states that have not yet been discovered [2]"
  - ref_key: "ref_5"
    stance: "background"
    quote: "useful for identifying these exotic states [5]"
  - ref_key: "ref_28"
    stance: "extends"
    quote: "the besiii experiment has reported evidence for a structure around 4.7 gev"
  - ref_key: "ref_37"
    stance: "extends"
    quote: "an isospin- 1 = 2 charmoniumlike candidate was recently observed by besiii in the process"
  - ref_key: "ref_44"
    stance: "contrasts"
    quote: "lhcb reported tetraquark candidates"
  - ref_key: "ref_60"
    stance: "extends"
    quote: "compared with a previous measurement [60], new data above 4.6 gev is analyzed for the first time"
  - ref_key: "ref_78"
    stance: "supports"
    quote: "in ref. [78], it was suggested that the y ð 4710 þ contains a significant"
  - ref_key: "ref_77"
    stance: "supports"
    quote: "the besiii has recently reported a structure observed in d þ s d  - s system above 4.7 gev [77]"
  - ref_key: "ref_51"
    stance: "supports"
    quote: "as two different states [51]"
  - ref_key: "ref_38"
    stance: "extends"
    quote: "in the fit, following the model in ref. [38]"
  - ref_key: "ref_69"
    stance: "background"
    quote: "the uncertainty from the branching fraction of j= ψ → l þ l - (0.4%) is taken from the particle data group [69]"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false
---

## Limitations and unexamined dimensions

- The two datasets at sqrt(s) = 4.61 and 4.95 GeV are excluded from the Zcs simultaneous fit due to relatively low statistics, leaving the edges of the scanned energy range unprobed for the charged Zcs search.
- The Zcs signal is only a 2.3 sigma excess, so the analysis reports upper limits on Zcs(3985)+ and Zcs(4000)+ production rather than a measurement, and no partial wave analysis is performed.
- The cross section fit relies on phase space and added f0(980)/f0(1500) shapes for the K+K- substructure rather than a full amplitude analysis, and the choice of f-state model contributes a 5.9 to 8.7 percent systematic uncertainty.
- The four-solution ambiguity from the coherent three-Breit-Wigner fit is acknowledged but not resolved, so the extracted (Gamma_ee B)_j products remain non-unique.
- The interpretation of Y(4710) as a hybrid, an excited charmonium, or a mixed state is left open; the data cannot discriminate between these scenarios.
- The branching-fraction ratio R_B is extracted at a single energy (sqrt(s) = 4.68 GeV) rather than combined across the full scan.
