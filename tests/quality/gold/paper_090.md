---
paper_id: "090"
title: "Deep Facial Emotion Recognition Using Local Features Based on Facial Landmarks for Security System"
authors:
  - "Youngeun An"
  - "Jimin Lee"
  - "EunSang Bak"
  - "Sungbum Pan"
year: 2023
venue: "Computers, Materials & Continua, vol. 76, no. 2"
pdf_path: "project/data/pdfs/paper_090.pdf"
read_date: "2026-05-17"

sections:
  - type: "abstract"
    heading: "Abstract"
    para_count: 1
  - type: "introduction"
    heading: "1 Introduction"
    para_count: 6
  - type: "related_work"
    heading: "2 Previous Studies on Facial Emotion Recognition"
    para_count: 1
  - type: "background"
    heading: "2.1 Public Databases"
    para_count: 6
  - type: "related_work"
    heading: "2.2 Conventional Emotion Recognition Methods Using Facial Expressions"
    para_count: 3
  - type: "methods"
    heading: "3 Emotion Recognition Using Feature Information of Partial Face Regions"
    para_count: 7
  - type: "results"
    heading: "4 Experiments and Analysis"
    para_count: 8
  - type: "conclusion"
    heading: "5 Conclusion"
    para_count: 2
  - type: "acknowledgments"
    heading: "Acknowledgement"
    para_count: 1
  - type: "references"
    heading: "References"
    para_count: 1

entities:
  - text: "CK+"
    type: "dataset"
    section: "background"
  - text: "JAFFE"
    type: "dataset"
    section: "background"
  - text: "FER2013"
    type: "dataset"
    section: "background"
  - text: "Haar cascade"
    type: "method"
    section: "methods"
  - text: "CNN"
    type: "model"
    section: "methods"
  - text: "GoogLeNet"
    type: "model"
    section: "related_work"
  - text: "AlexNet"
    type: "model"
    section: "related_work"
  - text: "VGGNet"
    type: "model"
    section: "related_work"
  - text: "DBM-CNN"
    type: "model"
    section: "related_work"
  - text: "SVM"
    type: "method"
    section: "related_work"
  - text: "DNN"
    type: "model"
    section: "related_work"
  - text: "RNN"
    type: "model"
    section: "related_work"
  - text: "Fisherface"
    type: "method"
    section: "related_work"
  - text: "Facial Action Coding System"
    type: "framework"
    section: "methods"
  - text: "soft voting"
    type: "technique"
    section: "methods"
  - text: "Euclidean distance"
    type: "measure"
    section: "methods"
  - text: "MATLAB"
    type: "software"
    section: "results"
  - text: "facial landmarks"
    type: "concept"
    section: "methods"
  - text: "ensemble network"
    type: "technique"
    section: "methods"
  - text: "accuracy"
    type: "metric"
    section: "results"

claims:
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "this paper proposes a novel feature vector extraction method using the Euclidean distance between the landmarks changing their positions according to facial expressions, especially around the eyes, eyebrows, nose, and mouth"
  - type: "contribution"
    stance: "asserts"
    section: "introduction"
    quote: "we propose a novel emotion recognition method taking advantage of the features from a partial face to overcome the difficulty of extracting valuable features from the whole area of the face due to their sensitivity to the variation of illumination and background"
  - type: "method"
    stance: "asserts"
    section: "methods"
    quote: "we are given feature vectors for local characteristics from the landmarks of three different regions as well as the feature vectors from the whole face area for global characteristics. Those four types of feature vectors are employed to train the respective CNN"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "the proposed algorithm achieved a higher facial emotion recognition accuracy than the conventional algorithms"
  - type: "finding"
    stance: "asserts"
    section: "results"
    quote: "the proposed method proved robust to illumination conditions because the feature information employed is tolerant to the change in brightness"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "the accuracy of the proposed algorithm was 26.57% higher than that of the CNN adopted by Tang"
  - type: "baseline_comparison"
    stance: "validates"
    section: "results"
    quote: "the accuracy of the proposed method employing the feature information from the landmarks of the face was 95.87%, i.e., 23.74% higher than that of the CNN model only using whole facial images"
  - type: "challenges_existing"
    stance: "challenges"
    section: "related_work"
    quote: "the inherent drawbacks of being susceptible to illu- mination conditions and backgrounds have yet to be fully overcome"
  - type: "limitation"
    stance: "asserts"
    section: "conclusion"
    quote: "future research should improve emotion recognition performance by studying multi-information-based emotional state classification using detailed feature pattern information, such as facial movement feature extraction, and catching facial expression changes in continuous or dynamic images instead of a single image"
  - type: "future_work"
    stance: "asserts"
    section: "conclusion"
    quote: "we believe the proposed method can be used in various fields, including psychology, neurology, behavioral science, and computer science"
  - type: "future_work"
    stance: "asserts"
    section: "results"
    quote: "we believe the proposed algorithm will be able to alert or prevent such criminal behaviors in advance"

