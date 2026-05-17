---
paper_id: "234"
title: "Leveraging Channel Knowledge Map for Multi-User Hierarchical Beam Training Under Position Uncertainty"
authors:
  - "Xu Shi"
  - "Haohan Wang"
  - "Yashuai Cao"
  - "Hengyu Zhang"
  - "Sufang Yang"
  - "Jintao Wang"
year: 2025
venue: "arXiv preprint arXiv:2511.22902"
pdf_path: "project/data/pdfs/paper_234.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "I. Introduction"
    para_count: 1
  - type: "background"
    heading: "A. Background"
    para_count: 3
  - type: "related_work"
    heading: "B. Related works"
    para_count: 3
  - type: "introduction"
    heading: "C. Contribution"
    para_count: 5
  - type: "other"
    heading: "D. Organization"
    para_count: 1
  - type: "methods"
    heading: "II. System Model"
    para_count: 2
  - type: "methods"
    heading: "A. Hierarchical beam training"
    para_count: 3
  - type: "methods"
    heading: "B. BeamCKM concept"
    para_count: 4
  - type: "methods"
    heading: "C. Position uncertainty modeling"
    para_count: 4
  - type: "methods"
    heading: "III. Single-user beam training design"
    para_count: 1
  - type: "methods"
    heading: "A. Reward-motivated beam-potential training"
    para_count: 6
  - type: "methods"
    heading: "B. Low-complexity two-layer lookahead scheme"
    para_count: 5
  - type: "discussion"
    heading: "C. Performance analysis"
    para_count: 2
  - type: "methods"
    heading: "IV. Multi-user beam training extension"
    para_count: 1
  - type: "methods"
    heading: "A. Multi-user training design"
    para_count: 6
  - type: "discussion"
    heading: "B. Performance analysis"
    para_count: 2
  - type: "results"
    heading: "V. Simulation results"
    para_count: 1
  - type: "experimental_setup"
    heading: "A. Scenario and Parameter Setting"
    para_count: 1
  - type: "results"
    heading: "B. Single-user Training"
    para_count: 3
  - type: "results"
    heading: "C. Multi-user Scenario"
    para_count: 3
  - type: "conclusion"
    heading: "VI. Conclusions"
    para_count: 1
  - type: "references"
    heading: "References"
    para_count: 1

