---
luhmannId: 1bb
title: IAT 序列的隐马尔可夫建呼呼
status: ATOMIC
tags:
  - 概率模型
created: 2026-01-20T00:00:00.000Z
updated: '2026-04-23'
---

# IAT 序列的隐马尔可夫建模

将 IAT 序列建模为 HMM 的优势在于：能显式表达"应用内部状态切换"这一直觉。例如视频流的 buffer 充盈/枯竭就是两个隐状态。

实验中发现，三状态 HMM 已经能区分大多数主流应用，但对加密 VPN 隧道下的多路复用场景失效。这指向需要更复杂的 HSMM 或层次 HMM。
