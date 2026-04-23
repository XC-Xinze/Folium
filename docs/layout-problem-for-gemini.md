# Zettelkasten Card System —— 节点布局问题（给前端设计师/Gemini）

## 1. 项目背景

我在做一个卢曼卡片盒（Zettelkasten）笔记工具。核心 UI 是一个 **React Flow 2D 画布**，每个节点是一张完整可读的卡片（约 340×380 px，包含标题、Markdown 正文、tags）。

**核心理念**：每张卡有一个"卢曼编号"（如 `1, 1a, 1a1, 1b, i1, i2`），编号本身编码了思想发展链——`1a` 是 `1` 的延伸，`1a1` 又是 `1a` 的延伸。位置即语义，不是简单的目录树。

## 2. 技术栈

- React 18 + TypeScript + Vite
- React Flow (xyflow) v12 —— 提供画布、缩放、拖拽
- 已装 dagre 用于树形布局
- 可以加 d3-force 等其它布局库
- Tailwind CSS

## 3. 数据模型

### 卡片
```ts
interface Card {
  luhmannId: string;       // "1", "1a", "1a1", "i1" 等
  title: string;
  status: 'ATOMIC' | 'INDEX';  // INDEX 是索引卡（目录性质）
  contentMd: string;
  tags: string[];          // 已小写化
  crossLinks: string[];    // 手动 [[link]] 到其他卡的 luhmannId
  parentId: string | null; // 从 luhmannId 推导：1a 的 parent 是 1
  sortKey: string;         // 用于排序，按段编码：1a 的 sortKey 是 "n000001|aa"
  depth: number;           // luhmannId 段数
}
```

### 节点变体
- `focus`：当前焦点卡（视觉最突出，黑边）
- `tree`：和焦点同一棵树/索引下的卡（白底灰边）
- `potential`：系统推断的潜在相关卡（半透明虚线）

### 边的种类
4 种关系，颜色和语义不同：

| 种类 | 含义 | 颜色 |
|---|---|---|
| `tree` | Folgezettel 父子关系 (`1` → `1a`) 或 INDEX → 引用 | 灰色实线 #9ca3af |
| `cross` | 用户手动 `[[link]]` 跨主题引用 | 紫色实线 #7c4dff |
| `tag` | 共享 tag（涌现的"化学反应"），带 `#tag` 标签 | 绿色实线 #10b981 |
| `potential` | 文本相似度推断（FTS5 BM25 + 标题/编号在他人正文出现） | 灰色虚线 #cbd5e1 |

## 4. 当前布局算法（有问题）

文件：`packages/frontend/src/lib/cardGraph.ts`

**两种焦点模式**：

### A. 焦点是 ATOMIC 卡
1. 沿 `parentId` 链上推到 Folgezettel 根
2. 收集这棵树的所有节点（同一 luhmannId 前缀）
3. 用 dagre TB 布局
4. tag/cross/potential 引来的卡作为 orphan

### B. 焦点是 INDEX 卡
1. 焦点作为根
2. 递归展开它通过 `[[link]]` 引用的所有卡
3. 兄弟按 sortKey 排序
4. 用 dagre TB 布局

**当前算法的问题**：

之前尝试过：
- ❌ orphan 排成右侧一列 → 边从 focused 底部绕到右侧节点顶部，路径乱
- ❌ orphan 扇形展开（围绕 focused 弧形分布）→ 不符合"自上而下"的直觉
- ❌ orphan 全部当 focused 的 children 加入 dagre TB → 直接子节点和 orphan 混在一行，焦点下方挤一堆，分不清结构 vs 关联

## 5. 用户痛点（产品负责人原话）

> 我看了下新的，我发现你把大部分的卡片都放到了根节点的下方，其实这样还不如方案 B（力导向）

> 同高度会导致线条乱七八糟的重叠
> 我希望他们应该像是树一样的扩张形式
> potential 应该跟有关联的卡片在一块，或者说附近，而不是强制的移动到别的地方放着，看着线条乱七八糟的

> 主体应该是当前焦点 + 同一子分类（Folgezettel 子树/INDEX 引用）的卡片
> potential 应该分置在最外侧或者应该在被关联的卡片附近

> 排序就按照序号排就好了

## 6. 期望的视觉效果

### 硬性需求
1. **节点不重叠**（每张卡 ≈ 340×380 px）
2. **边不交叉/少交叉**
3. **Folgezettel 层级感清晰**：父在上、子在下，按 sortKey 横向排序
4. **focused 视觉居中**，是注意力焦点
5. **不同关系类型视觉可区分**（不只是颜色，位置也要有意义）

