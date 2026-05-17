---
paper_id: "012"
title: "Utilizing Vector Database Management Systems in Cyber Security"
authors:
  - "Toni Taipalus"
  - "Hilkka Grahn"
  - "Hannu Turtiainen"
  - "Andrei Costin"
year: 2024
venue: "Proceedings of the 23rd European Conference on Cyber Warfare and Security, ECCWS 2024"
pdf_path: "project/data/pdfs/paper_012.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "1. Introduction"
    para_count: 5
  - type: "background"
    heading: "2. Vector Database Management Systems"
    para_count: 5
  - type: "methods"
    heading: "3. Use-Cases in Cyber Security"
    para_count: 1
  - type: "methods"
    heading: "3.1 Authentication"
    para_count: 4
  - type: "methods"
    heading: "3.2 Email Phishing Detection"
    para_count: 3
  - type: "methods"
    heading: "3.3 Anomaly Detection"
    para_count: 2
  - type: "methods"
    heading: "3.4 Network Traffic Analysis"
    para_count: 3
  - type: "conclusion"
    heading: "4. Conclusion"
    para_count: 3
  - type: "acknowledgments"
    heading: "Acknowledgment"
    para_count: 2
  - type: "references"
    heading: "References"
    para_count: 1

entities:
  - text: "Pinecone"
    type: "system"
    section: "background"
  - text: "Milvus"
    type: "system"
    section: "background"
  - text: "Chroma"
    type: "system"
    section: "background"
  - text: "FAISS"
    type: "library"
    section: "background"
  - text: "Annoy"
    type: "library"
    section: "background"
  - text: "PostgreSQL"
    type: "system"
    section: "background"
  - text: "Redis"
    type: "system"
    section: "background"
  - text: "SingleStore"
    type: "system"
    section: "background"
  - text: "OpenCV"
    type: "library"
    section: "methods"
  - text: "scikit-image"
    type: "library"
    section: "methods"
  - text: "scikit-learn"
    type: "library"
    section: "methods"
  - text: "NumPy"
    type: "library"
    section: "methods"
  - text: "librosa"
    type: "library"
    section: "methods"
  - text: "Gensim"
    type: "library"
    section: "methods"
  - text: "NLTK"
    type: "library"
    section: "methods"
  - text: "Wireshark"
    type: "tool"
    section: "methods"
  - text: "tcpdump"
    type: "tool"
    section: "methods"
  - text: "Scapy"
    type: "tool"
    section: "methods"
  - text: "Bag-of-Words"
    type: "technique"
    section: "methods"
  - text: "Term Frequency-Inverse Document Frequency"
    type: "technique"
    section: "methods"
  - text: "Word Embeddings"
    type: "technique"
    section: "methods"
  - text: "Mel-Frequency Cepstral Coefficients"
    type: "technique"
    section: "methods"
  - text: "circular Hough transform"
    type: "technique"
    section: "methods"
  - text: "DDoS"
    type: "attack"
    section: "methods"
  - text: "phishing"
    type: "attack"
    section: "methods"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we describe vectors as means of representing different data objects such as emails, network traffic, and biometric image data, how VDBMSs facilitate vector data management, and most importantly, how VDBMSs can be utilized in various cyber security related use-cases such as biometric authentication and email phishing detection"
  - type: "framework"
    stance: "asserts"
    section: "background"
    quote: "VDBMSs are a type of DBMS designed to manage vector data. Like other types of DBMSs, such as relational DBMSs, VDBMS provides means to efficiently store and retrieve vector data and provide access and concurrency control, query optimization, and database scalability"
  - type: "finding"
    stance: "asserts"
    section: "conclusion"
    quote: "The strengths of VDBMS for cyber security are their efficiency in handling large and diverse datasets, providing rapid query response times, and being adept at recognizing non-exact matches"
  - type: "finding"
    stance: "asserts"
    section: "background"
    quote: "By tailoring optimization strategies to the unique characteristics of vector data, VDBMSs can achieve better query performance compared to general-purpose DBMSs when dealing with vector-centric workloads"
  - type: "limitation"
    stance: "asserts"
    section: "methods"
    quote: "VDBMSs often do not provide the means to vectorize data"
  - type: "limitation"
    stance: "asserts"
    section: "methods"
    quote: "The quality of the initial dataset is paramount, as false positive detections can cause system or data availability issues due to false flagging and possible countermeasures"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "This prompts further theoretical and applied research on VDBMSs, potentially resulting in interesting immediate applications in highly demanding cyber-security scenarios"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "Conventional frameworks and algorithms for vector management prove inadequate when confronted with the sheer magnitude of these datasets"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "When a new email arrives, the system should vectorize it similarly to the initial email dataset and perform a similarity search in the VDBMS to find similar emails"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "different cyber security events can be represented as feature vectors, including information such as IP addresses, protocols, timestamps, file system operations, and executed commands"

