---
paper_id: "293"
title: "Revolutionary hybrid ensembled deep learning model for accurate and robust side-channel attack detection in cloud computing"
authors:
  - "C. Lakshminatha Reddy"
  - "K. Malathi"
year: 2025
venue: "Scientific Reports"
pdf_path: "project/data/pdfs/paper_293.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "Introduction"
    para_count: 6
  - type: "related_work"
    heading: "Related work"
    para_count: 10
  - type: "methods"
    heading: "Methodology"
    para_count: 1
  - type: "background"
    heading: "AES side-channel attack dataset (ASCAD)"
    para_count: 1
  - type: "methods"
    heading: "Preprocessing"
    para_count: 8
  - type: "methods"
    heading: "Dimensionality reduction"
    para_count: 3
  - type: "methods"
    heading: "Feature extraction"
    para_count: 8
  - type: "methods"
    heading: "Data augmentation"
    para_count: 2
  - type: "methods"
    heading: "Splitting data"
    para_count: 1
  - type: "methods"
    heading: "Hybrid ensembled deep learning model (HEDL)"
    para_count: 9
  - type: "methods"
    heading: "Hyperparameter optimization"
    para_count: 1
  - type: "methods"
    heading: "Complexity analysis of the proposed HEDL model"
    para_count: 1
  - type: "results"
    heading: "Results and discussions"
    para_count: 14
  - type: "discussion"
    heading: "Model interpretability"
    para_count: 4
  - type: "conclusion"
    heading: "Conclusion and future work"
    para_count: 1
  - type: "other"
    heading: "Data availability"
    para_count: 1
  - type: "references"
    heading: "References"
    para_count: 45

entities:
  - text: "HEDL"
    type: "model"
    section: "introduction"
  - text: "CNN"
    type: "model"
    section: "introduction"
  - text: "LSTM"
    type: "model"
    section: "introduction"
  - text: "AutoEncoder"
    type: "model"
    section: "introduction"
  - text: "ASCAD"
    type: "dataset"
    section: "methods"
  - text: "AES"
    type: "algorithm"
    section: "background"
  - text: "Side-channel attack"
    type: "attack"
    section: "introduction"
  - text: "Cache-timing attack"
    type: "attack"
    section: "introduction"
  - text: "Cross-VM attack"
    type: "attack"
    section: "introduction"
  - text: "Power analysis attack"
    type: "attack"
    section: "introduction"
  - text: "Timing attack"
    type: "attack"
    section: "introduction"
  - text: "Electromagnetic emanation attack"
    type: "attack"
    section: "introduction"
  - text: "KNN imputation"
    type: "method"
    section: "methods"
  - text: "Dynamic Time Warping"
    type: "method"
    section: "methods"
  - text: "Z-score normalization"
    type: "method"
    section: "methods"
  - text: "Savitzky-Golay smoothing"
    type: "method"
    section: "methods"
  - text: "Wavelet transformation"
    type: "method"
    section: "methods"
  - text: "Attention mechanism"
    type: "method"
    section: "methods"
  - text: "AdamW"
    type: "method"
    section: "methods"
  - text: "ReLU"
    type: "method"
    section: "methods"
  - text: "Softmax"
    type: "method"
    section: "methods"
  - text: "Dot-product attention"
    type: "method"
    section: "methods"
  - text: "TensorFlow"
    type: "library"
    section: "results"
  - text: "Keras"
    type: "library"
    section: "results"
  - text: "Python"
    type: "library"
    section: "results"
  - text: "Intel Core Ultra 9 Processor 185H"
    type: "hardware"
    section: "results"
  - text: "Atmel ATMega8515 microcontroller"
    type: "hardware"
    section: "background"
  - text: "Support Vector Machine"
    type: "algorithm"
    section: "results"
  - text: "Random Forest"
    type: "algorithm"
    section: "results"
  - text: "Gradient Boosting"
    type: "algorithm"
    section: "results"
  - text: "XGBoost"
    type: "algorithm"
    section: "results"
  - text: "LightGBM"
    type: "algorithm"
    section: "results"
  - text: "Hybrid CNN-LSTM"
    type: "model"
    section: "results"
  - text: "Accuracy"
    type: "metric"
    section: "results"
  - text: "Precision"
    type: "metric"
    section: "results"
  - text: "Recall"
    type: "metric"
    section: "results"
  - text: "F1-score"
    type: "metric"
    section: "results"
  - text: "AUC"
    type: "metric"
    section: "results"
  - text: "Cloud computing"
    type: "platform"
    section: "introduction"
  - text: "Virtual Machine"
    type: "concept"
    section: "introduction"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "We propose a hybrid ensembled deep learning (HEDL) model that integrates convolutional neural networks (CNN), long short-term memory (LSTM) networks, and AutoEncoders, enhanced by an attention mechanism to focus on the most critical data segments"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "The novelty of this work lies in the development of a HEDL that ingeniously integrates the strengths of multiple deep learning architectures"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "The HEDL model achieved a detection accuracy of 98.65%, significantly outperforming traditional machine learning and standalone deep learning models in both clean and noisy data conditions"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "HEDL proposed with the accuracy of 98.65%, which prove it is better than other deep learning techniques in identifying the unique patterns within side-channel attack data sets"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "The proposed HEDL Model with a training time 5 h is the most computationally expensive"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "The Proposed HEDL Model outperforms all the x models with the test set accuracy of 98.65%"
  - type: "reports_uncertainty"
    stance: "validates"
    section: "results"
    quote: "validating the model's suitability in real-world cloud computing settings for SCA detection"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "Preliminary tests show robustness to obfuscation; further improvements possible with targeted adversarial training"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "The Proposed HEDL Model with a training time 5 h is the most computationally expensive"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "Future work will explore the adaptation of the HEDL model to other SCA types, such as timing and electromagnetic attacks, to broaden its applicability in cryptographic security"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "incorporating federated learning could enhance model scalability and privacy by enabling distributed, secure training without data centralization"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "future experiments should focus on testing the model across a variety of datasets, particularly those from different contexts and environments"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "Current models either designed to identify specific types of SCAs or lack scalability and transferability across various datasets and threats"

