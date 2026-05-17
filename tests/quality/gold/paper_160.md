---
paper_id: "160"
title: "I3 Retriever: Incorporating Implicit Interaction in Pre-trained Language Models for Passage Retrieval"
authors:
  - "Qian Dong"
  - "Yiding Liu"
  - "Qingyao Ai"
  - "Haitao Li"
  - "Shuaiqiang Wang"
  - "Yiqun Liu"
  - "Dawei Yin"
  - "Shaoping Ma"
year: 2023
venue: "Proceedings of the 32nd ACM International Conference on Information and Knowledge Management (CIKM '23)"
pdf_path: "project/data/pdfs/paper_160.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "ABSTRACT"
    para_count: 1
  - type: "introduction"
    heading: "1 INTRODUCTION"
    para_count: 5
  - type: "related_work"
    heading: "2 RELATED WORK"
    para_count: 1
  - type: "related_work"
    heading: "2.1 Conventional Neural IR Models"
    para_count: 2
  - type: "related_work"
    heading: "2.2 PLM-based IR models"
    para_count: 2
  - type: "related_work"
    heading: "2.3 Query Generation for IR"
    para_count: 1
  - type: "background"
    heading: "3 PRELIMINARIES"
    para_count: 1
  - type: "background"
    heading: "3.1 Problem Definition"
    para_count: 2
  - type: "background"
    heading: "3.2 PLM-based Retriever and Reranker"
    para_count: 5
  - type: "methods"
    heading: "4 METHOD"
    para_count: 1
  - type: "methods"
    heading: "4.1 Overall Architecture"
    para_count: 6
  - type: "methods"
    heading: "4.2 Incorporating Implicit Interaction"
    para_count: 4
  - type: "methods"
    heading: "4.3 Model Optimization"
    para_count: 3
  - type: "methods"
    heading: "4.4 Model Inference"
    para_count: 3
  - type: "experimental_setup"
    heading: "5 EXPERIMENTAL SETUP"
    para_count: 1
  - type: "experimental_setup"
    heading: "5.1 Datasets"
    para_count: 1
  - type: "experimental_setup"
    heading: "5.2 Baselines"
    para_count: 3
  - type: "experimental_setup"
    heading: "5.3 Implementation Details"
    para_count: 3
  - type: "results"
    heading: "6 EXPERIMENTAL RESULTS"
    para_count: 1
  - type: "results"
    heading: "6.1 Overall Comparison"
    para_count: 6
  - type: "results"
    heading: "6.2 Investigation on Implicit Interaction"
    para_count: 2
  - type: "results"
    heading: "6.3 Case Study on Query Reconstruction"
    para_count: 2
  - type: "conclusion"
    heading: "7 CONCLUSION"
    para_count: 1
  - type: "acknowledgments"
    heading: "ACKNOWLEDGMENTS"
    para_count: 1
  - type: "references"
    heading: "REFERENCES"
    para_count: 1

