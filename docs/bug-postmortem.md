# Bug Postmortem — 本会话内 Claude 写出的 bug 汇总

按"模式 / 教训"归类。每条都给出**症状**、**根因**、**修法**和"**下次写代码前问自己**"。

---

## 1. 缓存与 React Query

### 1.1 在 useState 里缓存远程数据，从此不再 refetch

**症状**：tag 改名/删除后，画布上卡片的 tag footer 不更新；refresh 也没反应（在缓存层面）。

**根因**：`CardNode` 用 `useState<Card | null>` + `useEffect` 一次性 fetch 卡片内容，加载后存进组件本地 state，永远不再发请求。`qc.invalidateQueries({queryKey: ['card', id]})` 没有任何订阅者去消费它。

```ts
// 错的
const [full, setFull] = useState<Card | null>(...);
useEffect(() => {
  if (full) return;        // ← 一旦加载，永远不再 fetch
  api.getCard(id).then(setFull);
}, [id, full]);
```

**修法**：用 `useQuery` 订阅 query key，invalidate 时自动 refetch。

```ts
const fullQ = useQuery({ queryKey: ['card', id], queryFn: () => api.getCard(id) });
const full = fullQ.data;
```

**问自己**：
- 这个数据可能被外部操作改变吗（mutation / 后端 push）？是的话必须用 useQuery，不要用 useState 缓存。
- 如果其他地方调了 `qc.invalidateQueries({queryKey: ['x']})`，谁是 ['x'] 的订阅者？没人订阅就等于没失效。

---

### 1.2 `initialData` 抑制 refetch；要用 `placeholderData`

**症状**：传了 `initialData` 给 useQuery，invalidate 后没 refetch（v5 某些场景）。

**根因**：`initialData` 被当成"已经成功 fetch 过的真数据"塞进 cache，会被认为是新鲜的。`placeholderData` 只是首屏占位，真数据回来时正常覆盖。

```ts
// 错（首屏给了占位但抑制了 refetch）
useQuery({ ..., initialData: card });

// 对（首屏给占位 + 不影响 refetch 行为）
useQuery({ ..., placeholderData: card });
```

**问自己**：你只是想"首屏不要白屏"还是"我已经有真数据，不需要再请求"？前者用 `placeholderData`，后者用 `initialData`。

---

### 1.3 默认 `staleTime` 太大让 invalidate 无效

**症状**：`qc.invalidateQueries({...})` 被调用了但 query 没重发。

**根因**：QueryClient 默认 `staleTime: 30_000`。在 v5 某些边界情况，stale 时间内的 query 即使 invalidate 也不一定立即 refetch。

**修法**：mutation 改 vault 文件这种场景，必须立即可见——`staleTime: 0`。或者用 `qc.refetchQueries()` 强制重发，比 `invalidate` 更稳。

**问自己**：app 里有没有 mutation 会改后端的 ground truth（vault 文件、DB）？有的话默认 `staleTime` 必须是 0。

---

### 1.4 Mutation onSuccess 只 invalidate 了"明显"的 query key，漏了下游

**症状**：apply 边 / 改卡片 / 删 tag 后，主画布没反应。

**根因**：mutation 改了一张卡的 .md 文件 → 影响的不只是 `['cards']`（summary 列表），还有 `['card', id]`（单卡完整内容）、`['linked', id]`、`['related-batch']`、`['referenced-from']`、`['tag-cards']`。只 invalidate 一个会让其他视图持续 stale。

**修法**：抽个 `invalidateAfterX()` helper，一次清掉所有可能受影响的 key 前缀。

```ts
const invalidateAfterTagOp = async () => {
  await Promise.all([
    qc.refetchQueries({ queryKey: ['tags'] }),
    qc.refetchQueries({ queryKey: ['cards'] }),
    qc.refetchQueries({ queryKey: ['card'] }),
    qc.refetchQueries({ queryKey: ['linked'] }),
    qc.refetchQueries({ queryKey: ['related-batch'] }),
    qc.refetchQueries({ queryKey: ['referenced-from'] }),
    qc.refetchQueries({ queryKey: ['tag-cards'] }),
  ]);
};
```

**问自己**：这个 mutation 改了**什么数据**？整个 app 里有几种 query key 用了这种数据？全部列出来一起 refetch。

---

### 1.5 Mutation 没有 `onError`，错误被静默吞掉

**症状**：用户点按钮"没反应"，console 也没错——其实是接口返回 4xx 但 mutation 默默吃了。