numerical: []

citation_stance:
  - ref_key: "Li2023"
    stance: "background"
    quote: "Vectors as a data representation method have gained popularity with large language models, reverse image searches, and recommendation systems (Li, 2023)"
  - ref_key: "Taipalus2024"
    stance: "supports"
    quote: "This popularity stems from the inherent versatility of vectors, which allow complex data structures to be expressed in a mathematical form, enabling efficient processing and analysis (Taipalus, 2024)"
  - ref_key: "Wang2021"
    stance: "contrasts"
    quote: "Conventional frameworks and algorithms for vector management prove inadequate when confronted with the sheer magnitude of these datasets (Wang et al., 2021)"
  - ref_key: "Wang2021"
    stance: "mentions"
    quote: "Popular VDBMSs include products such as Pinecone, Milvus (Wang et al., 2021) and Chroma"
  - ref_key: "Ge2013"
    stance: "background"
    quote: "vector queries search for vectors that are approximate nearest neighbours of the query vector (Ge et al., 2013)"
  - ref_key: "Subba2021"
    stance: "extends"
    quote: "approaches similar to those presented in Subba & Gupta (2021) or Mazzavi et al. (2017) could be used to natively vectorize anomaly detection for host intrusion detection systems"
  - ref_key: "Mazzawi2017"
    stance: "extends"
    quote: "approaches similar to those presented in Subba & Gupta (2021) or Mazzavi et al. (2017) could be used to natively vectorize anomaly detection for host intrusion detection systems"
  - ref_key: "Liu2017"
    stance: "extends"
    quote: "approaches such as those of Liu et al. (2017) could natively vectorize network traffic, even in encrypted traffic"
  - ref_key: "Iglesias2015"
    stance: "supports"
    quote: "network traffic should be continuously vectorized and compared with the existing vectors in the database (Iglesias & Zseby, 2015)"
  - ref_key: "Abe2015"
    stance: "supports"
    quote: "methods such as ridge detection and orientation (Zu et al., 2006) may form the features of the vector, or use natively-vectorized approaches such as those presented in Abe & Shinzaki (2015)"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: true
  predictable_outcome: true

descriptors:
  topics:
    - "vector_database"
    - "cyber_security"
    - "biometric_authentication"
    - "phishing_detection"
    - "anomaly_detection"
    - "network_traffic_analysis"
  methods:
    - "approximate_nearest_neighbour_search"
    - "similarity_search"
    - "feature_vectorization"
    - "bag_of_words"
    - "tf_idf"
    - "word_embeddings"
    - "mfcc"
    - "circular_hough_transform"
  hardware: []
  deployment_contexts: []
  populations: []
  threat_models:
    - "phishing_email_sender"
    - "ddos_attacker"
    - "host_intrusion"
    - "network_intrusion"
  frameworks_cited: []

evaluation_quality:
  variance_reported: false
  confidence_intervals: false
  baseline_compared: false
  baselines_count: 0
  sample_size_main: 0
  reruns: 0
---

## Limitations and unexamined dimensions

- No experiment is run; the paper sketches four use cases without reporting accuracy, latency, recall, or any other measurement on real data.
- The authors explicitly note that VDBMSs often do not provide the means to vectorize data, leaving the upstream feature-extraction pipeline outside the scope of the proposed designs.
- The similarity threshold trade-off between false positives and false negatives is flagged as crucial yet no concrete tuning procedure, target operating point, or sensitivity analysis is provided.
- No hardware platform, deployment context, or scalability test is described; throughput claims about rapid query response times are asserted in prose only.
- Specific VDBMS products (Pinecone, Milvus, Chroma) and ANN libraries (FAISS, Annoy) are listed but never compared on any cyber-security workload.
- The use cases assume labelled training data of high quality is available; class imbalance, label noise, and adversarial drift in phishing, anomaly, and traffic settings are not examined.