numerical:
  - metric: "accuracy"
    value: 0.9865
    dataset: "ASCAD"
    split: "test"
    quote: "The HEDL model achieved a detection accuracy of 98.65%"
  - metric: "accuracy"
    value: 0.8812
    dataset: "ASCAD"
    split: "test"
    quote: "with accuracies of 88.12% and 90.54%, respectively"
  - metric: "accuracy"
    value: 0.9054
    dataset: "ASCAD"
    split: "test"
    quote: "with accuracies of 88.12% and 90.54%, respectively"
  - metric: "accuracy"
    value: 0.8523
    dataset: "ASCAD"
    split: "test"
    quote: "AutoEncoder have an accuracy of 87.34% and 85.23%"
  - metric: "accuracy"
    value: 0.8245
    dataset: "ASCAD"
    split: "test"
    quote: "its accuracy recorded the level of 82.45%"
  - metric: "accuracy"
    value: 0.9622
    dataset: "ASCAD"
    split: "test"
    quote: "The Hybrid CNN-LSTM model significantly improves upon these, with an accuracy of 96.22%"
  - metric: "accuracy"
    value: 0.921
    dataset: "ASCAD"
    split: "test"
    quote: "LightGBM, with an accuracy of 92.1%, outperforms these models"
  - metric: "precision"
    value: 0.9812
    dataset: "ASCAD"
    split: "test"
    quote: "98.12%, 98.23%, and 98.17% respectively"
  - metric: "recall"
    value: 0.9823
    dataset: "ASCAD"
    split: "test"
    quote: "values obtained of 98.12%, 98.23%, and 98.17%"
  - metric: "f1"
    value: 0.9817
    dataset: "ASCAD"
    split: "test"
    quote: "score values obtained of 98.12%, 98.23%, and 98.17%"
  - metric: "auc"
    value: 0.992
    dataset: "ASCAD"
    split: "test"
    quote: "the best model is the Proposed HEDL Model with the evaluation measure AUC equals to 0.992"
  - metric: "accuracy_noisy"
    value: 0.9589
    dataset: "ASCAD"
    split: "test"
    quote: "the Proposed HEDL Model is far superior to the rest at a staggeringly high accuracy rate of 95.89% even under noisy conditions"
  - metric: "training_time_hours"
    value: 5
    dataset: "ASCAD"
    split: null
    quote: "The Proposed HEDL Model with a training time 5 h is the most computationally expensive"
  - metric: "true_positives"
    value: 2435
    dataset: "ASCAD"
    split: "test"
    quote: "the actual instance of attacks rightly classified as attacks, totaling 2435"
  - metric: "true_negatives"
    value: 2530
    dataset: "ASCAD"
    split: "test"
    quote: "the actual normal activity rightly classified as normal, totaling 2530"
  - metric: "false_positives"
    value: 25
    dataset: "ASCAD"
    split: "test"
    quote: "It misclassified 25 normal instances as attacks"
  - metric: "false_negatives"
    value: 20
    dataset: "ASCAD"
    split: "test"
    quote: "though it classified only 20 attack instances as normal"
  - metric: "memory_gb"
    value: 2.5
    dataset: "ASCAD"
    split: null
    quote: "memory usage (2.5 GB), and latency (80 ms)"
  - metric: "latency_ms"
    value: 80
    dataset: "ASCAD"
    split: null
    quote: "memory usage (2.5 GB), and latency (80 ms)"
  - metric: "gflops"
    value: 3.2
    dataset: "ASCAD"
    split: null
    quote: "the highest computational cost (3.2 GFLOPs)"
  - metric: "train_split"
    value: 0.80
    dataset: "ASCAD"
    split: "train"
    quote: "80% of the data placed in the training set"
  - metric: "learning_rate"
    value: 0.001
    dataset: "ASCAD"
    split: null
    quote: "This work set learning rate to 0.001 based on fine-tuning experiments"
  - metric: "batch_size"
    value: 64
    dataset: "ASCAD"
    split: null
    quote: "Batch size of 64 used"
  - metric: "lstm_hidden_units"
    value: 128
    dataset: "ASCAD"
    split: null
    quote: "An LSTM layer, which utilized with the 128 hidden units"
  - metric: "dropout"
    value: 0.2
    dataset: "ASCAD"
    split: null
    quote: "An operational dropout rate of 0.2 used at the LSTM layer"