**修法**：mutation 都加 `onError`：

```ts
useMutation({
  mutationFn: () => api.foo(),
  onSuccess: ...,
  onError: (err: Error) => dialog.alert(err.message, { title: 'Foo failed' }),
});
```

或者用 `mutateAsync` + try/catch。

**问自己**：每个 mutation 失败时用户能看到吗？能定位原因吗？

---

## 2. 正则与字符串

### 2.1 `\b` 词边界对 CJK 失效

**症状**：tag delete/rename 对 `#牛逼` 这种纯中文 tag 完全不工作（`filesUpdated: 0`）。

**根因**：`\b` 需要 word 字符（`\w` = `[A-Za-z0-9_]`）和非 word 字符之间的边界。CJK 算非 word，相邻非 word 之间没有 word boundary。

```ts
// 错：#牛逼 末尾是 CJK，后面是空白/EOF（也是非 word），没有 \b
new RegExp(`#${tag}\\b`);

// 对：用 lookahead 显式排除 tag 字符
new RegExp(`#${tag}(?![一-龥\\w-])`);
```

更通用的方案（同时支持 ASCII 短语像 "C++" 和 CJK）：

```ts
function countUnlinkedHits(body: string, phrase: string): number {
  if (phrase.length < 2) return 0;
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isAscii = /^[\x00-\x7F]+$/.test(phrase);
  if (!isAscii) return (body.match(new RegExp(escaped, 'g')) || []).length;
  // ASCII：只在 phrase 真的以 word 字符开头/结尾时才加 \b
  const prefix = /^\w/.test(phrase) ? '\\b' : '';
  const suffix = /\w$/.test(phrase) ? '\\b' : '';
  return (body.match(new RegExp(`${prefix}${escaped}${suffix}`, 'gi')) || []).length;
}
```

**问自己**：这个正则会用在中文 / 日文 / 韩文 / 数字开头 / 标点结尾的字符串上吗？任何不是 `\w` 范畴的字符都不能用 `\b`。

---

### 2.2 字符类里塞了多字母英文连接词

**症状**：标题切片函数 `titleKeywords("Active Learning")` 返回 `['A','c','t','i','v','e',...]` 而不是 `['Active', 'Learning']`。

**根因**：

```ts
// 错：[vs and or with] 在 character class 里被当成单个字母的集合
title.split(/[、，。\s vs and or with]+/);
```

**修法**：先用整词替换把英文连接词换成分隔符，再切：

```ts
const SEP = '';
const cleaned = title.replace(/\b(?:vs|and|or|with)\b/gi, SEP);
const parts = cleaned.split(/[、，。\s]+/).filter(p => p.length >= 2);
```

**问自己**：character class 里写多字母字符串纯属误解 regex 语法。看到 `[abc xyz]` 这种就警觉。

---

### 2.3 在动态生成的 HTML 注释里写 `-->`

**症状**：apply 一条 card→temp 边后，源卡片正文里出现"幽灵"文字"from workspace X"，看起来像有张卡复制了一份。

**根因**：

```ts
const marker = `<!-- ws:${wsId}:${edgeId} pending:${tempId} --> 🔗 from workspace "${name}"`;
//                                                          ↑ 这里 --> 提前关闭了 HTML 注释
```

**修法**：要么把整段都包在注释内（避免出现 `-->`），要么用其他分隔符：

```ts
const marker = `<!-- ws:${wsId}:${edgeId} pending:${tempId} from workspace "${name}" -->`;
```

**问自己**：动态拼接的字符串里有没有可能意外形成边界字符？HTML 的 `-->`、Markdown 的 ``` `` ```、JSON 的 `"`、URL 里的 `#`/`?` 都是常见陷阱。

---

## 3. 文件系统 / 异步状态

### 3.1 `chokidar` 的 `awaitWriteFinish` 让"刚写的文件"在毫秒级内不可见

**症状**：apply edge 后立即 refetch 卡片，看到的是 stale 数据。

**根因**：chokidar 配了 `awaitWriteFinish: { stabilityThreshold: 200 }`——文件写完后要等 200ms 稳定才发 `change` 事件。期间 in-memory repo 没更新。但前端 mutation 的 onSuccess 立刻 invalidate + refetch，赢了 race。

**修法**：在 service 函数里 `writeFile` 之后**同步** parse + upsert，不依赖 chokidar：

