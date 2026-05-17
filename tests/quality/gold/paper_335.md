---
paper_id: "335"
title: "Hit Ratio Driven Mobile Edge Caching Scheme for Video on Demand Services"
authors:
  - "Xing Chen"
  - "Lijun He"
  - "Shang Xu"
  - "Shibo Hu"
  - "Qingzhou Li"
  - "Guizhong Liu"
year: 2019
venue: "IEEE International Conference on Multimedia and Expo (ICME) 2019"
pdf_path: "project/data/pdfs/paper_335.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "ABSTRACT"
    para_count: 1
  - type: "introduction"
    heading: "1. INTRODUCTION"
    para_count: 5
  - type: "methods"
    heading: "2. SYSTEM MODEL"
    para_count: 5
  - type: "methods"
    heading: "3. JOINT OPTIMIZATION PROBLEM OF VIDEO CACHING AND TRANSCODING"
    para_count: 3
  - type: "methods"
    heading: "4. JOINT CACHING ALGORITHM OF VIDEO CACHING AND TRANSCODING"
    para_count: 4
  - type: "results"
    heading: "5. PERFORMANCE EVALUATION"
    para_count: 6
  - type: "conclusion"
    heading: "6. CONCLUSION"
    para_count: 1
  - type: "references"
    heading: "7. REFERENCES"
    para_count: 12

entities:
  - text: "MEC"
    type: "technique"
    section: "introduction"
  - text: "mobile edge computing"
    type: "technique"
    section: "introduction"
  - text: "LRU"
    type: "method"
    section: "introduction"
  - text: "LFU"
    type: "method"
    section: "introduction"
  - text: "WGDSF"
    type: "method"
    section: "introduction"
  - text: "GDSF"
    type: "method"
    section: "introduction"
  - text: "Greedy Dual Size Frequency"
    type: "method"
    section: "introduction"
  - text: "Weighted Greedy Dual Size Frequency"
    type: "method"
    section: "introduction"
  - text: "Zipf distribution"
    type: "concept"
    section: "methods"
  - text: "Poisson distribution"
    type: "concept"
    section: "methods"
  - text: "dynamic programming"
    type: "algorithm"
    section: "methods"
  - text: "grouping knapsack problem"
    type: "concept"
    section: "methods"
  - text: "MATLAB"
    type: "tool"
    section: "results"
  - text: "High-Definition video"
    type: "concept"
    section: "methods"
  - text: "Standard-Definition video"
    type: "concept"
    section: "methods"
  - text: "5G"
    type: "standard"
    section: "introduction"
  - text: "femto base-stations"
    type: "hardware"
    section: "introduction"
  - text: "cache hit ratio"
    type: "metric"
    section: "methods"
  - text: "backhaul network load"
    type: "metric"
    section: "results"
  - text: "startup delay"
    type: "metric"
    section: "results"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we jointly consider the video popularity, the user preference, and the characteristic of video representations into the request probability calculation to guide a differential caching"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we simultaneously improve the above objectives with the objective to maximize the cache hit ratio, and combine real-time transcoding to enable more users to enjoy better services"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "we transform it into a grouping knapsack problem and the dynamic programming algorithm is applied to obtain the optimal solution"
  - type: "finding"
    stance: "validates"
    section: "results"
    quote: "PROPOSED has the best performance in term of the hit ratio and is about 10% higher than the hit ratio of LFU, LRU and WGDSF algorithms"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "With the increase of the storage size of the MEC server, the hit ratio will be gradually close to 100%"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "Compared with LFU, LRU and WGDSF, PROPOSED has the best performance in term of cache hit ratio"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "As the hit ratio is increased, the backhaul network load and the startup delay are reduced"
  - type: "challenges_existing"
    stance: "challenges"
    section: "introduction"
    quote: "Existing cache algorithms only consider video popularity and representation characteristics, without considering the video content preference of each user, which results in a low cache hit rate"
  - type: "limitation"
    stance: "asserts"
    section: "results"
    quote: "The experimental environment deployment only considers the situation of one MEC server"
  - type: "limitation"
    stance: "asserts"
    section: "methods"
    quote: "the computing capacity for transcoding is assumed to be unlimited in this work"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "These results show that our proposed algorithm can perform differential caching by analyzing user preferences, and achieves a better performance compared to the methods LRU, LFU and WGDSF"

