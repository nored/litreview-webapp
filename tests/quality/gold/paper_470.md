---
paper_id: "470"
title: "MoEcho: Exploiting Side-Channel Attacks to Compromise User Privacy in Mixture-of-Experts LLMs"
authors:
  - "Ruyi Ding"
  - "Tianhong Xu"
  - "Xinyi Shen"
  - "Aidong Adam Ding"
  - "Yunsi Fei"
year: 2025
venue: "arXiv preprint (arXiv:2508.15036)"
pdf_path: "project/data/pdfs/paper_470.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "1 Introduction"
    para_count: 6
  - type: "background"
    heading: "2 Background"
    para_count: 4
  - type: "methods"
    heading: "3 MoEcho-A New Attack Surface on MoE"
    para_count: 5
  - type: "methods"
    heading: "4 Side-channels on MoE Systems"
    para_count: 8
  - type: "methods"
    heading: "5 Proposed Attacks"
    para_count: 5
  - type: "experimental_setup"
    heading: "6 Evaluations"
    para_count: 4
  - type: "results"
    heading: "6.2 Attack Performance"
    para_count: 6
  - type: "results"
    heading: "6.3 End-to-End Evaluation"
    para_count: 4
  - type: "discussion"
    heading: "6.4 Ablation Studies"
    para_count: 3
  - type: "discussion"
    heading: "6.5 Robustness to System Noise"
    para_count: 4
  - type: "discussion"
    heading: "6.6 Practicality Analysis of MoEcho"
    para_count: 3
  - type: "related_work"
    heading: "7 Related Works"
    para_count: 3
  - type: "discussion"
    heading: "8 Discussion & Conclusions"
    para_count: 4
  - type: "conclusion"
    heading: "8.3 Conclusions"
    para_count: 1
  - type: "other"
    heading: "9 Ethical Concern"
    para_count: 1
  - type: "references"
    heading: "References"
    para_count: 66
  - type: "appendix"
    heading: "A Implementation of DeepSeekMoE"
    para_count: 2
  - type: "appendix"
    heading: "B Diagram of Four Proposed Attacks"
    para_count: 4
  - type: "appendix"
    heading: "C Model Structures Used in Attacks"
    para_count: 1
  - type: "appendix"
    heading: "D Templates of Healthcare Datasets"
    para_count: 1

entities:
  - text: "MoEcho"
    type: "attack"
    section: "introduction"
  - text: "Mixture-of-Experts"
    type: "framework"
    section: "introduction"
  - text: "DeepSeek-V2 Lite"
    type: "model"
    section: "introduction"
  - text: "DeepSeekMoE"
    type: "model"
    section: "background"
  - text: "Qwen1.5-MoE"
    type: "model"
    section: "experimental_setup"
  - text: "TinyMixtral"
    type: "model"
    section: "experimental_setup"
  - text: "DeepSeek-VL2"
    type: "model"
    section: "experimental_setup"
  - text: "Cache Occupancy"
    type: "attack"
    section: "methods"
  - text: "Pageout+Reload"
    type: "attack"
    section: "methods"
  - text: "Performance Counter"
    type: "attack"
    section: "methods"
  - text: "TLB Evict+Reload"
    type: "attack"
    section: "methods"
  - text: "Prompt Inference Attack"
    type: "attack"
    section: "methods"
  - text: "Response Reconstruction Attack"
    type: "attack"
    section: "methods"
  - text: "Visual Inference Attack"
    type: "attack"
    section: "methods"
  - text: "Visual Reconstruction Attack"
    type: "attack"
    section: "methods"
  - text: "Flush+Reload"
    type: "attack"
    section: "methods"
  - text: "AMD Ryzen Threadripper Pro"
    type: "hardware"
    section: "experimental_setup"
  - text: "NVIDIA RTX A6000"
    type: "hardware"
    section: "experimental_setup"
  - text: "Nsight"
    type: "tool"
    section: "methods"
  - text: "CelebA"
    type: "dataset"
    section: "experimental_setup"
  - text: "Medical Q&A"
    type: "dataset"
    section: "experimental_setup"
  - text: "Financial Q&A"
    type: "dataset"
    section: "experimental_setup"
  - text: "Synthetic Prompt"
    type: "dataset"
    section: "experimental_setup"
  - text: "DeepSeek-R1"
    type: "model"
    section: "experimental_setup"
  - text: "PELT"
    type: "algorithm"
    section: "methods"
  - text: "Multinomial Logistic Regression"
    type: "algorithm"
    section: "experimental_setup"
  - text: "Translation Lookaside Buffer"
    type: "hardware"
    section: "methods"
  - text: "differential privacy"
    type: "defense"
    section: "discussion"
  - text: "SSIM"
    type: "metric"
    section: "experimental_setup"
  - text: "FID"
    type: "metric"
    section: "experimental_setup"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "We propose MoEcho (MoE-Echo), Mixture- of-Experts Echoing , to exploit architectural side-channels that leak"
  - type: "first_in_area"
    stance: "asserts"
    section: "related_work"
    quote: "our MoEcho is the first of its kind for privacy evaluation via side-channel analysis"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "in MoEcho, we introduce four novel architectural side-channels on different computing platforms"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we explore a new attack surface for Mixture-of-Experts based transformers in modern efficient AI, MoEcho, which leaks the user's private inputs and outputs via the execution footprints of dynamic activation of experts"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "Our work focuses on user privacy and investigates various architectural side-channels that can leak MoE execution patterns"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "We report the Attack Success Rate (ASR)-the percentage of correctly predicted tokens-across all datasets, each of which achieves a high ASR (>90%)"
  - type: "reports_uncertainty"
    stance: "asserts"
    section: "methods"
    quote: "This block-sharing ambiguity introduces a 3.4% error rate in expert inference"
  - type: "challenges_existing"
    stance: "challenges"
    section: "methods"
    quote: "Existing SCAs of ML systems primarily compromise confidentiality, targeting model parameter extraction"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "incorporating expert load information leads to improved generation performance in visual quality"
  - type: "limitation"
    stance: "asserts"
    section: "future_work"
    quote: "This work primarily investigates SCA vulnerabilities with single- device deployments of MoE models"
  - type: "future_work"
    stance: "asserts"
    section: "future_work"
    quote: "we plan to extend MoEcho to analyze large-scale MoE models deployed across heterogeneous hardware platforms"
  - type: "future_work"
    stance: "asserts"
    section: "future_work"
    quote: "future work will focus on evaluating and adapting MoEcho to these newer designs"

