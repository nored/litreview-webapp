---
paper_id: "034"
title: "Research on SQL Injection Attacks Using Word Embedding Techniques and Machine Learning"
authors:
  - "S. Venkatramulu"
  - "Md. Sharfuddin Waseem"
  - "Arshiya Taneem"
  - "Sri Yashaswini Thoutam"
  - "Snigdha Apuri"
  - "Nachiketh"
year: 2024
venue: "Journal of Sensors, IoT & Health Sciences"
pdf_path: "project/data/pdfs/paper_034.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "1.Introduction"
    para_count: 7
  - type: "related_work"
    heading: "2.Related Works"
    para_count: 7
  - type: "methods"
    heading: "3.Proposed System"
    para_count: 9
  - type: "experimental_setup"
    heading: "5.Performance Metrics"
    para_count: 8
  - type: "results"
    heading: "5.1 Results"
    para_count: 3
  - type: "conclusion"
    heading: "6.Conclusion"
    para_count: 2
  - type: "future_work"
    heading: "7.Future Scope"
    para_count: 2
  - type: "references"
    heading: "References"
    para_count: 16

entities:
  - text: "SQL Injection"
    type: "attack"
    section: "introduction"
  - text: "Tautology attack"
    type: "attack"
    section: "introduction"
  - text: "Union-based attack"
    type: "attack"
    section: "introduction"
  - text: "Time-based attack"
    type: "attack"
    section: "introduction"
  - text: "Blind attack"
    type: "attack"
    section: "introduction"
  - text: "Piggy-Backed Queries"
    type: "attack"
    section: "introduction"
  - text: "Count Vectorizer"
    type: "method"
    section: "methods"
  - text: "TF-IDF Vectorizer"
    type: "method"
    section: "methods"
  - text: "Bag-Of-Words"
    type: "method"
    section: "methods"
  - text: "Word2Vec"
    type: "method"
    section: "related_work"
  - text: "Logistic Regression"
    type: "algorithm"
    section: "methods"
  - text: "SVM"
    type: "algorithm"
    section: "methods"
  - text: "XGBoost"
    type: "algorithm"
    section: "methods"
  - text: "SGD Classifier"
    type: "algorithm"
    section: "methods"
  - text: "Naive Bayes Classifier"
    type: "algorithm"
    section: "related_work"
  - text: "Convolutional Neural Network"
    type: "model"
    section: "related_work"
  - text: "LightGBM"
    type: "algorithm"
    section: "related_work"
  - text: "AdaBoost"
    type: "algorithm"
    section: "related_work"
  - text: "Gradient Boosting Classifier"
    type: "algorithm"
    section: "related_work"
  - text: "Kaggle SQL Injection dataset"
    type: "dataset"
    section: "methods"
  - text: "scikit-learn"
    type: "library"
    section: "methods"
  - text: "F1 Score"
    type: "metric"
    section: "experimental_setup"
  - text: "Accuracy"
    type: "metric"
    section: "experimental_setup"
  - text: "Precision"
    type: "metric"
    section: "experimental_setup"
  - text: "Recall"
    type: "metric"
    section: "experimental_setup"
  - text: "OWASP"
    type: "organisation"
    section: "introduction"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "A method of SQL injection detection based on machine learning is proposed"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "Our goal in doing this systematic review is to find a better machine learning model to detect SQL injection attacks via implementing different word embedding techniques"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "XGBoost algorithm with a unigram count vectorizer encoding of 70:30 split data ratio, gave us the best model with an F1-score of 0.992 and accuracy of 0.994"
  - type: "finding"
    stance: "asserts"
    section: "conclusion"
    quote: "This research effort has produced a novel method for detecting SQLi attacks utilizing word encoding techniques and machine learning algorithms"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "We have implemented the models on Logistic Regression, SVM, and XGBoost"
  - type: "limitation"
    stance: "asserts"
    section: "future_work"
    quote: "To increase the accuracy and reliability, a larger and more diverse dataset must be used to evaluate the experimental model"
  - type: "future_work"
    stance: "asserts"
    section: "future_work"
    quote: "a more robust and advanced methodology like deep learning would be considered, which would enhance the efficiency and performance of the generated model"
  - type: "future_work"
    stance: "asserts"
    section: "future_work"
    quote: "We can also try with different word encoding methods like fastText, GloVe and combine them with NLP techniques and find the best model among them"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "Since none of the solutions offered offer a precise solution for preventing inserted queries and because there are numerous more mechanisms via which injection is conceivable, prevention is a little bit complicated"

