---
paper_id: "048"
title: "Cloud-Native Vector Search: A Comprehensive Performance Analysis [Experiments, Analysis and Benchmark]"
authors:
  - "Zhaoheng Li"
  - "Wei Ding"
  - "Silu Huang"
  - "Zikang Wang"
  - "Yuanjin Lin"
  - "Ke Wu"
  - "Yongjoo Park"
  - "Jianjun Chen"
year: 2025
venue: "arXiv:2511.14748v2 [cs.DB]"
pdf_path: "project/data/pdfs/paper_048.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "ABSTRACT"
    para_count: 2
  - type: "introduction"
    heading: "1 INTRODUCTION"
    para_count: 9
  - type: "background"
    heading: "2 CLOUD VECTOR SEARCH FUNDAMENTALS"
    para_count: 12
  - type: "methods"
    heading: "3 INDEX DESIGN FOR CLOUD STORAGE"
    para_count: 5
  - type: "methods"
    heading: "4 ON-CLOUD INDEX-CACHE INTEGRATION"
    para_count: 6
  - type: "experimental_setup"
    heading: "5 EXPERIMENTS"
    para_count: 6
  - type: "results"
    heading: "5.2 What Index For What Scenario?"
    para_count: 6
  - type: "results"
    heading: "5.3 How to Design Indexes?"
    para_count: 8
  - type: "results"
    heading: "5.4 How to Utilize Caching?"
    para_count: 6
  - type: "related_work"
    heading: "6 RELATED WORK"
    para_count: 4
  - type: "conclusion"
    heading: "7 CONCLUSION"
    para_count: 1
  - type: "references"
    heading: "REFERENCES"
    para_count: 93

entities:
  - text: "SPANN"
    type: "method"
    section: "background"
  - text: "DiskANN"
    type: "method"
    section: "background"
  - text: "TurboPuffer"
    type: "system"
    section: "introduction"
  - text: "Amazon S3 Vector"
    type: "system"
    section: "introduction"
  - text: "SPFresh"
    type: "method"
    section: "background"
  - text: "IVF-PQ"
    type: "method"
    section: "background"
  - text: "HNSW"
    type: "method"
    section: "methods"
  - text: "NSG"
    type: "method"
    section: "methods"
  - text: "BKT"
    type: "method"
    section: "background"
  - text: "Volcano TOS"
    type: "platform"
    section: "background"
  - text: "Amazon S3"
    type: "platform"
    section: "background"
  - text: "Azure Blob"
    type: "platform"
    section: "background"
  - text: "GIST1M"
    type: "dataset"
    section: "experimental_setup"
  - text: "DEEP10M"
    type: "dataset"
    section: "experimental_setup"
  - text: "MSSPACE10M"
    type: "dataset"
    section: "experimental_setup"
  - text: "BIGANN1B"
    type: "dataset"
    section: "experimental_setup"
  - text: "GoVector"
    type: "method"
    section: "related_work"
  - text: "CrackingIVF"
    type: "method"
    section: "methods"
  - text: "CALL"
    type: "method"
    section: "related_work"
  - text: "Starling"
    type: "method"
    section: "related_work"
  - text: "MARGO"
    type: "method"
    section: "related_work"
  - text: "Tribase"
    type: "system"
    section: "related_work"
  - text: "TRIM"
    type: "method"
    section: "related_work"
  - text: "LAET"
    type: "method"
    section: "related_work"
  - text: "Auncel"
    type: "method"
    section: "related_work"
  - text: "Manu"
    type: "system"
    section: "background"
  - text: "Milvus"
    type: "system"
    section: "background"
  - text: "OpenSearch"
    type: "system"
    section: "background"
  - text: "ByteDance ecs.s2-c1m4.14xlarge"
    type: "hardware"
    section: "experimental_setup"
  - text: "SLRU cache"
    type: "method"
    section: "methods"
  - text: "perf"
    type: "tool"
    section: "background"
  - text: "QPS"
    type: "metric"
    section: "experimental_setup"
  - text: "recall"
    type: "metric"
    section: "experimental_setup"
  - text: "cache hit rate"
    type: "metric"
    section: "experimental_setup"
  - text: "Product Quantization"
    type: "technique"
    section: "background"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "This paper systematically studies cloud-native vector search"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "We analyze bottlenecks of two common index classes, clus- ter and graph indexes, on remote storage, and show that despite current standardized adoption of cluster indexes on the cloud, graph indexes are favored in workloads requiring high concurrency and recall"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "we can observe that DiskANN outper- forms SPANN in high-concurrency and/or recall scenarios on all datasets, matching observations in prior studies for on-disk index- ing"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "at 0.995 recall and 64 concurrent queries, SPANN 's posting list mean I/O latency is 21.6 seconds , and the bandwidth is only enough to serve 2.5 SPANN queries per second at this recall"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "SPANN benefits from caching as cache hits reduce I/O bandwidth and/or IOPS pressure of concurrent posting list fetching"
  - type: "baseline_comparison"
    stance: "validates"
    section: "experimental_setup"
    quote: "We study the following indexes as the representatives from their respective index classes"
  - type: "challenges_existing"
    stance: "challenges"
    section: "abstract"
    quote: "providers default to using cluster-based indexes, which on paper do adapt well to differences between disk and cloud-based environment"
  - type: "first_in_area"
    stance: "asserts"
    section: "introduction"
    quote: "we follow our theory-driven modeling and bottleneck analysis of graph and cluster vector indexes for cloud-native vector search to formulate hypotheses on optimal indexing designs and parameterizations"
  - type: "releases_code"
    stance: "asserts"
    section: "experimental_setup"
    quote: "Our benchmarking scripts and datasets are open- sourced in our Github Repository"
  - type: "limitation"
    stance: "asserts"
    section: "background"
    quote: "All existing cloud-native vector search providers use one-compute-node-to-one-storage-bucket setups. We defer studying distributed setups to future work"
  - type: "future_work"
    stance: "asserts"
    section: "related_work"
    quote: "further developing a beamwidth-aware caching strategy would be valuable future work for on-cloud search"
  - type: "future_work"
    stance: "extends"
    section: "related_work"
    quote: "While early stopping will improve the performace of on-cloud search with graph indexes by reducing roundtrips, our results suggest that adopting within-posting list early stopping for cluster indexes will require more consideration"

