---
paper_id: "015"
title: "Security Performance Analysis during Side-Channel Attack Using Novel Cryptography Algorithm for VM Cloud"
authors:
  - "Gnanavel S"
  - "Godfrey Winster Sathianesan"
  - "Narayana K.E"
  - "Baburaj E"
  - "Arunachalam N"
  - "Valarmathi K"
year: 2023
venue: "Research Square (preprint)"
pdf_path: "project/data/pdfs/paper_015.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "1. INTRODUCTION"
    para_count: 7
  - type: "related_work"
    heading: "2. LITERATURE SURVEY"
    para_count: 19
  - type: "methods"
    heading: "3. MATERIALS AND METHODS"
    para_count: 4
  - type: "results"
    heading: "4. RESULT AND DISCUSSION"
    para_count: 10
  - type: "conclusion"
    heading: "5. CONCLUSION"
    para_count: 2
  - type: "acknowledgments"
    heading: "Declarations"
    para_count: 8
  - type: "references"
    heading: "References"
    para_count: 27

entities:
  - text: "Self-Adaptive Honey Encryption"
    type: "method"
    section: "abstract"
  - text: "SAHE"
    type: "method"
    section: "abstract"
  - text: "Distribution Transforming Encoder"
    type: "method"
    section: "methods"
  - text: "DTE"
    type: "method"
    section: "methods"
  - text: "Rule-Based Authentication"
    type: "method"
    section: "methods"
  - text: "Memetic Hyper-Heuristic"
    type: "method"
    section: "methods"
  - text: "Identity Based Linear Classification"
    type: "method"
    section: "methods"
  - text: "Hypervisor"
    type: "software"
    section: "methods"
  - text: "Virtual Machine"
    type: "platform"
    section: "introduction"
  - text: "Physical Machine"
    type: "hardware"
    section: "abstract"
  - text: "Side-Channel Attack"
    type: "attack"
    section: "introduction"
  - text: "Sliding Window SCA"
    type: "attack"
    section: "related_work"
  - text: "SW-SCA"
    type: "attack"
    section: "related_work"
  - text: "DDoS"
    type: "attack"
    section: "related_work"
  - text: "SecSDN-Cloud"
    type: "system"
    section: "results"
  - text: "DTW"
    type: "method"
    section: "results"
  - text: "Python"
    type: "software"
    section: "results"
  - text: "Anaconda"
    type: "tool"
    section: "results"
  - text: "Intel core 5"
    type: "hardware"
    section: "results"
  - text: "CloudSim"
    type: "tool"
    section: "related_work"
  - text: "HES-ACO"
    type: "method"
    section: "related_work"
  - text: "RSA"
    type: "method"
    section: "related_work"
  - text: "SDN"
    type: "framework"
    section: "related_work"
  - text: "SBLDE"
    type: "method"
    section: "related_work"
  - text: "PRF"
    type: "method"
    section: "methods"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "abstract"
    quote: "We propose a novel rule-based authentication with the swam optimization method for shifting the resource from an optimized VM into a physical machine"
  - type: "contribution"
    stance: "asserts"
    section: "abstract"
    quote: "A Self-Adaptive Honey Encryption (SAHE) method for stronger multi-level authentication in a cloud environment"
  - type: "method"
    stance: "asserts"
    section: "abstract"
    quote: "A rule- based mechanism to detect a side-channel attack by monitoring cache data access"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "the proposed Self- Adaptive Honey Encryption (SAHE) can withstand a 60% higher saturation time than the existing algorithms"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "The proposed Self-Adaptive Honey Encryption (SAHE) contains a defence against harmful attacks"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "the proposed method has a low decryption cost. From the above analysis, the proposed method seems more practical than the rest of the table"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "the Self-Adaptive Honey Encryption (SAHE)) proposed algorithm play a major role compared with existing algorithms the main reason for the improvement in the throughput is defense attack"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "Therefore, an asymmetric encryption system is less vulnerable to the desired impact of security-based key management"
  - type: "limitation"
    stance: "asserts"
    section: "conclusion"
    quote: "it may not submit the computing resources required to perform continuous"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "proposed algorithm extension technology has been further explored"
  - type: "framework"
    stance: "asserts"
    section: "methods"
    quote: "Self-adaptive honey encryption is effectively supplied, but fake plaintext is generated for each incorrect key that is used by an intruder to decrypt a message"

numerical:
  - metric: "saturation_time_improvement"
    value: 0.60
    dataset: null
    split: null
    quote: "the proposed Self- Adaptive Honey Encryption (SAHE) can withstand a 60% higher saturation time than the existing algorithms"
  - metric: "buffer_saturation_accuracy"
    value: 0.82
    dataset: "simulation_10"
    split: null
    quote: "10                     82                  72                68"
  - metric: "network_throughput"
    value: 0.90
    dataset: "simulation_10"
    split: null
    quote: "10                     90                 86                 74"
  - metric: "packet_loss"
    value: 0.20
    dataset: "simulation_10"
    split: null
    quote: "10                     20                  32                40"
  - metric: "performance_analysis"
    value: 0.72
    dataset: "simulation_10"
    split: null
    quote: "10                     72                  66                  60                  10"
  - metric: "time_consumption"
    value: 0.62
    dataset: "simulation_10"
    split: null
    quote: "10                     62                  58                  52                  10"
  - metric: "average_security"
    value: 0.937
    dataset: "VM_cloud_server"
    split: null
    quote: "It provides 93.7% average security, 2.4 seconds of response time, and 91.3% attack detection on the VM cloud server"
  - metric: "attack_detection"
    value: 0.913
    dataset: "VM_cloud_server"
    split: null
    quote: "91.3% attack detection on the VM cloud server"
  - metric: "response_time_seconds"
    value: 2.4
    dataset: "VM_cloud_server"
    split: null
    quote: "2.4 seconds of response time"