```ts
async function reindexFile(repo: CardRepository, filePath: string) {
  const card = await parseCardFile(filePath);
  if (card) repo.upsertOne(card);  // 立即生效，watcher 之后也会跑一次（幂等）
}

// 用法
await writeFile(card.filePath, newContent);
await reindexFile(repo, card.filePath);
```

**问自己**：写完文件之后用户能立刻看到结果吗？依赖 watcher 的话有延迟，必须自己同步入库。

---

### 3.2 DB 跟磁盘脱节

**症状**：`/api/tags` 返回 `牛逼`，但找不到任何文件含这个 tag——即 DB 有这条 row，但所有文件 frontmatter 都没有。

**根因**：解析器从正文 `#tag` 也提取 inline tag 进 `card_tags`。frontmatter 里没有不代表 DB 里没有。

**修法**：DB 是文件的衍生缓存——任何"清理 tag"的操作必须**同时改文件和 DB**。具体：扫所有文件改正文里的 `#tag` 标记，然后再次 parse + upsert（upsertOne 会 DELETE 旧 card_tags 再 INSERT 新的）。

**问自己**：DB 的内容是从哪里推导出来的？要清理 DB 必须先清理那个数据源。

---

### 3.3 SQL `LEFT JOIN` 主表导致幽灵孤儿

**症状**：rename 一个 tag 后，旧 tag 还在列表里（count=0）；delete 一个 tag 后，chip 不消失。

**根因**：

```sql
-- 错：tags 主表里的旧名永不清理
SELECT t.name, COUNT(ct.luhmann_id) AS count
FROM tags t LEFT JOIN card_tags ct ON ct.tag = t.name
GROUP BY t.name;

-- 对：直接从实际使用关系聚合，没人用的 tag 自然不出现
SELECT tag AS name, COUNT(*) AS count
FROM card_tags GROUP BY tag;
```

**问自己**：聚合 query 是从"主表 + 关系表"还是从"关系表本身"？如果主表本身没有清理逻辑，永远要从关系表聚合。

---

## 4. React / DOM

### 4.1 在内部 onClick 里 `e.stopPropagation()` 阻止了 React Flow 的选中状态

**症状**：CardNode 的 NodeResizer 用 `isVisible={selected}`，但 selected 永远 false。

**根因**：CardNode 外层 onClick 里 `e.stopPropagation()` 防止 React Flow 接收到点击事件 → 节点选中状态永远不被设置。

**修法**：要么去掉 stopPropagation，要么用 `hovered` 状态替代 `selected`，要么用 React Flow 的 `useStore` 直接读选中状态。

**问自己**：我 stopPropagation 是为了什么？阻止的是哪个父级的 handler？这个父级有没有合法需要这个事件（如 React Flow 的选中、Konva 的 hit-test 等）？

---

### 4.2 内联 `style` 硬编码尺寸覆盖了 NodeResizer 的实时改动

**症状**：拖 NodeResizer 把手没反应，卡片不变大。

**根因**：

```tsx
<div style={{ width: savedW, height: savedH }}>  // ← 锁死了
  <NodeResizer onResize={(_, params) => {
    // 这里 params.width 改了但没人用
  }} />
</div>
```

**修法**：用 local state 跟随 onResize，松手时持久化到后端：

```tsx
const [w, setW] = useState(savedW);
const [h, setH] = useState(savedH);
<div style={{ width: w, height: h }}>
  <NodeResizer
    onResize={(_, p) => { setW(p.width); setH(p.height); }}
    onResizeEnd={(_, p) => api.setSize(scope, id, p.width, p.height)}
  />
</div>
```

**问自己**：组件库的"实时尺寸/位置/值"事件，我用什么状态承接？写死在 prop 里相当于禁用了它。

---

### 4.3 一个组件的 `onBlur=commit` 让其他兄弟元素无法获得焦点

**症状**：编辑临时卡时，textarea 自动聚焦，点击标题 input → 编辑模式马上退出，input 拿不到焦点。

**根因**：textarea 的 `onBlur={commit}` 在用户点 input 时立即触发 → `setEditing(false)` → 整个编辑表单卸载 → input 没机会聚焦。

**修法**：把 commit 移到**包裹整个表单的容器**的 onBlur，用 `currentTarget.contains(relatedTarget)` 过滤掉容器内部移动：

```tsx
<div onBlur={(e) => {
  if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;  // 焦点还在容器内
  commit();
}}>
  <input ... />
  <textarea ... />
</div>
```