entities:
  - text: "Channel Knowledge Map"
    type: "framework"
    section: "introduction"
  - text: "CKM"
    type: "framework"
    section: "introduction"
  - text: "BeamCKM"
    type: "method"
    section: "methods"
  - text: "hierarchical beam training"
    type: "technique"
    section: "background"
  - text: "binary search tree"
    type: "algorithm"
    section: "methods"
  - text: "reward-motivated beam-potential hierarchical training"
    type: "method"
    section: "methods"
  - text: "two-layer lookahead scheme"
    type: "method"
    section: "methods"
  - text: "correlation-driven position-pruning training scheme"
    type: "method"
    section: "methods"
  - text: "mmWave MIMO"
    type: "technique"
    section: "methods"
  - text: "uniform linear array"
    type: "hardware"
    section: "methods"
  - text: "ULA"
    type: "hardware"
    section: "methods"
  - text: "DFT matrix"
    type: "concept"
    section: "methods"
  - text: "AWGN"
    type: "concept"
    section: "methods"
  - text: "AoD"
    type: "metric"
    section: "methods"
  - text: "GPS"
    type: "system"
    section: "background"
  - text: "ISAC"
    type: "framework"
    section: "background"
  - text: "RIS"
    type: "technique"
    section: "related_work"
  - text: "UAV"
    type: "platform"
    section: "related_work"
  - text: "RadioNet"
    type: "model"
    section: "related_work"
  - text: "RadioUNet"
    type: "model"
    section: "related_work"
  - text: "RME-GAN"
    type: "model"
    section: "related_work"
  - text: "WiFi-Diffusion"
    type: "model"
    section: "related_work"
  - text: "Kalman-based fast tracking"
    type: "algorithm"
    section: "related_work"
  - text: "IEEE 802.11ad"
    type: "standard"
    section: "related_work"
  - text: "IEEE 802.15.3c"
    type: "standard"
    section: "related_work"
  - text: "cosine similarity"
    type: "metric"
    section: "methods"
  - text: "Sionna"
    type: "tool"
    section: "experimental_setup"
  - text: "Blender"
    type: "tool"
    section: "experimental_setup"
  - text: "ray tracing"
    type: "technique"
    section: "experimental_setup"
  - text: "spectral efficiency"
    type: "metric"
    section: "results"
  - text: "training overhead"
    type: "metric"
    section: "results"
  - text: "training gain"
    type: "metric"
    section: "results"
  - text: "CDF"
    type: "metric"
    section: "results"
  - text: "SNR"
    type: "metric"
    section: "results"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "Firstly, we propose the concept of beam potential based on CKM and correspondingly provide a reward-motivated beam-potential hierarchical training approach"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "Secondly, we present a low-complexity two-layer lookahead hierarchical training scheme to further reduce the"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "Thirdly, to address the incompatibility and high overhead of hierarchical beam training in multi-user scenarios, we design one correlation-motivated position-pruning hierarchical training scheme"
  - type: "framework"
    stance: "asserts"
    section: "introduction"
    quote: "we formulate the hierarchical searching process as one complete binary tree, which is pruned using CKM to form a subspace-based incomplete binary tree"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "a critical limitation in current literature is the rigid decoupling between CKM and real-time communication observations, where CKM-derived conclusions are usually adopted by treating CKMs as fixed, a priori, and error-free parameters"
  - type: "challenges_existing"
    stance: "challenges"
    section: "related_work"
    quote: "Existing studies are confined to the impact of either observations or prior information on beam training, while the inherent interplay and mechanism among the three components, i.e., prior information (from CKM), real-time observations, and training strategy, have not been satisfactorily addressed"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "The results clearly indicate that the performance of the proposed algorithms far surpasses that of other existing traditional methods, validating its superiority and practical application potential"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "at all SNR levels, the CKM-assisted algorithms achieve higher SE values close to the optimal perfect CSI curve"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "the proposed multi-user joint CKM-aided beam training method yields significantly stronger training gains"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "Compared with the hierarchical training with full complete training, the spectral efficiency can be significantly improved which proves that its beam training accuracy and beam gain are enhanced"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "As for the multi-user scenario, we only focus on the training performance such as the total overhead and training gain. This implies that subsequent beamforming optimization is no longer within the scope of the present study"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "in multi-user scenarios, there are occasional instances where the dominant beams of several users (randomly generated) coincide, and the further quantitative analysis of beam conflicts and inter-user interference is necessary"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "future work might extend the frameworks to dynamic user mobility or ultra-dense networks, as well as explore integrating reinforcement learning for real-time adaptive optimization of training strategies"
  - type: "reports_uncertainty"
    stance: "asserts"
    section: "results"
    quote: "The beam training process cycle is repeated 10,000 times, and average metric values are calculated to ensure the reliability"

numerical:
  - metric: "carrier_frequency_GHz"
    value: 80
    dataset: null
    split: null
    quote: "carrier frequency 80GHz"
  - metric: "num_BS_antennas"
    value: 128
    dataset: null
    split: null
    quote: "with 128-element ULA configuration"
  - metric: "num_users"
    value: 3
    dataset: null
    split: null
    quote: "K = 3 single-antenna users are located in their respective regions"
  - metric: "region_size_m"
    value: 256
    dataset: null
    split: null
    quote: "the whole region X × Y = 256m × 256m is uniformly quantized"
  - metric: "BS_location"
    value: 1
    dataset: null
    split: null
    quote: "The multi-antenna BS is deployed at the center, with 128-element ULA configuration"
  - metric: "hierarchical_layers"
    value: 7
    dataset: null
    split: null
    quote: "the total hierarchical layer is calculated as L = 7"
  - metric: "correlation_threshold"
    value: 0.9
    dataset: null
    split: null
    quote: "The correlation threshold of (30) is set as η = 0.9 for Alg. 3"
  - metric: "trials"
    value: 10000
    dataset: null
    split: null
    quote: "The beam training process cycle is repeated 10,000 times"
  - metric: "spectral_efficiency_gain"
    value: 0.30
    dataset: null
    split: null
    quote: "the proposed method can further improve the spectral efficiency by approximately 30%"
  - metric: "overhead_reduction"
    value: 0.20
    dataset: null
    split: null
    quote: "it translates to almost 20% reduction in overhead for single-user methods like Alg.1 and Alg.2 when CKM is integrated"
  - metric: "overhead_T_threshold"
    value: 35
    dataset: null
    split: null
    quote: "Almost 60% trials can achieve overhead levels within T = 35 for three users"
  - metric: "GPS_accuracy_m"
    value: 100
    dataset: null
    split: null
    quote: "in urban dense areas, blocked line-of-sight (LoS) due to high-rise buildings may restrict GPS accuracy to 50 ∼ 100 meters"
  - metric: "WiFi_fingerprinting_error_m"
    value: 30
    dataset: null
    split: null
    quote: "multipath interference in Wi-Fi fingerprinting (introducing 10 ∼ 30 meter errors) can reduce localization to discrete zones"
  - metric: "baseline_codewords"
    value: 14
    dataset: null
    split: null
    quote: "The baseline hierarchical search without CKM shows a significant drop in gain, where L = 7 layers should be searched sequentially via binary method, i.e., 14 codewords"