numerical:
  - metric: "tlb_block_sharing_error"
    value: 0.034
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "This block-sharing ambiguity introduces a 3.4% error rate in expert inference"
  - metric: "expert_load_correlation_cpu"
    value: 0.9
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "channels (L1 and L2) achieves a load trace correlation of 0.9 with the ground truth"
  - metric: "expert_load_correlation_gpu"
    value: 0.993
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "yields a more accurate result with a correlation coefficient of 0.993"
  - metric: "experts_count_deepseekv2"
    value: 64
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "there are 64 experts available, but each token only activates 6 most suitable ones"
  - metric: "computational_cost_reduction"
    value: 0.85
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "reducing computational cost by 85% during inference while preserving performance"
  - metric: "celeba_one_shot_top1"
    value: 0.25
    dataset: "CelebA"
    split: null
    quote: "With a simple SVM classifier, the one-shot Top-1 accuracy is 25"
  - metric: "cache_occupancy_overhead"
    value: 0.012
    dataset: "MoE inference"
    split: null
    quote: "the cache occupancy channel incurs a 1.2% increase in the com"
  - metric: "tlb_evict_reload_overhead"
    value: 0.05
    dataset: "MoE inference"
    split: null
    quote: "the TLB Evict + Reload side-channel 5.0%"
  - metric: "pageout_reload_overhead"
    value: 0.044
    dataset: "MoE inference"
    split: null
    quote: "the Pageout + Reload side-channel 4.4%"
  - metric: "gpu_perfcounter_overhead"
    value: 0.079
    dataset: "MoE inference"
    split: null
    quote: "the GPU performance counter side-channel 7.9%"
  - metric: "router_topk_deepseekv2"
    value: 6
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "the router selects the top"
  - metric: "expert_layers_deepseekv2lite"
    value: 26
    dataset: "DeepSeek-V2 Lite"
    split: null
    quote: "for the DeepSeek-V2 Lite model with 26 layers"

citation_stance:
  - ref_key: "ref_3"
    stance: "background"
    quote: "DeepSeekMoE [3, 12], which offers open-sourced models in multiple versions to accommodate diverse tasks and efficient deployments"
  - ref_key: "ref_10"
    stance: "background"
    quote: "in DeepSeekMoE [3] for the DeepSeek- V2 Lite model [10], there are 64 experts available"
  - ref_key: "ref_18"
    stance: "contrasts"
    quote: "Existing SCAs of ML systems primarily compromise confidentiality, targeting model parameter extraction [18] or structure retrieval [56]"
  - ref_key: "ref_56"
    stance: "contrasts"
    quote: "targeting model parameter extraction [18] or structure retrieval [56]"
  - ref_key: "ref_59"
    stance: "extends"
    quote: "The side-channel is similar to the popular cache flush+reload side-channel [59] in terms of steps, while at different architectural levels"
  - ref_key: "ref_60"
    stance: "extends"
    quote: "modern MoE architectures are input-dependent [60]"
  - ref_key: "ref_53"
    stance: "contrasts"
    quote: "Wu et al.[53] exploit shared KV caches in multi-tenant LLM services to reconstruct users' inputs by leveraging timing differences of controlled queries"
  - ref_key: "ref_2"
    stance: "supports"
    quote: "balanced computation of LLM models [2] can effectively obscure the expert load"
  - ref_key: "ref_1"
    stance: "extends"
    quote: "incorporating techniques such as differential privacy (DP) [1, 8] can add ran- dom noise to the router decisions"
  - ref_key: "ref_62"
    stance: "extends"
    quote: "cording to [62], Nvidia GPUs implement a three-level TLB hierarchy"

quality_flags:
  self_constructed_ground_truth: true
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false
---

## Limitations and unexamined dimensions

- The threat model assumes the adversary co-locates with the victim on the same CPU core or shares a GPU with access to performance counters via Nsight, leaving cross-machine or strictly isolated tenancy unexamined.
- All end-to-end experiments run on a single hardware setup (AMD Ryzen Threadripper Pro with one NVIDIA A6000); no Intel, ARM, or alternative GPU vendor is evaluated.
- The Prompt Inference Attack on healthcare data relies on a synthetically generated dataset produced by DeepSeek-R1 from templates in Appendix D, with no validation against real patient records.
- The TLB Evict+Reload channel suffers a 3.4% error rate from block-sharing ambiguity and degrades RRA accuracy to 82.5%, but the paper does not propose a remedy.
- Robustness is tested only up to four competing workloads; behaviour under heavier multi-tenant contention or adversarial noise injection is not measured.
- Mitigations in Section 8.1 (randomised routing, differential privacy on the gating layer, expert distribution across devices) are discussed qualitatively without any empirical evaluation of their defensive effect.