numerical:
  - metric: "accuracy"
    value: 0.9607
    dataset: "CK+"
    split: "test"
    quote: "96.07"
  - metric: "accuracy"
    value: 0.9697
    dataset: "JAFFE"
    split: "test"
    quote: "96.97"
  - metric: "accuracy"
    value: 0.9587
    dataset: "FER2013"
    split: "test"
    quote: "95.87"
  - metric: "accuracy"
    value: 0.7213
    dataset: "FER2013"
    split: "test"
    quote: "Emotion recognition algorithm using only the whole facial image"
  - metric: "accuracy_delta"
    value: 0.25
    dataset: "FER2013"
    split: "test"
    quote: "our experiments with the FER2013 database show that our proposed method is robust to lighting conditions and backgrounds, with an average of 25% higher performance than previous studies"
  - metric: "accuracy_delta"
    value: 0.2657
    dataset: "FER2013"
    split: "test"
    quote: "the accuracy of the proposed algorithm was 26.57% higher than that of the CNN adopted by Tang"
  - metric: "accuracy_delta"
    value: 0.2374
    dataset: "FER2013"
    split: "test"
    quote: "23.74% higher than that of the CNN model only using whole facial images"
  - metric: "sample_size"
    value: 1635
    dataset: "CK+"
    split: null
    quote: "1,635"
  - metric: "sample_size"
    value: 213
    dataset: "JAFFE"
    split: null
    quote: "213 images of 10 Japanese women with various facial expressions"
  - metric: "sample_size"
    value: 32298
    dataset: "FER2013"
    split: null
    quote: "32,298"
  - metric: "train_test_split"
    value: 0.7
    dataset: null
    split: "train"
    quote: "each database was divided into 7:3 for the training and test data ratio"

citation_stance:
  - ref_key: "ref_2"
    stance: "background"
    quote: "Al-Modwahi et al. [2] developed a real-time facial expression recognition system that can immediately recognize a person's facial expression and notify a security guard before a prohibited action is executed"
  - ref_key: "ref_3"
    stance: "background"
    quote: "Sajjad et al. [3] developed a system that analyzes facial expressions to pre-recognize activities such as robbery or fights between people for the intelligent security of law-enforcement services"
  - ref_key: "ref_8"
    stance: "supports"
    quote: "Rhodes [8] showed that the features of the eyebrows, eyes, nose, and mouth (and the spatial relationships among these features) are more critical for recognizing emotions than other features of the face"
  - ref_key: "ref_9"
    stance: "supports"
    quote: "Pilowsky et al. [9] reported that the distance between the features of a facial expression is essential for recognizing facial expressions"
  - ref_key: "ref_10"
    stance: "contrasts"
    quote: "the accuracy of the proposed algorithm was 2.87% higher than that of the algorithm proposed by Mollahosseini et al. [10], which used a newly constructed deep neural network architecture"
  - ref_key: "ref_11"
    stance: "contrasts"
    quote: "3.6% higher than the algorithm proposed by Liu et al. [11], which detected particular facial action parts and used an adaptive 3D CNN employing discriminatory features"
  - ref_key: "ref_12"
    stance: "contrasts"
    quote: "it was 0.39"
  - ref_key: "ref_13"
    stance: "contrasts"
    quote: "the accuracy of the proposed algorithm was 26.57% higher than that of the CNN adopted by Tang"
  - ref_key: "ref_14"
    stance: "contrasts"
    quote: "25.85% higher than that of a deep-learning method proposed by Minaee et al. [14], which is based on attention convolutional networks"
  - ref_key: "ref_17"
    stance: "extends"
    quote: "Happy et al. [17] extracted landmarks from the face, similar to the proposed method, and chose the prominent features as patches to use as feature information"
  - ref_key: "ref_25"
    stance: "supports"
    quote: "which were suggested by Paul Eckman, who demonstrated the universality of seven primary facial expressions of emotions found in social and psychological research for several decades"

quality_flags:
  self_constructed_ground_truth: false
  comparison_table_only: false
  hobby_project_scale: false
  predictable_outcome: false
---

## Limitations and unexamined dimensions

- All training and testing is split 7:3 within each database and no cross-database generalisation experiment is reported, so transfer between CK+, JAFFE, and FER2013 is left unexamined.
- Accuracy is reported as a single number per database with no variance, standard deviation, or confidence interval across runs.
- The landmark extractor is treated as a black box drawn from prior work, and the paper does not analyse how detector failures or mis-localised landmarks propagate into the feature vectors.
- The proposed method is evaluated only on three posed or web-collected still-image datasets and the conclusion itself flags that catching facial expression changes in continuous or dynamic images is left to future work.
- Although the paper motivates the work by security applications such as preventing robbery or fights, no security-context evaluation, deployment trial, or false-alarm analysis is conducted.
- Demographic breakdown of accuracy across the skewed CK+ population (35:65 men to women, 15% African-American, 3% Asian or Latino) and the all-Japanese-women JAFFE set is not reported.
