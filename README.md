# Zettelkasten Card

一个为深度研究者设计的卢曼卡片盒笔记系统。核心理念：**顺序服务于学习阶段，无序是知识构建的终极阶段**。

## 它不是什么

- 不是另一个 Obsidian 克隆（Obsidian 的双链是无序的，不利于学习阶段）
- 不是 Logseq 的块级大纲（讨厌强制 bullet）

## 它是什么

- 卡片以 Markdown 文件存储，**完全兼容 Obsidian Vault**
- 默认视图是**链式阅读**：打开一张卡片，下方依次铺开它链接的卡片完整正文
- **段落级反向引用**：知道是谁、在什么语境引用了你（Logseq 的优点）
- **潜在链接**以暗淡的视觉融入主流，被动发现而非主动检索
- SQLite + FTS5 提供全文检索与潜在链接计算（无 LLM）

## 技术栈

- 前端：Vite + React 18 + TypeScript + Tailwind + Framer Motion + TanStack Query + Zustand
- 后端：Node + Fastify 5 + better-sqlite3 + chokidar
- 存储：MD 文件（源） + SQLite（衍生索引）
- monorepo：npm workspaces

## 启动

```bash
npm install

# 开两个终端，或后台跑
npm run dev:backend     # http://127.0.0.1:8000
npm run dev:frontend    # http://localhost:5173
```

打开 http://localhost:5173 即可。

### 配置 Vault 路径

默认使用项目内 `example-vault/`。换成你自己的：

```bash
VAULT_PATH=~/MyZettelVault npm run dev:backend
```

## 项目结构

```
ZettelkastenCard/
├── packages/
│   ├── backend/        # Fastify API + SQLite 索引 + vault 监听
│   │   └── src/
│   │       ├── db/         # schema + connection
│   │       ├── vault/      # MD parser + scanner + watcher + repository
│   │       ├── services/   # links 计算（linked / referenced-from / potential）
│   │       ├── routes/     # HTTP 端点
│   │       └── hooks.ts    # 事件总线（插件扩展点）
│   └── frontend/       # Vite + React UI
│       └── src/
│           ├── components/ # Sidebar / ChainView / CardView / SettingsView
│           ├── lib/        # api 客户端、markdown 渲染、PluginRegistry
│           └── store/      # Zustand UI state
└── example-vault/      # 7 张样例卡片
```

## 卡片格式

```markdown
---
luhmannId: 1a
title: 维度灾难与特征选择器
status: ATOMIC          # ATOMIC | HUB
tags: [ML, TLS]
crossLinks: [1a1, 3b]   # 手动指定的关联卡片
---

正文中也可以用 [[1a1]] 或 [[标题]] 双链。
```

## 当前 MVP 完成的功能

- ✅ MD 文件扫描 + 解析 + frontmatter
- ✅ 卢曼编号自动派生 sortKey / parentId / depth
- ✅ 文件变更实时同步索引（chokidar）
- ✅ FTS5 全文索引
- ✅ 链式阅读视图 + Linked / Potential / ReferencedFrom 三段
- ✅ 潜在链接显示开关（关闭/仅标题/完整）
- ✅ Tags + Hubs 侧栏
- ✅ 设置页骨架
- ✅ 后端事件钩子（card:beforeSave 等）+ 前端 PluginRegistry 接口

## 路线图

- 卡片编辑器（当前是只读，编辑需直接改 .md 文件）
- Promote 提权 UI 操作（HUB 状态可手动切换）
- Graph View（语义缩放：放大到一定程度展开为完整内容）
- 插件 SDK V2（动态加载 ES module）
- 命令面板