**问自己**：这个组件失焦应该 commit，但用户可能想切到隔壁兄弟字段——我的失焦逻辑是按"单元素失焦"还是"整组失焦"？

---

### 4.4 React Flow 的 onConnect 默认丢失 handle 信息

**症状**：用户在 workspace 拖一条边，连出来后视觉位置不对、有时甚至看不见。

**根因**：

```ts
const onConnect = (conn) => {
  setEdges([...edges, { id, source: conn.source, target: conn.target }]);
  // ↑ 漏了 sourceHandle 和 targetHandle，React Flow 自己猜 handle 经常猜错
};
```

**修法**：

```ts
setEdges([...edges, {
  id, source: conn.source, target: conn.target,
  sourceHandle: conn.sourceHandle,
  targetHandle: conn.targetHandle,
}]);
```

后端持久化结构里也得加 `sourceHandle / targetHandle` 字段。

**问自己**：onConnect 的 Connection 对象有 4 个关键字段（source/sourceHandle/target/targetHandle），我有没有都接住？

---

## 5. 业务逻辑 / 状态同步

### 5.1 ATOMIC 卡找不到 primary box 时只 setFocus 不动 box

**症状**：daily 卡或 orphan 卡（没被任何 INDEX 引用）点击后从画布"消失"。

**根因**：

```ts
if (primary) {
  setBoxAndFocus(primary, id);
} else {
  setFocus(id);  // ← 只改 focusedCardId，focusedBoxId 还停在旧值
                 // 旧 box 的 backbone 不包含这张新焦点卡 → 画布渲染不出来
}
```

**修法**：孤儿卡用自己当根 box：

```ts
if (primary) setBoxAndFocus(primary, id);
else setBoxAndFocus(id, id);  // self-as-box
```

**问自己**：导航到一张卡时，"卡所属的 box"是什么？如果没有现成 box，必须给个兜底（自己当 box / 创建虚拟 box / 拒绝导航）。

---

### 5.2 cardGraph 跳过 backbone 内部已存在的节点时把边也跳过了

**症状**：focus 一张卡 X，X 的 potential 都是 backbone 内其他卡，结果灰虚线一条都不画。

**根因**：

```ts
for (const p of rel.potential) {
  if (backbone.ids.has(p.luhmannId)) continue;  // 跳过整条，包括 edge
  if (rawNodes.has(p.luhmannId)) continue;
  addNode(p.luhmannId, 'potential');
  rawEdges.push({...edge...});
}
```

**修法**：去重的是**节点**，不是**边**。把 continue 拆开：

```ts
for (const p of rel.potential) {
  // 优先级更硬的边已存在 → 跳过整条
  if (pairHasTree(id, p.luhmannId) || pairHasEdge(id, p.luhmannId, ['cross', 'tag'])) continue;
  if (pairHasEdge(id, p.luhmannId, ['potential'])) continue; // 同种重复
  if (!rawNodes.has(p.luhmannId)) addNode(p.luhmannId, 'potential');  // 节点不在才加
  rawEdges.push({...edge...});  // 边总是加
}
```

**问自己**：去重时，我是去重"节点"还是"边"还是"对"？三者逻辑不同，混在一起 continue 容易吃掉合法情况。

---

### 5.3 把数据存到错的字段（visible vs invisible）

**症状**：apply 一条 card→temp 边后，源卡片正文里出现像是"复制卡"的视觉污染。

**根因**：把"deferred 应用"的元数据写进了源卡片的**正文**（作为 placeholder 文字），而它本应该只存在于 workspace metadata 里。

**修法**：分清楚什么数据应该写哪里：
- 写入 .md 文件 = 永久 + Obsidian 可见 + git diff 体现
- 写入 .zettel/ 下的 sidecar JSON = 工具内部状态，不污染 vault
- 仅 React Query cache = 跨组件共享但不持久

**问自己**：这条数据用户想在 Obsidian 里看到吗？应该 commit 进 git 吗？另一个 vault 用户该收到吗？三个问题决定了存哪。

---

## 6. UI / UX

### 6.1 用 `group-hover/named:opacity-100` 把按钮藏起来后用户找不到

**症状**：tag 删除按钮在 chip 上 hover 才显示——某些 hover 状态不触发 / 触屏环境直接看不到。

**修法**：删除这种"破坏性"按钮要不就常驻显示，要不就放右键菜单 / 长按。不要全靠 CSS hover。