numerical:
  - metric: "dataset_size"
    value: 30919
    dataset: "Kaggle SQL Injection"
    split: null
    quote: "There are 30919 rows in the data set"
  - metric: "f1"
    value: 0.992
    dataset: "Kaggle SQL Injection"
    split: "test"
    quote: "gave us the best model with an F1-score of 0.992 and accuracy of 0.994"
  - metric: "accuracy"
    value: 0.994
    dataset: "Kaggle SQL Injection"
    split: "test"
    quote: "gave us the best model with an F1-score of 0.992 and accuracy of 0.994"
  - metric: "accuracy"
    value: 0.9951
    dataset: "SQLi"
    split: null
    quote: "Light GBM was shown to be superior to the other boosting methods, with an accuracy of 99.51 percent for SQLi and 99.59 percent for XSS"
  - metric: "accuracy"
    value: 0.9959
    dataset: "XSS"
    split: null
    quote: "Light GBM was shown to be superior to the other boosting methods, with an accuracy of 99.51 percent for SQLi and 99.59 percent for XSS"
  - metric: "accuracy"
    value: 0.928
    dataset: "SQLIA test scenarios"
    split: null
    quote: "The success percentage for the Naive Bayes classifier machine learning model is 92.8%"
  - metric: "fpr"
    value: 0.120761
    dataset: "SQLi"
    split: null
    quote: "The LGBM had 0.120761 FPR and 0.007 RMSE"
  - metric: "breach_cost_usd"
    value: 400000000
    dataset: "Equifax breach"
    split: null
    quote: "The company estimated that it would spend over $400 million to deal with the fallout from the breach"
  - metric: "stock_price_drop"
    value: 0.30
    dataset: "Equifax breach"
    split: null
    quote: "The company's stock price also plummeted, losing over 30% of its value in the weeks following the announcement of the breach"
  - metric: "affected_individuals"
    value: 147000000
    dataset: "Equifax breach"
    split: null
    quote: "resulted in the theft of personal information from over 147 million people"

citation_stance:
  - ref_key: "ref_1"
    stance: "background"
    quote: "Finally, convolutional neural networks (CNN) were opted to be used in the detection of SQL Injection attacks [1]"
  - ref_key: "ref_2"
    stance: "background"
    quote: "In article [2][3], the author has attempted to present a variety of word embedding techniques, along with the models and techniques employed by those methods"
  - ref_key: "ref_3"
    stance: "background"
    quote: "In article [2][3], the author has attempted to present a variety of word embedding techniques, along with the models and techniques employed by those methods"
  - ref_key: "ref_4"
    stance: "supports"
    quote: "Light GBM was shown to be superior to the other boosting methods, with an accuracy of 99.51 percent for SQLi and 99.59 percent for XSS [4]"
  - ref_key: "ref_5"
    stance: "extends"
    quote: "Binh Ahn Pham, Vinitha Hannah Subburaj [5], they examine SQL injection protection methods"
  - ref_key: "ref_6"
    stance: "supports"
    quote: "the ensemble learning technique known as Gradient Boosting Classifier was chosen for application to the SQL Injection classification problem [6][7][8][9]"
  - ref_key: "ref_10"
    stance: "supports"
    quote: "AdaBoost has a 0.009 FPR and 0.007 RMSE"
  - ref_key: "ref_13"
    stance: "background"
    quote: "SVM, which transforms the input space into a higher-dimensional space using a kernel function. [13][14]"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: true
  predictable_outcome: true

descriptors:
  topics:
    - sql_injection_detection
    - web_application_security
  methods:
    - count_vectorizer
    - tfidf_vectorizer
    - bag_of_words
    - logistic_regression
    - svm
    - xgboost
    - sgd_classifier
  hardware: []
  deployment_contexts:
    - web_application
  populations:
    - kaggle_sqli_queries
  threat_models:
    - web_attacker_injecting_sql
  frameworks_cited: []

evaluation_quality:
  variance_reported: false
  confidence_intervals: false
  baseline_compared: true
  baselines_count: 3
  sample_size_main: 30919
  reruns: 0
---

## Limitations and unexamined dimensions

- Models are trained and tested on a single Kaggle SQL Injection dataset of 30919 rows, and the authors themselves note that a larger and more diverse dataset would be needed to evaluate reliability.
- Results come from one train/test split with random_state fixed at 0, with no cross-validation, repeated runs, or variance estimates around the reported F1 of 0.992 and accuracy of 0.994.
- Word embedding coverage is limited to count vectorizer, TF-IDF, and bag-of-words; the future scope explicitly flags fastText, GloVe, and contextual embeddings as untested in this paper.
- The classifier set is restricted to Logistic Regression, SVM, and XGBoost, and the authors acknowledge that deep learning methods were considered but left to future work.
- Inputs are isolated SQL query strings paired with binary labels; full HTTP requests, obfuscated payloads, and live web traffic conditions are out of scope.
- Run time analysis reports a single seconds value per algorithm without specifying hardware, repetitions, or variability across runs.