### 期望的语义层次
```
              [parent (Folgezettel 父)]
                       │
              ┌────────┼────────┐
            [focused]            (focused 是焦点)
            /  │  \
        [c1] [c2] [c3]  (Folgezettel 子，按 sortKey 排)
                            ↘
                      ─── 主体到此 ───
                      
                      ─── 关联区域 ───
        [tag-rel1] [tag-rel2]   ← 共主题（绿）
        [cross-rel1]            ← 手动 link（紫）
                [potential1]    ← 潜在（虚线，更外侧/更下）
```

或者：
- **主体（focused + 同一子分类）居中**
- **关联节点（tag/cross）在主体的"外围"**
- **potential 在最外圈**

但**不能丢失 Folgezettel 的层级感**——这是产品灵魂。

### 可借鉴的灵感
- Obsidian Graph View 的力导向（节点不重叠、有机感）
- 但 Obsidian 完全失去了层级——我们不能这样
- 需要一种 **混合**：层级硬约束 + 力导向避免重叠

## 7. 我已经考虑过的方案

### 方案 A：纯 dagre TB
- ✅ 层级清晰
- ❌ orphan 不知道往哪放，怎么放都乱

### 方案 B：dagre + d3-force 混合
- 用 d3-force：
  - **charge**: 节点互相排斥
  - **link**: 边作为弹簧
  - **collision**: 防直接重叠
  - **forceY**: Y 坐标硬约束（按 Folgezettel 深度）
  - **forceX**: 轻微向心
- 初始位置用 dagre 算
- ✅ 不重叠
- ✅ 保留层级
- ⚠️ 非确定性（每次刷新位置可能不同）

### 方案 C：纯力导向（Obsidian 模式）
- ❌ 丢掉 Folgezettel 层级，不可接受

### 方案 D：自己写 Reingold-Tilford 树布局
- 经典层次树算法
- 但 orphan 节点（非 Folgezettel 关系）无法自然纳入

## 8. 给设计师的具体问题

请基于 React Flow + 任意布局库，设计一个方案能同时满足：

1. **节点之间不重叠**
2. **Folgezettel 父子关系视觉上呈现为"上下层级"**
3. **同 sortKey 排序的兄弟节点横向排开**
4. **tag/cross/potential 关联卡片：和焦点距离合理**（不要塞到顶部，不要挤进 Folgezettel 子节点里），位置可以暗示关系类型（比如 potential 更远/更暗）
5. **边路径不交叉或少交叉**
6. **位置最好稳定**（同样的数据 → 同样的位置，便于用户记忆）

请给出：
- 用什么算法/库
- 节点位置的计算逻辑（伪代码或具体代码）
- 如何让 React Flow 使用这个布局
- 边的 source/target handle 应该怎么设置（React Flow 节点已有 top/bottom/left/right 4 个连接点）

## 9. 涉及到的关键文件

- `packages/frontend/src/lib/cardGraph.ts` —— 当前布局逻辑（包含 dagre 调用）
- `packages/frontend/src/components/Canvas.tsx` —— React Flow 渲染
- `packages/frontend/src/components/CardNode.tsx` —— 单张卡片节点（有 6 个 Handle）

## 10. 数据示例（example-vault 里的真实数据）

- 6 张 Folgezettel 卡：`1, 1a, 1a1, 1a2, 1b, 1b1, 3b`
- 3 张 INDEX 卡：
  - `i0 总索引` → 引用 `i1, i2`
  - `i1 索引：加密流量研究` → 引用 `1, 1a, 1a1, 1a2, 1b, 1b1, 3b`
  - `i2 索引：方法论` → 引用 `3b, 1a2`
- tags: `ml, svm, traffic, timing, hmm, methodology` 等

**典型场景 1**: 焦点 = `1a`
- 应该看到：`1`（父）→ `1a` 焦点 → `1a1, 1a2`（子）
- 旁边还有 `3b`（cross-link）、共享 #ml 的 `1a1, 1a2, 3b`、potential 推断的几张

**典型场景 2**: 焦点 = `i1`（INDEX）
- 应该看到：`i1` 在顶，下面挂 `1, 1a, 1a1, 1a2, 1b, 1b1, 3b`
- 这 7 张卡之间也有 Folgezettel 关系——是否要展示？设计师决定

**典型场景 3**: 焦点 = `i0`（总索引）
- 应该看到：`i0` 在顶，下面 `i1, i2` 两个子索引
- i1 和 i2 是否要继续展开？设计师决定