citation_stance:
  - ref_key: "ref_2"
    stance: "background"
    quote: "A data deduplication scheme presented against an untrusted cloud to counteract two types of side-channel attack, including probe attack and key-cache attack"
  - ref_key: "ref_25"
    stance: "background"
    quote: "It is one of the few bottleneck technologies of cloud storage service, and it enables cloud servers to delete one of each file copy"
  - ref_key: "ref_26"
    stance: "background"
    quote: "In order to deploy a defense against this type of attack, k-anonymity privacy concept deployed to propose secure threshold deduplication protocols"
  - ref_key: "ref_27"
    stance: "background"
    quote: "A concept of integrating all three approaches to afford required protection for virtualized systems to share is supported"
  - ref_key: "ref_29"
    stance: "contrasts"
    quote: "the experiments shows that the accuracy of the DNN model is 80.09% and therefore the proposed framework can identify side-channel attacks"
  - ref_key: "ref_30"
    stance: "extends"
    quote: "Similarly, this research seeks to meet such a need to improve data privacy in the information entered through smartphone keyboards, protect it from side-channel attacks through accuracy of 98.26%"
  - ref_key: "ref_31"
    stance: "background"
    quote: "An IoT network for detecting attacks using side-channel techniques that observes the power consumption of the devices proposed"
  - ref_key: "ref_34"
    stance: "background"
    quote: "The XSRU-IoMT model incorporated the principles of explainability of AI (XAI) for secure IoMT networks"
  - ref_key: "ref_35"
    stance: "supports"
    quote: "The AES Side-Channel Attack Dataset (ASCAD) is a rather large dataset that is popular among the researchers in the field of side-channel attacks"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false

descriptors:
  topics:
    - side_channel_attack_detection
    - cloud_security
    - power_trace_analysis
  methods:
    - cnn
    - lstm
    - autoencoder
    - attention_mechanism
    - weighted_ensemble
    - dynamic_time_warping
    - savitzky_golay_smoothing
    - z_score_normalization
    - knn_imputation
  hardware:
    - intel_core_ultra_9_185h
    - atmel_atmega8515
  deployment_contexts:
    - cloud_computing
    - multi_tenant_environments
  populations:
    - ascad_power_traces
  threat_models:
    - cross_vm_attacker_on_shared_physical_host
    - power_side_channel_observer
  frameworks_cited:
    - tensorflow
    - keras

evaluation_quality:
  variance_reported: false
  confidence_intervals: false
  baseline_compared: true
  baselines_count: 10
  sample_size_main: 5010
  reruns: 0
---

## Limitations and unexamined dimensions

- Evaluation is restricted to the single ASCAD power-trace dataset captured on an 8-bit Atmel microcontroller, so generalization to other hardware, cryptographic primitives, or trace acquisition setups is not measured.
- All reported metrics are single point values from one 80/10/10 split with no cross-validation, variance, or confidence intervals around the headline 98.65% accuracy.
- The threat model covers only AES power side channels; the authors flag timing and electromagnetic attacks as out of scope and defer them to future work.
- Cloud deployment is described qualitatively but the paper provides no multi-tenant, cross-VM, or live cloud experiment; the "cloud" claim is supported only by latency and memory measurements on a single workstation.
- Robustness to adversarial inputs is acknowledged as preliminary, with the authors noting that targeted adversarial training is needed to harden the model against intentional obfuscation.
- Hyperparameter choices such as learning rate 0.001, batch size 64, LSTM 128 hidden units, and dropout 0.2 are reported as fixed values with no sensitivity analysis or search procedure documented.