**问自己**：这个交互在触屏 / 键盘导航 / 快速点击场景下能用吗？

---

### 6.2 Sidebar 同时显示 INDEXES 树 + ALL CARDS 平铺，重复占地方

**症状**：用户抱怨"一份卡片在两个地方都显示"。

**修法**：相同数据不要在两个 section 里展示。重新切分：
- INDEXES（有归属的卡）
- ORPHANS（没有归属的卡）
- 特殊类型（DAILY / STARRED）单独开区

**问自己**：每个 section 是按"什么维度"切的？维度之间正交吗？

---

### 6.3 创建新卡片没有显式标题字段，靠"取正文首行"反人类

**症状**：用户问"标题在哪输入？"——既有的设计是从正文第一行自动推。

**修法**：显式标题 input 必须有，"自动取首行"作为兜底（标题留空时启用）。

**问自己**：非显式 = 用户必须脑补内部规则。能显式的字段就显式，自动推导只作 fallback。

---

### 6.4 复杂 ID 暴露给用户输入

**症状**：用户面对 `id` 这个字段不知道写啥。

**修法**：自动算下一个可用 id（focused 卡的下一个 child / 顶层最大数字 + 1），显示成"Save as: 1aa ✎"胶囊。点击才允许手改。

**问自己**：这个字段用户能立刻填出合理值吗？答案是"不能"就给个智能默认 + 可覆盖。

---

## 7. 测试 / 验证

### 7.1 改了核心 service 没写测试，回归 bug 难发现

**修法**：把"易回归"的 pure function 都加测试：
- 编号/路径解析
- 字符串切片 / 关键词提取
- 布局算法的纯计算部分
- 碰撞检测

vitest 装在 root，配 `vitest.config.ts` 扫 `packages/*/src/**/*.test.ts`，npm test 跑全部。**写一次测试胜过三次手动测**。

---

## 8. 调试方法论

### 8.1 看到"前端没反应"先验证后端

1. `curl` 直接打接口
2. 看返回值（`filesUpdated: N`、`{ok: true}`、错误码）
3. 如果后端正确 → 前端缓存/状态问题
4. 如果后端错误 → 后端 bug

**别一上来就改前端**——70% 的"前端没反应"实际是后端问题。

### 8.2 加 console.log 定位是哪一步坏的

把"用户报 bug"翻译成"哪一行 console.log 出现 / 没出现"：
- 点击没出 → 事件没触发，CSS / 父级 stopPropagation
- 点击出了，结果没出 → handler 内部异常
- 结果出了，UI 没变 → 缓存 / 渲染问题

排查完记得删掉 log。

### 8.3 DB / 文件 / 内存 三处不一致时

1. 看文件（ground truth）
2. 看 DB（衍生缓存）
3. 看内存 cache（前端 / 后端）
4. 找出从哪一层开始不一致——bug 就在那一层和上一层之间

---

## 模式速查

| 症状 | 第一反应 |
|---|---|
| "改完没反应" | 1️⃣ curl 验证后端 → 2️⃣ 检查 invalidate 列表 → 3️⃣ 看是不是 useState 缓存了 |
| "点了没弹窗" | 1️⃣ console.log 看 click 事件 → 2️⃣ 检查 onError → 3️⃣ 检查 stopPropagation |
| "中文/特殊字符不工作" | 检查正则是不是 `\b` / 字符类乱塞多字符 |
| "幽灵卡片/标签/边" | DB ↔ 文件不同步；从关系表聚合不要从主表 LEFT JOIN |
| "拖动/编辑/选中失效" | inline style 锁死了 / event 被 stopPropagation 吃了 |
| "应该出现但没出现" | continue 太激进，把节点和边一起跳过了 |

---

## 写代码前的 9 问

1. 这数据可能被外部改吗？→ useQuery 不要 useState
2. 这个 mutation 影响哪些 query key？→ 全列出来 invalidate
3. 这正则会处理 CJK 吗？→ 不要用 `\b`
4. 字符类里我塞了多字母字符串吗？→ 单个字符
5. 写文件后立刻读会得到新值吗？→ 同步 reindex
6. 失败时用户能看到吗？→ onError + dialog
7. 这条数据应该写进 .md 文件吗？还是 sidecar？还是只 cache？
8. 我 stopPropagation 是为了什么？父级有没有合法需要？
9. 这个字段用户能合理填出吗？不能就给智能默认。