entities:
  - text: "I3 retriever"
    type: "method"
    section: "introduction"
  - text: "MSMARCO"
    type: "dataset"
    section: "experimental_setup"
  - text: "TREC DL 19"
    type: "dataset"
    section: "experimental_setup"
  - text: "MSMARCO-DEV"
    type: "dataset"
    section: "experimental_setup"
  - text: "BM25"
    type: "method"
    section: "experimental_setup"
  - text: "DeepCT"
    type: "method"
    section: "experimental_setup"
  - text: "DPR"
    type: "method"
    section: "related_work"
  - text: "ANCE"
    type: "method"
    section: "related_work"
  - text: "ColBERT"
    type: "method"
    section: "related_work"
  - text: "COIL"
    type: "method"
    section: "related_work"
  - text: "ME-BERT"
    type: "method"
    section: "related_work"
  - text: "DCE"
    type: "method"
    section: "experimental_setup"
  - text: "DRPQ"
    type: "method"
    section: "experimental_setup"
  - text: "coCondenser"
    type: "method"
    section: "experimental_setup"
  - text: "SimLM"
    type: "method"
    section: "experimental_setup"
  - text: "Cot-MAE"
    type: "method"
    section: "experimental_setup"
  - text: "RetroMAE"
    type: "method"
    section: "experimental_setup"
  - text: "TAS-B"
    type: "method"
    section: "experimental_setup"
  - text: "SPLADEv2"
    type: "method"
    section: "experimental_setup"
  - text: "RocketQAv2"
    type: "method"
    section: "experimental_setup"
  - text: "ColBERTv2"
    type: "method"
    section: "experimental_setup"
  - text: "ERNIE-Search"
    type: "method"
    section: "experimental_setup"
  - text: "monoBERT"
    type: "method"
    section: "related_work"
  - text: "duoBERT"
    type: "method"
    section: "related_work"
  - text: "KERM"
    type: "method"
    section: "related_work"
  - text: "UED"
    type: "method"
    section: "related_work"
  - text: "doc2query"
    type: "method"
    section: "related_work"
  - text: "docT5query"
    type: "method"
    section: "related_work"
  - text: "BERT"
    type: "model"
    section: "related_work"
  - text: "RoBERTa"
    type: "model"
    section: "related_work"
  - text: "Flan-T5-XL"
    type: "model"
    section: "experimental_setup"
  - text: "BERTbase"
    type: "model"
    section: "experimental_setup"
  - text: "BERTdistill"
    type: "model"
    section: "experimental_setup"
  - text: "PyTorch"
    type: "library"
    section: "experimental_setup"
  - text: "Huggingface"
    type: "library"
    section: "experimental_setup"
  - text: "NVIDIA Tesla A100"
    type: "hardware"
    section: "experimental_setup"
  - text: "Lamb optimizer"
    type: "method"
    section: "experimental_setup"
  - text: "MRR@10"
    type: "metric"
    section: "results"
  - text: "Recall@1000"
    type: "metric"
    section: "results"
  - text: "NDCG@10"
    type: "metric"
    section: "results"
  - text: "MIPS"
    type: "technique"
    section: "methods"
  - text: "query reconstructor"
    type: "method"
    section: "methods"
  - text: "query-passage interactor"
    type: "method"
    section: "methods"
  - text: "contrastive loss"
    type: "method"
    section: "methods"
  - text: "Kullback-Leibler divergence loss"
    type: "method"
    section: "experimental_setup"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "incorporates implicit interaction in dual-encoders"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "We propose a novel PLM-based retrieval model, namely I 3 re- triever, which incorporates implicit interaction in dual-encoders"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "we introduce a lightweight generative module, i.e., the query reconstructor, which is jointly trained with the retrieval backbone in an end-to-end manner"
  - type: "first_in_area"
    stance: "asserts"
    section: "related_work"
    quote: "To the best of our knowledge, this is the first attempt to introduce a generative module as a backbone in a retriever"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "I 3 retriever 1 outperforms DPR by a large margin, while main- taining the same inference speed. This proves that the im- plicit interaction is beneficial for encoding relevance infor- mation in the final passage representation"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "By combining implicit interaction, pre-training and distil- lation, I 3 retriever 4 is able to achieve the state-of-the-art performance on both datasets and across all metrics"
  - type: "baseline_comparison"
    stance: "asserts"
    section: "results"
    quote: "Compared with COIL and ColBERT, our I 3 retriever 1 method is more efficient, and can achieve comparable performance w.r.t. Re- call@1000 on MARCO DEV Passage, and better performance w.r.t. NDCG@10 on TREC DL 19"
  - type: "releases_code"
    stance: "asserts"
    section: "abstract"
    quote: "The codes are available at https://github.com/Deriq-Qian-Dong/III-Retriever"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "the concern of efficiency and space footprint is still an important fac- tor that limits the application of interaction-based neural retrieval models"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "the proposed implicit interaction is compatible with special pretraining and distillation to achieve a better performance"
  - type: "limitation"
    stance: "asserts"
    section: "methods"
    quote: "the actual queries issued by users are agnostic during the pre-computation, while we can only access to the passages in the corpus"

numerical:
  - metric: "mrr_at_10"
    value: 0.366
    dataset: "MSMARCO-DEV"
    split: "val"
    quote: "retriever 2 ✓ ✓ Implicit-early .366 .976 .727"
  - metric: "recall_at_1000"
    value: 0.976
    dataset: "MSMARCO-DEV"
    split: "val"
    quote: "Implicit-early .366 .976 .727"
  - metric: "ndcg_at_10"
    value: 0.727
    dataset: "TREC DL 19"
    split: "test"
    quote: ".366 .976 .727"
  - metric: "mrr_at_10"
    value: 0.403
    dataset: "MSMARCO-DEV"
    split: "val"
    quote: "retriever 3 ✓ ✓ Implicit-early .403 .987 .729"
  - metric: "ndcg_at_10"
    value: 0.729
    dataset: "TREC DL 19"
    split: "test"
    quote: ".403 .987 .729"
  - metric: "mrr_at_10"
    value: 0.418
    dataset: "MSMARCO-DEV"
    split: "val"
    quote: "retriever 4 ✓ ✓ Implicit-early .418 .988 .731"
  - metric: "recall_at_1000"
    value: 0.988
    dataset: "MSMARCO-DEV"
    split: "val"
    quote: "Implicit-early .418 .988 .731"
  - metric: "ndcg_at_10"
    value: 0.731
    dataset: "TREC DL 19"
    split: "test"
    quote: ".418 .988 .731"
  - metric: "corpus_size"
    value: 8800000
    dataset: "MSMARCO-Passage"
    split: null
    quote: "It consists of around 8.8 million passages"
  - metric: "train_queries"
    value: 502939
    dataset: "MSMARCO-TRAIN"
    split: "train"
    quote: "MSMARCO- TRAIN query set including 502,939 queries"
  - metric: "dev_queries"
    value: 6980
    dataset: "MSMARCO-DEV"
    split: "val"
    quote: "MSMARCO-DEV [39] includes 6,980 sparsely-judged queries"
  - metric: "trec_queries"
    value: 43
    dataset: "TREC DL 19"
    split: "test"
    quote: "TREC DL 19 [5] contains 43 densely-judged queries"
  - metric: "inference_latency_ms"
    value: 18
    dataset: "1k candidates"
    split: null
    quote: "I 3 retriever 18ms 22ms 62.2ms 25.6"
  - metric: "storage_gib"
    value: 25.6
    dataset: "MSMARCO-Passage"
    split: null
    quote: "62.2ms 25.6"
  - metric: "learning_rate"
    value: 0.00002
    dataset: null
    split: null
    quote: "we use the Lamb optimizer [66] with a learning rate of 2e-5"
  - metric: "batch_size"
    value: 16
    dataset: null
    split: null
    quote: "The model is trained with a batch size of 16"
  - metric: "pseudo_query_length"
    value: 32
    dataset: null
    split: null
    quote: "We configure the length of generated query"
  - metric: "pretraining_steps"
    value: 20000
    dataset: "MSMARCO-Passage"
    split: null
    quote: "undergoes optimization for 20K steps on passage collection"
  - metric: "mrr_at_10_improvement_set1"
    value: 0.219
    dataset: "MSMARCO-DEV Set 1"
    split: "val"
    quote: "I 3 retriever 2 .366 7.0 .372 6.9 .245 21.9"