citation_stance:
  - ref_key: "ref_3"
    stance: "background"
    quote: "CKM acts as a promising enabler to provide additional cost-free spatial/channel prior information and support various critical modules of communication systems such as transceiver deployment, channel state information (CSI) acquisition and beamforming configurations [3]"
  - ref_key: "ref_7"
    stance: "background"
    quote: "The early study about CKM can be traced back to ray-tracing techniques [7] with huge computational complexity"
  - ref_key: "ref_8"
    stance: "extends"
    quote: "To characterize scattering functions by the presence of multiple objects in real-time, RadioNet [8] was firstly proposed with trained deep neural networks in accurate and computationally-efficient manner"
  - ref_key: "ref_19"
    stance: "extends"
    quote: "[19] decomposed the channel into several scalar equivalent channels based on orthogonal discrete Fourier transform (DFT) beamforming codebook, thereby enabling the unified construction of high-dimension CKMs"
  - ref_key: "ref_26"
    stance: "contrasts"
    quote: "Though [26] proposed a CKM-enhanced DL-based beam recommendation scheme, it lacks interpretability and strategic control, thus retaining a notable gap from practical deployment"
  - ref_key: "ref_27"
    stance: "background"
    quote: "In the IEEE 802.11ad and 802.15.3c standards [27], the sector level sweep, beam refinement protocol, and beam tracking mechanisms have been formally established"
  - ref_key: "ref_29"
    stance: "contrasts"
    quote: "Alg.1 outperforms traditional hierarchical beam training [29], [32] with lower overhead"
  - ref_key: "ref_32"
    stance: "contrasts"
    quote: "Alg.1 outperforms traditional hierarchical beam training [29], [32] with lower overhead"
  - ref_key: "ref_35"
    stance: "background"
    quote: "Furthermore, user motion was incorporated into state transition model and derived Kalman-based fast tracking in [35]"
  - ref_key: "ref_41"
    stance: "supports"
    quote: "in urban dense areas, blocked line-of-sight (LoS) due to high-rise buildings may restrict GPS accuracy to 50 ∼ 100 meters, confining the user to a few city blocks with probabilities weighted by commuting patterns [41]"

quality_flags:
  self_constructed_ground_truth: true
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false

descriptors:
  topics:
    - "channel_knowledge_map"
    - "beam_training"
    - "hierarchical_search"
    - "mmwave_communications"
    - "multi_user_mimo"
    - "position_uncertainty"
    - "6g"
  methods:
    - "reward_motivated_beam_potential_training"
    - "two_layer_lookahead"
    - "correlation_position_pruning"
    - "pruned_binary_search_tree"
    - "cosine_similarity_filtering"
  hardware:
    - "mmwave_base_station"
    - "uniform_linear_array_128_elements"
    - "single_antenna_user_equipment"
  deployment_contexts:
    - "urban_outdoor_downlink"
    - "6g_wireless"
  populations: []
  threat_models: []
  frameworks_cited:
    - "BeamCKM"
    - "ISAC"
    - "IEEE_802_11ad"
    - "IEEE_802_15_3c"

evaluation_quality:
  variance_reported: true
  confidence_intervals: false
  baseline_compared: true
  baselines_count: 1
  sample_size_main: 10000
  reruns: 10000
---

## Limitations and unexamined dimensions

- The multi-user analysis is limited to training overhead and training gain; subsequent beamforming optimization is explicitly placed outside the scope of the study.
- Beam conflicts and inter-user interference when dominant beams of several users coincide are flagged as needing further quantitative analysis but not measured here.
- All experiments use a single 256m by 256m ray-traced urban scene with a 128-element ULA at 80 GHz; no other carrier frequency, array size, or environment is tested.
- User mobility is not simulated; the paper states only static prior subregions and leaves dynamic user mobility to future work.
- The construction of BeamCKM is assumed pre-computed and stored at the BS, and the cost or accuracy of building the map is excluded from the evaluation.
- Only specular reflection and refraction are modelled in the channel; diffuse reflection is explicitly excluded from the Sionna ray-tracing setup.