numerical:
  - metric: "p50_read_latency_us"
    value: 66.5
    dataset: "SSD"
    split: null
    quote: "SSD 66.5 𝜇 s 420,000 12"
  - metric: "p50_read_latency_us"
    value: 9000
    dataset: "Volcano TOS"
    split: null
    quote: "Volcano TOS [14] 9000 𝜇 s 20,000 0.625"
  - metric: "get_qps_limit"
    value: 20000
    dataset: "Volcano TOS"
    split: null
    quote: "a GET request limit of 20,000QPS"
  - metric: "read_throughput_gbps"
    value: 0.625
    dataset: "Volcano TOS"
    split: null
    quote: "0.625"
  - metric: "network_bandwidth_gbps"
    value: 5
    dataset: "ByteDance ecs.s2-c1m4.14xlarge"
    split: null
    quote: "download network bandwidth to our machine of 5Gbps"
  - metric: "mean_io_latency_seconds"
    value: 21.6
    dataset: "GIST1M"
    split: null
    quote: "SPANN 's posting list mean I/O latency is 21.6 seconds"
  - metric: "qps"
    value: 2.5
    dataset: "GIST1M"
    split: null
    quote: "the bandwidth is only enough to serve 2.5 SPANN queries per second at this recall"
  - metric: "data_read_mb_per_query"
    value: 256
    dataset: "GIST1M"
    split: null
    quote: "each SPANN query reads a large amount of data, from 2.5MB at 0.7 recall to 256MB at 0.995 recall"
  - metric: "io_latency_ratio"
    value: 416
    dataset: "GIST1M"
    split: null
    quote: "its batched node expansion requests having 416 × lower mean I/O latency ver-sus SPANN at 0.995 recall and 64 concurrent queries"
  - metric: "qps_speedup"
    value: 7.61
    dataset: "DEEP10M"
    split: null
    quote: "improve QPS by up to 7.61 × at 0.995 recall"
  - metric: "qps_speedup"
    value: 3.14
    dataset: "GIST1M"
    split: null
    quote: "the former achieves QPS gains versus the latter on high recall and/or concurrency scenarios (up to 3.14 ×) as the centroid%=32 count index contains more posting lists each of significantly smaller size"
  - metric: "qps_speedup"
    value: 1.85
    dataset: "GIST1M"
    split: null
    quote: "the former achieves consistent (up to 1.85 × ) QPS gains versus the latter on all scenarios"
  - metric: "recall"
    value: 0.995
    dataset: "GIST1M"
    split: null
    quote: "early stopping if the current parameterization value achieves a recall > 0.995"