citation_stance:
  - ref_key: "ref_1"
    stance: "background"
    quote: "N. Juma et al. (2018) suggest that scheduling at the cost of security has shown that it is possible to minimize the effective information leakage via side channels during Virtual Machine (VM) co-existence in the cloud"
  - ref_key: "ref_2"
    stance: "contrasts"
    quote: "L. Zhang et al. (2020) proposed a lattice-based trapdoor extension, which will be used to reach the maximum leakage rate. In addition, it can protect the privacy of the receiver once anonymity has been achieved. However, data security and privacy protection are two security concerns brought on by its dynamic nature and openness"
  - ref_key: "ref_3"
    stance: "contrasts"
    quote: "H. Abdulqadder et al. (2018) develop the new digital signature of the secure hash with chaotic, which has been used for user authentication. These schemes can protect the user's privacy and anonymity based on the realization of the selected access policy model. However, SDN's centralized control plane design will be exposed to the danger of damaging security threats"
  - ref_key: "ref_4"
    stance: "background"
    quote: "M. Tang et al. (2018) present Sliding Window SCA (SW-SCA), a new independent method of encryption in which the source code used for encryption requires a trigger signal or changing"
  - ref_key: "ref_6"
    stance: "contrasts"
    quote: "Y. Han et al. (2017) focused on each threat, such as malicious users who construct side channels in the coexistence attack and extract personal information from the virtual machine to be placed in the same location on the same server. However, due to changes to the current cloud platform, these are not suitable for immediate deployment"
  - ref_key: "ref_15"
    stance: "contrasts"
    quote: "Q. Yan et al. (2016) explain the characteristics of cloud computing in distributed denial of service (DDoS) attacks to provide a defense mechanism for a comprehensive investigation against DDoS attacks using a Software Defined Network (SDN). These works can assist in understanding and utilizing SDN to DDoS attacks in cloud computing. However, SDN own security issues need to be resolved"
  - ref_key: "ref_20"
    stance: "contrasts"
    quote: "M. Chakraborty et al. (2018) explain the use of cloud security in elliptic curve cryptography algorithm and proposed minimum power and cloud computing; there is no better security model for public-key encryption system, such as Rivest–Shamir–Adleman (RSA) encryption. However, it requires a high cloud platform reliable with a fairly powerful enhanced security algorithm"
  - ref_key: "ref_26"
    stance: "extends"
    quote: "Gnanavel et al. (2022) proposed SBLDE with a linear classification algorithm for identifying and preventing cross-VM side-channel attacks on cloud servers"
  - ref_key: "ref_27"
    stance: "background"
    quote: "Compared to HESGA, HPSOGA, AC-PSO, and PSO-COGENT algorithms, the created HES-ACO algorithm was simulated at CloudSim and found to optimize all parameters"

quality_flags:
  self_constructed_ground_truth: true
  comparison_table_only: false
  hobby_project_scale: true
  predictable_outcome: true

descriptors:
  topics:
    - cache_side_channel
    - cloud_vm_security
    - honey_encryption
  methods:
    - self_adaptive_honey_encryption
    - distribution_transforming_encoder
    - rule_based_authentication
    - memetic_hyper_heuristic
    - swarm_optimization
    - identity_based_linear_classification
  hardware:
    - intel_core_i5
  deployment_contexts:
    - multi_tenant_cloud
    - simulated_vm
  populations:
    - co_resident_vms
  threat_models:
    - co_resident_attacker
    - cross_vm_side_channel
  frameworks_cited:
    - honey_encryption
    - software_defined_network

evaluation_quality:
  variance_reported: false
  confidence_intervals: false
  baseline_compared: true
  baselines_count: 2
  sample_size_main: 40
  reruns: 0
---

## Limitations and unexamined dimensions

- The six comparison tables sweep data sizes from 10 to 40 and report single point values, with no standard deviation, confidence interval, or repeated-run statistic.
- The rule-based detector is claimed to spot cache side-channel attacks, yet the evaluation never instantiates a concrete Flush+Reload, Prime+Probe, or Spectre workload against it.
- All experiments run on one Intel core 5 machine inside Anaconda Python; no AMD, ARM, or production hypervisor (Xen, KVM, VMware) is exercised.
- Baseline coverage is limited to DTW and SecSDN-Cloud, leaving standard side-channel defences such as cache partitioning, page colouring, and constant-time cryptography untested.
- The Distribution Transforming Encoder is illustrated on an eight-airport-code message space and a three-character password, so realistic key sizes and ciphertext lengths remain unverified.
- No code, simulation script, or dataset is released, and the authors note that the scheme "may not submit the computing resources required to perform continuous" operation.
