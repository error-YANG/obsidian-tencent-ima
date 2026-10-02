# IMA 知识库同步 · Obsidian 插件

在 Obsidian 本地 vault 与 **腾讯 IMA** 知识库之间做双向同步 —— 基于 IMA 官方 OpenAPI，全部在本地运行，不经过任何第三方中转服务器。

| 项 | 值 |
| --- | --- |
| 插件 id | `tencent-ima-sync` |
| 当前版本 | `0.7.0` |
| 最低 Obsidian 版本 | `1.5.0` |
| 平台 | 仅桌面端（Windows / macOS / Linux） |
| 许可证 | MIT © 2026 杨宇轩（YangYuXuan） |

## 功能

| 能力 | 说明 |
| --- | --- |
| 双向同步 | 上传（本地 → 知识库）与拉取（知识库 → 本地）可分别开关 |
| 同步规则 | 按「本地目录 ↔ 知识库」建多条规则，方向可选上传 / 拉取，支持定时 |
| 拉取绝不覆盖本地 | 同名文件内容不一致时判为**冲突并跳过**，本地修改永不被覆盖 |
| 同名编号保护 | 上传遇到同名文件自动编号：`A.pdf` 被占用 → `A(1).pdf` → `A(2).pdf` |
| 增量同步 | md 文本比对、其它类型二进制 SHA-256 哈希比对，未变即跳过 |
| 运行锁可观测 | 任务在跑时再点同步，提示「已运行 X 分 Y 秒，当前：拉取中 12/31 xxx.pdf」，而不是一句干巴巴的"上一次任务还没结束" |
| 看门狗 + 强制解锁 | 无活动 10 分钟弹一次告警、45 分钟判定卡死并自动释放锁；命令面板提供 `Force unlock` 手动解锁，留证写入 `data.json` 的 `lastWatchdog` |
| 本地 I/O 超时 | vault 读写与设置落盘统一 60 秒超时，避免同步盘 / 杀软 / 文件锁把插件永久卡住 |
| 大文件支持 | 流式上传下载，PDF / Word / PPT / 音频单文件上限 200MB |
| 可复核留痕 | 最近 10 次运行的条目数、新增 / 跳过 / 冲突 / 失败数写入 `data.json` 的 `runHistory` |

### 支持拉取的文件类型

| 类型 | 单文件上限 |
| --- | --- |
| PDF / Word / PPT / 音频 | 200 MB |
| EPUB | 50 MB |
| 图片 | 30 MB |
| Excel·CSV / Markdown / TXT / Xmind / HTML | 10 MB |

知识库里的「网址 / 公众号文章 / 笔记条目 / 文件夹」没有可下载的文件，不参与拉取 —— 所以知识库列表的条数通常大于本地文件数。

> **看不到 .txt / .ppt？** Obsidian 文件列表默认不显示"不支持的扩展名"。打开 `设置 → 文件与链接 → 检测所有文件扩展名` 即可看到（双击由系统默认程序打开，Obsidian 自身不预览 PPT）。

## 安装（手动）

1. 从 [Releases](https://github.com/error-YANG/obsidian-tencent-ima/releases) 下载最新版的 `main.js`、`manifest.json`、`versions.json`；
2. 放进 `<vault>/.obsidian/plugins/tencent-ima-sync/`（目录名必须与插件 id 一致），使该目录下**直接**是 `main.js`、`manifest.json`；
3. 重启 Obsidian → `设置 → 第三方插件` → 启用 **IMA知识库同步**。

## 配置

1. 在腾讯 IMA 开放平台申请 OpenAPI 凭据，取得 **Client ID** 与 **API Key**；
2. 插件设置里填入这两项，点「测试」（会验证凭据并顺带拉取知识库列表）；
3. 在「同步规则」中添加规则：本地目录 + 目标知识库 + 方向（上传 / 拉取）；
4. 点左侧竖栏的「杨」图标（或右下角状态栏的 `杨 ⇅` 按钮），也可以在命令面板执行 `Sync` 开始同步。

> ⚠️ **`data.json` 会明文保存 API Key。** 请勿把 vault（尤其 `.obsidian/` 目录）推送到公开仓库；本仓库的 `.gitignore` 已默认忽略 `data.json`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `Sync` | 按同步规则顺序执行双向同步 |
| `Push now` | 按规则上传到知识库 |
| `Push current note` | 只上传当前笔记 |
| `Force re-push all` | 忽略本地记录，全部重新上传 |
| `Pull from IMA` | 拉取知识库笔记 / 文件到本地 |
| `Force unlock` | 运行锁卡死时强制释放（留证到 `lastWatchdog`） |

## 数据与隐私

- 凭据与同步状态**只存在本地** `data.json`；插件只直连 IMA 官方接口。
- `fileStates` 中保存的是内容哈希（SHA-256）与远端 mediaId，不含文件内容。
- 拉取落地时若同名文件已存在且内容不同，判为冲突并跳过，绝不覆盖本地版本。

## 仓库结构

```
main.js          # 插件全部逻辑（单文件，无构建步骤）
manifest.json    # 插件元信息（Obsidian 读取）
versions.json    # 版本 ↔ 最低 Obsidian 版本映射
CHANGELOG.md     # 变更日志（逐条记录改动与验证方式）
LICENSE          # MIT
```

## 版本与变更

见 [CHANGELOG.md](CHANGELOG.md)。当前 `0.7.0` 包含：拉取目录递归修复、二进制增量判定补内容因子（VULN-03）、运行锁可观测性与兜底（看门狗 / 强制解锁 / 本地 I/O 超时）。

## 开发

单文件 `main.js`，改完做两件事：

```bash
node --check main.js          # 语法自检
```

然后在 Obsidian 里**重载插件**（设置里关闭再开启，或重启 Obsidian）—— `main.js` 不热重载。控制台出现 `[ima-sync] loaded v0.7.0 (...)` 即说明新代码已生效。

## 免责声明

本项目为非官方的第三方插件，与腾讯公司无隶属关系。使用 IMA OpenAPI 时请遵守腾讯的相关服务条款；同步前建议先备份 vault。

## 许可证

[MIT](LICENSE) © 2026 杨宇轩（YangYuXuan）
