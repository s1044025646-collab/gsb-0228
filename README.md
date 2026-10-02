# RSS 订阅快照与文章更新追踪后端

本地运行的 RSS 2.0 阅读数据服务：导入同一订阅源先后导出的多份 XML 快照，维护文章列表、已读状态与内容修订历史。**只做 API 与 CLI**，不抓取网站、不提供网页界面、不兼容 Atom、不做推荐或全文搜索。

技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需原生编译）+ `fast-xml-parser`。仅依赖本机，不需要 Docker、WSL 或任何在线服务。

## 环境要求

- Node.js **>= 22.5**（使用内置 SQLite；在 Node 25 上验证通过；运行时会出现一次 `SQLite is an experimental feature` 警告，可忽略）
- Windows / macOS / Linux 均可，以下命令按 Windows PowerShell 给出

## 安装、构建、测试

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # node:test，13 个固定预期用例
npm run demo      # 三份连续快照的完整演示（自动重建 data/rss.db）
```

## 支持范围（RSS 2.0）

- 输入必须是合法 XML，根元素为 `<rss>`，含单个 `<channel>`。
- 使用的条目元素：`<guid>`、`<link>`、`<title>`、`<description>`、`<pubDate>`。
- 文本节点支持普通文本与 CDATA；属性一律忽略。
- 不解析 Atom、RSS 1.0/RDF、命名空间扩展或 `content:encoded`。
- 不发起任何网络请求，XML 只来自：项目/本地文件路径（CLI）或 HTTP 请求体（API）。

## 身份规则（核心）

同一订阅源（feed）内：

1. 优先使用非空 `<guid>` 作为稳定身份；
2. 无 `<guid>` 时使用非空 `<link>` 作为稳定身份；
3. 两者都缺失的条目不生成随机身份，而是进入导入报告的 `invalid` 列表（含索引、标题、原因）；
4. 身份仅在同一 feed 内比较，不同 feed 的相同 GUID 互不可见（跨源隔离）；
5. 同一份快照内身份重复的条目只取第一条，其余进入 `invalid`。

## 变更判定与修订

- 对标题、摘要、发布日期原始值做**空白规范化**（连续空白/换行/制表符合并为单个空格、去首尾空白），CDATA 写法差异不算内容变更。
- 对三元组 `{title, description, pubDate}` 计算 SHA-256 指纹：
  - 指纹相同 → `unchanged`，不写新修订；
  - 指纹不同 → 追加一条 `revisions`（revision_no 递增），报告中列出变化字段（`title` / `description` / `pubDate`）。
- 文章首次出现为 `added`。旧文章从后续快照消失时**保留本地记录与已读状态**，只把 `present` 置 0（默认列表不显示，查询 `present=false` 仍可见），不视为用户删除。
- 整个导入在单个 SQLite 事务内完成：快照原文、文章/修订变更、导入报告一起提交；坏 XML 在解析阶段即失败，已有数据不受影响。原始 XML 全文存入 `snapshots.raw_xml`，导入报告存入 `snapshots.report_json`。

## 日期策略与排序口径

- `pubDate` 按 RFC 822 解析（如 `Tue, 11 Feb 2025 10:00:00 GMT`），同时保存原始值与 ISO 值；
- 无法解析或缺失时标记 `pub_date_valid=0`、`pub_date_iso=NULL`，**不猜测、不使用导入时间顶替**；
- 文章列表排序为 `pub_date_iso` **升序，NULL（非法/缺失日期）排在最前**，再以 `article_id` 升序兜底，保证顺序确定、可复现。

## HTTP API

启动（默认端口 `0` = 由系统分配空闲端口，启动时打印实际端口；`--port` 可固定）：

```powershell
npm start                       # 等价 node dist/cli.js serve
node dist/cli.js serve --port 8080
```

仅监听 `127.0.0.1`。错误统一为 `{"error":{"code","message"}}`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/feeds` | 注册订阅源，JSON：`code`（1-64 位字母数字 `_-`）、`title`、`link?` |
| GET | `/feeds` | 订阅源列表（含文章数/已读数） |
| POST | `/feeds/{code}/import` | 导入快照；`Content-Type: application/xml|text/xml` 直接放 XML，或 `application/json` 传 `{"xml":"...","source":"..."}` |
| GET | `/feeds/{code}/articles` | 按源查文章，可选 `read=true|false`、`present=true|false` |
| GET | `/articles` | 全部文章，可选 `read=true|false` |
| GET | `/articles/{id}` | 文章详情 + 全部修订 |
| POST | `/articles/{id}/read` | 标记已读/未读，JSON：`{"read":true}` |
| GET | `/snapshots?feed={code}` | 快照列表（不含原文） |
| GET | `/snapshots/{id}/report` | 某次导入报告（新增/更新/未变/无效 + 身份依据） |
| GET | `/export?format=json|xml&feed={code}` | 导出 feeds/articles/revisions |

