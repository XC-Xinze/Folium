---
luhmannId: d1a
title: RBF 核函数优化
status: ATOMIC
tags:
  - SVM
  - ML
crossLinks:
  - d1
created: 2026-01-17T00:00:00.000Z
updated: '2026-04-23'
---

# RBF 核函数优化

为了缓解线性不可分问题，我们引入 RBF（Radial Basis Function）核函数将特征映射到隐式高维空间。这本质上是把"维度灾难"反向利用——既然高维难以降维，干脆构造更高维使其线性可分。

代价是：核矩阵计算复杂度为 O(n²)，对大规模流量数据集是显著瓶颈。需要结合 Nyström 近似或随机傅里叶特征。

参见 [[d1]] 关于核方法在其他领域的对照。