citation_stance:
  - ref_key: "ref_24"
    stance: "extends"
    quote: "DPR [24] is the first to leverage PLM for the task of semantic retrieval, while extensive methods are subsequently proposed to improve the effectiveness"
  - ref_key: "ref_25"
    stance: "contrasts"
    quote: "ColBERT [25], COIL [16] and ME-BERT [35] are three representative studies that explicitly model the interactions after query/passage encodings"
  - ref_key: "ref_63"
    stance: "supports"
    quote: "ANCE [63] proposes to a hard negative sampling technique that greatly improve the effectiveness"
  - ref_key: "ref_40"
    stance: "background"
    quote: "monoBERT [40] is the first work that re-purpose BERT as a reranker"
  - ref_key: "ref_42"
    stance: "background"
    quote: "duoBERT [42] integrates monoBERT in a multistage rank- ing pipeline and further adopts a pairwise classification framework for the final re-ranking"
  - ref_key: "ref_10"
    stance: "background"
    quote: "KERM [10] leverages external knowledge graph to more accurately model the interaction between query and passage, and thus achieves the state-of-the-art results"
  - ref_key: "ref_43"
    stance: "background"
    quote: "doc2query [43], proposes a sequence-to- sequence model trained on relevant query-passage pairs to generate multiple queries for each passage"
  - ref_key: "ref_41"
    stance: "contrasts"
    quote: "docT5query [41] employs T5 [48] to generate queries and delivers an improved per- formance over doc2query"
  - ref_key: "ref_32"
    stance: "extends"
    quote: "retriever 3 is initialized from RetroMAE [32] and fine- tuned with hard negatives, following the baselines"
  - ref_key: "ref_50"
    stance: "background"
    quote: "Conventional methods for passage retrieval (e.g., BM25 [50]) usually consider lexical matching between the terms of query and passage"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false

descriptors:
  topics:
    - "passage_retrieval"
    - "dense_retrieval"
    - "neural_information_retrieval"
    - "query_generation"
    - "late_interaction"
    - "pre_trained_language_models"
  methods:
    - "dual_encoder"
    - "implicit_interaction"
    - "query_reconstruction"
    - "pseudo_query_generation"
    - "cross_attention"
    - "contrastive_learning"
    - "knowledge_distillation"
    - "hard_negative_mining"
  hardware:
    - "nvidia_a100_40gb"
  deployment_contexts:
    - "first_stage_retrieval"
    - "web_search"
    - "question_answering"
  populations: []
  threat_models: []
  frameworks_cited:
    - "pytorch"
    - "huggingface_transformers"

evaluation_quality:
  variance_reported: false
  confidence_intervals: false
  baseline_compared: true
  baselines_count: 18
  sample_size_main: 6980
  reruns: 0
---

## Limitations and unexamined dimensions

- The evaluation is restricted to two English passage corpora (MSMARCO-Passage and TREC DL 19); no multilingual, long-document, or domain-specific (legal, biomedical) retrieval scenarios are tested.
- No variance, standard deviation, or confidence interval is reported across training runs; each metric in Table 2 is a single point estimate.
- The query reconstructor is trained at a fixed pseudo-query length of 32 tokens and the interactor uses a fixed depth of 3 layers; no sensitivity analysis on these structural hyper-parameters is provided.
- All experiments run on 8 NVIDIA Tesla A100 GPUs with 40GB RAM; no comparison on smaller hardware, CPU-only inference, or quantised deployment is reported.
- The case study on query reconstruction in Table 5 covers only two hand-picked passages, so the qualitative claim that pseudo-query terms generalise beyond the training query relies on a very small sample.
- The method assumes that pre-computing query-aware passage vectors offline is feasible, yet the cost of re-running the interactor whenever the corpus is updated is not quantified.