主要错误码：`INVALID_CODE`(400)、`MISSING_TITLE`(400)、`FEED_EXISTS`(409)、`FEED_NOT_FOUND`(404)、`MISSING_XML`(400)、`UNSUPPORTED_MEDIA_TYPE`(400)、`INVALID_XML`(422)、`INVALID_QUERY`(400)、`ARTICLE_NOT_FOUND`(404)、`SNAPSHOT_NOT_FOUND`(404)、`PAYLOAD_TOO_LARGE`(413)、`NOT_FOUND`(404)、`INTERNAL`(500)。

### curl 示例（PowerShell）

```powershell
curl.exe -X POST http://127.0.0.1:8080/feeds -H "Content-Type: application/json" -d '{\"code\":\"weekly\",\"title\":\"技术周刊\"}'
curl.exe -X POST http://127.0.0.1:8080/feeds/weekly/import -H "Content-Type: application/xml" --data-binary "@demo/snapshot1.xml"
curl.exe "http://127.0.0.1:8080/feeds/weekly/articles"
curl.exe -X POST http://127.0.0.1:8080/articles/2/read -H "Content-Type: application/json" -d '{\"read\":false}'
```

## CLI

开发态可直接用 tsx（`npm run cli -- <命令>`），或构建后 `node dist/cli.js <命令>`。全局选项 `--db data/rss.db`（默认项目内 `data/rss.db`）。

```powershell
npm run cli -- feed-add --code weekly --title 技术周刊 --link https://weekly.example.com/
npm run cli -- feeds
npm run cli -- import --feed weekly --file demo/snapshot1.xml
npm run cli -- import --feed weekly --file demo/snapshot2.xml
npm run cli -- import --feed weekly --file demo/snapshot3.xml
npm run cli -- articles --feed weekly
npm run cli -- articles --feed weekly --read false
npm run cli -- read --id 2 --read true
npm run cli -- revisions --id 2
npm run cli -- snapshots --feed weekly
npm run cli -- report --id 2
npm run cli -- export --feed weekly --format xml --out data/export.xml
npm run cli -- help
```

## 三份演示快照与演示剧本

`demo/` 下：

- `snapshot1.xml`：3 篇有效文章（含 1 篇无 GUID 的链接回退文章）+ 1 篇既无 GUID 也无 link 的无效条目；其中 Node 文章标题含错别字“介召”。
- `snapshot2.xml`：条目顺序打乱；无 GUID 文章改用 CDATA 包裹、Rust 摘要只改空白写法（均判未变）；Node 标题更正为“介绍”（新增修订）；新增 SQLite 一篇。
- `snapshot3.xml`：SQLite 摘要内容更新（新增修订）；Rust 文章从列表消失（本地保留）。

`npm run demo` 会重建数据库并依次：注册源 → 导入快照 1 → 将 Node 文章标记已读 → 导入快照 2、3 → 打印报告（固定预期 **3→1→0 新增、0→1→1 更新、0→2→2 未变、1→0→0 无效**）→ 验证标题更正后已读仍保留、旧文以 `present=false` 保留。

## 数据存储

- 默认数据库：项目内 `data/rss.db`（SQLite，WAL 模式），可用 `--db` 修改；原始快照与文章摘要全部保存在本地。
- 表：`feeds`、`snapshots`（原文+报告 JSON）、`articles`（身份、身份依据、已读、是否仍出现）、`revisions`（每次内容版本）。

## 已知限制与假设

- 仅支持 RSS 2.0；日期按 RFC 822 常见写法解析，命名时区缩写（如 EST）按 UTC 处理。
- 不抓取网络、不做全文搜索、推荐、去重推荐或网页 UI。
- 身份只看 `<guid>`/`<link>` 的字符串值（空白规范化后），不做 URL 归一化（http/https、尾斜杠差异视为不同身份）。
- 服务仅绑定回环地址 `127.0.0.1`，定位为单机本地工具，未做鉴权或多用户支持。
- 导入请求体上限 5 MB。