numerical:
  - metric: "hit_ratio_improvement"
    value: 0.10
    dataset: "21-video library"
    split: null
    quote: "PROPOSED has the best performance in term of the hit ratio and is about 10% higher than the hit ratio of LFU, LRU and WGDSF algorithms"
  - metric: "video_library_size"
    value: 21
    dataset: "21-video library"
    split: null
    quote: "The simulation experiment adopts a library of 21 videos with their popularity following the Zipf distribution"
  - metric: "zipf_parameter"
    value: 0.6
    dataset: "21-video library"
    split: null
    quote: "the Zipf distribution with parameter"
  - metric: "user_count"
    value: 900
    dataset: "21-video library"
    split: null
    quote: "The user number"
  - metric: "base_stations"
    value: 4
    dataset: "21-video library"
    split: null
    quote: "these users are evenly distributed in the range of 4 base stations"
  - metric: "storage_size"
    value: 350
    dataset: "21-video library"
    split: null
    quote: "the storage size of the MEC server is 350 storage units"
  - metric: "poisson_rate"
    value: 0.9
    dataset: "21-video library"
    split: null
    quote: "The video request arriving follows a Poisson distribution with rate"
  - metric: "daily_requests"
    value: 900
    dataset: "21-video library"
    split: null
    quote: "we assume that the request times be 900 every day"

citation_stance:
  - ref_key: "ref_5"
    stance: "background"
    quote: "Literature [5] proposed a novel cache architecture with a proxy server. This architecture allows partial caching of media objects and joint delivery from caches and origin servers to reduce startup delay and improve stream quality"
  - ref_key: "ref_8"
    stance: "background"
    quote: "A joint optimization scheme was proposed in wireless cellular networks with mobile edge computing, taking into consideration computation offloading decision, physical spectrum resource allocation, MEC computation resource allocation, and content caching strategy [8]"
  - ref_key: "ref_9"
    stance: "background"
    quote: "Literature [9] proposed a storage resource allocation scheme of the MEC server taking each BS traffic load into consideration"
  - ref_key: "ref_10"
    stance: "extends"
    quote: "Literature [10] studied a QoE driven mobile edge caching placement optimization problem for dynamic adaptive video streaming that properly takes into account the different rate-distortion(R–D) characteristics of videos and the coordination among distributed edge servers"
  - ref_key: "ref_11"
    stance: "background"
    quote: "Literature [11] jointly considered Mobile Edge Computing and Caching-enabled software-defined mobile networks to enhance the video service in next generation mobile networks"
  - ref_key: "ref_12"
    stance: "extends"
    quote: "Literature [12] presented a novel caching replacement algorithm named Weighted Greedy Dual Size Frequency (WGDSF) algorithm, which is an improvement on the Greedy Dual Size Frequency (GDSF) algorithm"
  - ref_key: "ref_6"
    stance: "background"
    quote: "caching some popular content at femto base-stations (FBSs) and user equipment (UE) can be exploited to alleviate the burden of backhaul and to reduce the costly transmissions from the macro base-stations to UEs [6][7]"
  - ref_key: "ref_1"
    stance: "background"
    quote: "As a main evolutional technology in 5G communication system, MEC [1][2] is close to user nodes and data sources"

quality_flags:
  self_constructed_ground_truth: true
  comparison_table_only: false
  hobby_project_scale: true
  predictable_outcome: false
---

## Limitations and unexamined dimensions

- The experimental environment deployment only considers the situation of one MEC server, so multi-server coordination, handover, and inter-MEC cache sharing are not measured.
- The simulation library contains only 21 videos with five content types and 900 synthetic users, which is far smaller than any real video-on-demand catalogue and leaves catalogue-scale behaviour unexamined.
- Transcoding cost is removed from the model by assuming the computing capacity for transcoding is unlimited, so the proposed joint scheme is never stressed against realistic CPU or GPU budgets.
- Only two representations (HD and SD) per video are considered; adaptive bitrate ladders with multiple intermediate qualities are out of scope.
- User mobility, channel variation, and base-station handover are absent from the model even though the scenario is mobile edge caching; users are simply assigned to 4 base stations and the request process is a stationary Poisson stream.
- The hit-ratio plots report a single curve per algorithm with no confidence interval, variance across runs, or statistical significance test for the claimed 10% improvement.
