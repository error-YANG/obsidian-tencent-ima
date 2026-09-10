# CHANGELOG — tencent-ima-sync 插件

> Obsidian 双向同步插件：本地 vault ↔ 腾讯 IMA 知识库。
> 维护者：杨宇轩。

---

## v0.6.1（2026-09-09）— Bug Fix：大文件上传 403 修复

### 现象
本地源目录 38 个文件 → IMA 知识库上传 38 个目标时：
- 36 个 ≤68MB 文件全部成功
- 2 个 >100MB 大文件（思科 CCNP 178MB / 信息系统项目管理师 141MB）**始终 403 SignatureDoesNotMatch**

### 根因（排查 5 个 BUILD 后锁定）
COS 分片上传（Multipart Upload）的客户端签名与服务端实际接收的请求不一致。系统性问题 = **分片签名**有 4 个坑，叠加出现：

| # | 坑 | 触发条件 | 修复版 |
|---|---|---|---|
| 1 | **分片 HTTP header key 大小写** | COS 按 HTTP 规范要求 header key 全小写（`host`/`content-type`/`content-md5`），客户端用驼峰 → 服务端解析时小写化，签名对不上 | .8 |
| 2 | **query 值编码** | COS 要求分片 query 用「COS URL 安全编码」（只保留 `!~*'()`，其余保留），`encodeURIComponent` 会**多编码**这 5 个字符 → 请求行与签名里的 query 字符串字面值不同 | .9 |
| 3 | **chunked 传输丢 query** | `fs.createReadStream` + chunked Transfer-Encoding 时，COS 服务端解析请求行 query 异常（FormatString 中 query 段为空） → 即使签名对，请求也被拒 | .10 |
| 4 | **query key 大小写** | COS 按 HTTP 标准把 query key 转小写（`partnumber`/`uploadid`），客户端签 `partNumber`/`uploadId`（驼峰）→ 同样不一致 | .13 |

> 共同症状：服务端返回 `<Code>SignatureDoesNotMatch</Code>` + 完整 `<FormatString>`（实际收到的 httpString）与客户端 `<StringToSign>` 算出的 sha1 不一致。

### 修复方案
- 文件阈值：`STREAM_THRESHOLD = 100MB`
- 大于阈值：COS **分片上传**（Init → UploadPart 循环 → CompleteMultipartUpload），每片 **25MB**
- 小于等于阈值：保留原有简单 PUT（**零回归**）
- 分片三步每步独立签名，**所有 header key 全小写** + **所有 query 用 `cosUrlEncode` 安全编码** + **query key 全小写** + **分片 body 走定长 Buffer（无 chunked）**

### BUILD 演进（实战排查 8 版）

| BUILD | 改动 | 结果 |
|---|---|---|
| .4 | 流式上传 fallback + 显式 Host | 仍 403 |
| .5 | 凭证时间窗 keyTime 用 `cred.start_time;cred.expired_time` | 仍 403 |
| .6 | 大文件不签 content-length | 仍 403 |
| .7 | 引入分片上传（每片 25MB） | 仍 403（找到 header 大小写线索） |
| **.8** | 分片三步 header key 全改小写 | **仍 403**（漏了 query） |
| **.9** | 加 `cosUrlEncode` 统一请求/签名编码 | **仍 403**（漏了 query key 大小写） |
| **.10** | 分片 PUT 改成定长 Buffer 无 chunked | **仍 403**（最后还差 query key 大小写） |
| **.11** | buildAuth 返回 `{auth, httpString, stringToSign}` + DIAG 输出 path/httpString | **诊断突破**（拿到完整服务端 FormatString） |
| **.12** | DIAG 加 `clientSha1` + 扩 body 600 字符（拿到完整 40 位 hash） | **根因锁定**（query key 大小写差异） |
| **.13** | 分片 queryParams key 改全小写 `partnumber`/`uploadid` | **✅ 全绿**，新增 2/跳过 36/失败 0 |

### 诊断工具沉淀
**`[DIAG-COS]` 错误消息字段**（失败时打印）：
- `httpString=`：客户端算的待签字符串（JSON 转义）
- `clientSha1=`：客户端 httpString 的 sha1
- `qParamList=`：`q-url-param-list` 的值
- `path=`：实际请求路径（pathname + query）

**对比规则**：
- 客户端 `clientSha1` == 服务端 StringToSign 里的 hash → httpString 完全对，问题在 `signKey`（keyTime 或 secret_key 与服务端不一致）
- 不等 → httpString 格式错（编码/分隔/header key 大小写/query key 大小写）

### 涉及文件
- `E:\ObsidianNote\.obsidian\plugins\tencent-ima-sync\main.js`
  - `STREAM_THRESHOLD = 100 * 1024 * 1024`（阈值常量）
  - `PART_SIZE = 25 * 1024 * 1024`（分片大小）
  - `streamTimeoutMs(size)`：每 MB 1.5s，120s~900s 上限
  - `cosUrlEncode`（新增）：COS URL 安全编码实现
  - `cosUploadStream(host, pathname, headers, absPath, size, timeout, diag)`（新增）：Node https 流式 PUT
  - `cosUploadMultipart(cred, absPath, size, contentType, partSize, timeout, diag)`（新增）：分片三步
  - `cosUpload(cred, data, contentType, absPath, sizeOverride)`（重写）：大文件先 multipart，失败回退 stream + requestUrl（兜底对照）

### 验证
- 本地源 38 个文件 → IMA 38 个文件，新增 2 / 跳过 36 / 失败 0
- 耗时：约 X 秒（视网络）
- 数据落盘：`data.json` 的 `lastPushResult`

### 注意事项
- **回退路径保留**：`cosUpload` 大文件仍先试 multipart，失败回退 stream + requestUrl，**不要删**，用于：
  - 万一分片不被 STS policy 允许仍有对照诊断
  - 历史兼容
- **签名头一致原则**：上传任何 HTTP header 进入 `headers` 对象时，**key 必须全小写**（`host`/`content-type`/`content-md5`），否则不参与签名或不匹配
- **query 编码一致性**：请求行 query 和签名 httpString 第 3 段必须**同一套编码**（都用 `cosUrlEncode`）
- **大文件不走流式**：分片 body 必须**定长 Buffer** + `Content-Length`（无 chunked），否则 COS 解析请求行 query 异常

---

## 历史版本

### v0.6.0（2026-09 之前）
初版：拉取方向 + 上传简单 PUT（≤100MB 走 `requestUrl`，>100MB 走流式 fallback）。
**已知问题**：>100MB 文件上传 403（已在 v0.6.1 修复）。