citation_stance:
  - ref_key: "ref_77"
    stance: "extends"
    quote: "TurboPuffer currently caches the cluster metadata (namely the BKT tree, §2.3.1) of commonly accessed SPFresh indexes"
  - ref_key: "ref_12"
    stance: "background"
    quote: "providers such as TurboPuffer [77] and Amazon S3 Vector [12] have began offering cloud-native vector search services"
  - ref_key: "ref_17"
    stance: "extends"
    quote: "almost all current on-cloud vector search providers offer only cluster indexes (e.g., IVF-PQ [60], SPANN [17], SPFresh [85])"
  - ref_key: "ref_85"
    stance: "background"
    quote: "TurboPuffer uses SPFresh [85], a more recently updatable extension of SPANN"
  - ref_key: "ref_36"
    stance: "extends"
    quote: "for example, ad-hoc querying with DiskANN, which requires long, iterative traversals for high recalls [36]"
  - ref_key: "ref_91"
    stance: "extends"
    quote: "GoVector [91] and CALL [38] have recently proposed methods for improving the cache hit rate of caching strategies applied to graph index blocks and cluster index posting lists, respectively"
  - ref_key: "ref_80"
    stance: "extends"
    quote: "Starling [80] aims to place neighboring nodes in the same index block to reduce the total number of I/O calls performed during expansion"
  - ref_key: "ref_87"
    stance: "extends"
    quote: "MARGO [87] builds on Starling to additionally place nodes on common paths in the same block aiming to perform multiple expansion rounds with one roundtrip to storage"
  - ref_key: "ref_18"
    stance: "supports"
    quote: "matches conventional wisdom for the indexes' performance for on-disk querying [30], where DiskANN is outperformed by SPANN at low recalls and vice versa"
  - ref_key: "ref_84"
    stance: "extends"
    quote: "Tribase [84] and TRIM [73] further use triangle inequalities to early stop within-posting list distance computations"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false

descriptors:
  topics:
    - cloud_native_vector_search
    - approximate_nearest_neighbor
    - index_caching
  methods:
    - cluster_index_spann
    - graph_index_diskann
    - product_quantization
    - slru_caching
  hardware:
    - bytedance_ecs_s2_c1m4_14xlarge
    - volcano_tos
  deployment_contexts:
    - cloud_remote_object_storage
    - one_compute_node_one_bucket
  populations:
    - gist1m
    - deep10m
    - msspace10m
    - bigann1b
  threat_models: []
  frameworks_cited:
    - turbopuffer
    - amazon_s3_vector
    - milvus
    - manu
    - opensearch

evaluation_quality:
  variance_reported: false
  confidence_intervals: false
  baseline_compared: true
  baselines_count: 2
  sample_size_main: 1000
  reruns: 0
---

## Limitations and unexamined dimensions

- The study restricts itself to one cloud-native remote storage backend, Volcano TOS, with a 20,000 GET QPS limit and 0.625 GB/s read throughput, and does not measure how results shift on Amazon S3, Azure Blob, or GCP storage.
- All experiments use a one-compute-node-to-one-storage-bucket layout, with distributed multi-node setups explicitly deferred to future work.
- Only two index implementations are evaluated, SPANN as the cluster index and DiskANN as the graph index, leaving other graph indexes such as HNSW and NSG and other cluster indexes such as IVF-PQ and SPFresh outside the measured comparison.
- Caching experiments rely on a single SLRU policy with cold-start cache fills on the 1,000 GIST1M queries, with no comparison to alternative eviction policies or warm-cache regimes.
- Reported QPS, latency, and bandwidth numbers are presented as single values per setting without variance, confidence intervals, or repeated runs.
- The benchmark workloads are drawn from four ANN datasets (GIST1M, DEEP10M, MSSPACE10M, BIGANN1B) and do not include updates, deletions, or filtered queries common to production vector workloads.
