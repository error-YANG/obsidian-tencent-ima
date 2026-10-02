'use strict';
/*
 * IMA 知识库同步 v0.7.0-refactor — Obsidian <-> IMA 知识库双向同步插件 (官方 OpenAPI /openapi/wiki/v1)
 *
 * 配置形式 (v0.7.0 统一为一张同步规则表):
 *  - 每行规则: [Obsidian 目录(多选)] [方向 →/←] [IMA 知识库] [定时时刻(可空)]
 *  - → 上传: 勾选目录 → 指定知识库; ← 拉取: 指定知识库 → 勾选的第一个目录
 *  - 旧配置(白名单/v0.6.2映射表/拉取多选/两套定时) 首次加载时自动迁移为规则行
 *  - 无默认兜底库: 文件必须命中某条上传规则才会上传(业务隐患②: 原静默回落 targetKbId 已于 2026-09-26 移除)
 *
 * 行为:
 *  - 只处理规则勾选目录下的支持类型文件, md 正文去掉 frontmatter 再上传
 *  - 内容没变 -> skip (本地账本 hash, 且每次推送前批量核验远端同名文件仍在; 远端被删则自动重传)
 *  - 内容变了/新文件 -> 上传链路: check_repeated_names -> create_media -> COS PUT -> add_knowledge
 *  - 同名处理: 自动编号, A.md 被占用则传 A(1).md, 再占用 A(2).md ... (check_repeated_names 批量查询)
 *  - 知识库文件无更新/删除接口 (官方能力边界), 旧版本保留, 新版本带序号
 *  - 网络调用 30s 超时 + 本地文件 I/O 60s 超时; 运行锁由看门狗兜底, 也可在命令面板
 *    「Force unlock 强制解锁」手动释放 (2026-10-02)
 *  - 手动触发: 右下角常驻 [↑ 推送到 IMA] 按钮 / 左侧竖栏图标 / 命令面板
 *  - 进度: 右下角面板实时显示进度条 + 百分比 + 当前文件名, 结束明确汇总
 *
 * ── v0.7.0 重构 (代码修复版, 业务逻辑保持不变; 版本号沿用 manifest 0.7.0) ─────────────
 *  [安全]
 *  1. VULN-01: create_media 异常不再把 cos_credential(secret_id/secret_key/token) 序列化进错误
 *     消息; 新增 redactCred()/redactText(), 所有 errors 落盘(runHistory/lastPushResult)、
 *     Notice、控制台输出统一脱敏兜底。
 *  2. VULN-02: 桌面端 renderer 无 electron.safeStorage, 采用审计建议的低成本方案 ——
 *     设置页显著警告 + 首次保存 API Key 时自动检测 vault 是否在 git 仓库内并 Notice 提醒
 *     (提示将 data.json 加入 .gitignore)。
 *  3. 版本指纹 ima-openapi-ctx 由硬编码 0.6.0 改为读取 manifest.version。
 *  [正确性]
 *  4. VULN-03: hashStr 由 32 位 FNV-1a 升级为 SHA-256; bufHash(拉取方向二进制比对) 同步升级。
 *     注意: 升级后旧 fileStates 的 pushHash 全部不匹配, 首次推送会全量重传一次(自动编号保护, 不覆盖远端)。
 *  5. VULN-04: 规则行目录由逗号拼接字符串改为数组 dirs 存储, 消除含逗号目录名的同步范围歧义;
 *     兼容旧数据(dir 逗号串回落拆分), 写路径统一走 setRuleDirs。
 *  6. pushAll 服务端存在性校验的 gone Map 按 chunk 覆盖(只保留最后一批)导致"远端已删"漏判 ——
 *     改为同 kbId 合并 Set, 修复自动补传漏触发。
 *  7. syncAll / runRuleTimers 逐行调用子方法间无 running 锁持有, 存在微小竞态窗口 ——
 *     改为外层统一持锁, 子方法传 locked 标记跳过自锁。
 *  8. 拉取下载 URL 增加 https 协议断言(INFO-06); 拉取文件名全非法字符时兜底为「未命名_mediaId」。
 *  [资源/性能]
 *  9. VULN-05: withTimeout/withTimeoutMs 增加 clearTimeout, 消除每次网络请求的 timer 泄漏;
 *     底层 requestUrl 无 abort 能力, 超时后请求仍可能在后台完成(语义已在注释说明)。
 *  10. INFO-04: cosUpload 大文件回退路径移除 readFileSync 整文件读入内存(>100MB 文件可达数百 MB 峰值),
 *      分片/流式均失败时直接报错, 不再无意义全量读。
 *  11. pushFile 增加 saveNow 参数: 批量推送改为内存累计 + 每 20 个文件一个检查点 + 结束统一落盘,
 *      避免上千文件每次全量序列化 data.json(含 fileStates 全量)。
 *  12. cosUploadStream 失败时同时销毁读流; cosUploadMultipart 对 x-cos-security-token 做存在性防御。
 *  13. pullAll / pullRulesOnly 重复的逐条目下载循环抽取为 processPullEntries;
 *      pushAll / pushRulesOnly 重复的上传循环抽取为 processPushFiles。
 *  [规范]
 *  14. 模块级集中 require(fs/https/path), 去掉函数内重复 require; 迁移保存失败不再产生 unhandled rejection。
 *  [冗余收敛 (R-04~R-06, 见《冗余检查报告》)]
 *  15. pushAll↔pushRulesOnly、pullAll↔pullRulesOnly 双胞胎外壳收敛为 runPush/runPull 单一核心,
 *      独立入口语义(full: 白名单回落/0 文件 Notice/lastPushResult/完成文案/控制台输出)由 opts 区分, 五条触发路径行为不变;
 *      pathInDirs/inPushScope 路径谓词单点化(原 5 处复制); 推送比对阶段算好的 hash 复用给 pushFile(preHash), 消除同文件重复计算;
 *      旧配置迁移完成后清空旧字段(whitelist/pullKbId/pullKbList/pullDir/全局定时时刻), 关闭隐藏读取路径并给 data.json 瘦身。
 */

const { Plugin, PluginSettingTab, Setting, Notice, Modal, requestUrl } = require('obsidian');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const nodePath = require('path');

const BASE = 'https://ima.qq.com';
const TIMEOUT_MS = 30000;
/* 本地文件 I/O 超时 (2026-10-02): 网络调用都有超时, 但 vault 的读/写/建目录/建文件与 saveData 没有 ——
   被同步盘、杀软或文件锁占住时会永久 pending, 这是运行锁 running 唯一可能泄漏的位置。
   超时只让调用方立即失败(语义同 INFO-2: 底层操作仍可能在后台完成), 不影响已落盘的数据 */
const VAULT_IO_TIMEOUT_MS = 60000;
/* 运行看门狗阈值 (2026-10-02): 无任何活动 —— 进度更新或网络调用 settle —— 超过 WARN 提示一次,
   超过 AUTO 判定卡死并自动释放运行锁。阈值依据: 单次网络调用最长超时是大文件流式上传的 900s,
   且每次超时本身都会产生活动, 因此 45 分钟零活动已排除"正常等待超时"的可能 */
const RUN_STALL_WARN_MS = 10 * 60 * 1000;
const RUN_STALL_AUTO_MS = 45 * 60 * 1000;
const MEDIA_TYPE_MD = 7;
/* 超过此大小的文件走 COS 分片上传(multipart upload), 单请求不再发大 body,
   彻底绕开服务端 STS policy 的 content-length-range 上限(实测约 100MB).
   阈值取 100MB 的依据: 65.5MB 经 requestUrl 实证上传成功, 141MB 实证失败,
   真实分界点落在两者之间。设 100MB 可让已实证安全的区间继续走老路径(零回归风险),
   只对已实证会失败的大文件启用分片通道 —— 改动是"严格不劣"的 */
const STREAM_THRESHOLD = 100 * 1024 * 1024;
/* 分片上传每片大小: 25MB
   178MB = 8 片, 141MB = 6 片; 远低于常见 STS content-length-range 上限(100MB) */
const PART_SIZE = 25 * 1024 * 1024;
/* 流式上传超时: 每 MB 给 1.5s, 下限 120s, 上限 900s */
function streamTimeoutMs(size) {
  const ms = Math.ceil(size / (1024 * 1024)) * 1500;
  return Math.min(900000, Math.max(120000, ms));
}

/* 扩展名 -> {media_type, content_type} (官方 MediaType 枚举, 参照 ima 官方 skill 包 preflight-check.cjs) */
const EXT_MAP = {
  pdf: { media_type: 1, content_type: 'application/pdf' },
  doc: { media_type: 3, content_type: 'application/msword' },
  docx: { media_type: 3, content_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ppt: { media_type: 4, content_type: 'application/vnd.ms-powerpoint' },
  pptx: { media_type: 4, content_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  xls: { media_type: 5, content_type: 'application/vnd.ms-excel' },
  xlsx: { media_type: 5, content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { media_type: 5, content_type: 'text/csv' },
  md: { media_type: 7, content_type: 'text/markdown' },
  markdown: { media_type: 7, content_type: 'text/markdown' },
  png: { media_type: 9, content_type: 'image/png' },
  jpg: { media_type: 9, content_type: 'image/jpeg' },
  jpeg: { media_type: 9, content_type: 'image/jpeg' },
  webp: { media_type: 9, content_type: 'image/webp' },
  gif: { media_type: 9, content_type: 'image/gif' },
  bmp: { media_type: 9, content_type: 'image/bmp' },
  svg: { media_type: 9, content_type: 'image/svg+xml' },
  txt: { media_type: 13, content_type: 'text/plain' },
  xmind: { media_type: 14, content_type: 'application/x-xmind' },
  mp3: { media_type: 15, content_type: 'audio/mpeg' },
  m4a: { media_type: 15, content_type: 'audio/x-m4a' },
  wav: { media_type: 15, content_type: 'audio/wav' },
  aac: { media_type: 15, content_type: 'audio/aac' },
  html: { media_type: 20, content_type: 'text/html' },
  epub: { media_type: 21, content_type: 'application/epub+zip' }
};

/* N-4: media_type -> 默认扩展名 (由 EXT_MAP 反查: 同类型命中多个后缀时取更通用的一个)。
   用途: 拉取落地时 IMA 的 title 常不带扩展名, 按此补后缀 —— 否则落地文件无扩展名,
   Obsidian 不识别为笔记、系统双击关联错程序 */
const EXT_BY_TYPE = (() => {
  const first = {};
  Object.keys(EXT_MAP).forEach(k => {
    const t = EXT_MAP[k].media_type;
    if (!first[t]) first[t] = k;
  });
  /* doc/ppt/xls 取对应的现代格式; markdown 取 md */
  return Object.assign(first, { 3: 'docx', 4: 'pptx', 5: 'xlsx', 7: 'md' });
})();

/* 各类型大小上限 (字节), 官方规定 */
const MB = 1024 * 1024;
const SIZE_LIMITS = {
  5: 10 * MB,   // Excel / CSV
  7: 10 * MB,   // Markdown
  13: 10 * MB,  // TXT
  14: 10 * MB,  // Xmind
  20: 10 * MB,  // HTML
  9: 30 * MB,   // 图片
  21: 50 * MB,  // EPUB
  1: 200 * MB,  // PDF
  3: 200 * MB,  // Word
  4: 200 * MB,  // PPT
  15: 200 * MB  // 音频
};

/* 可拉取的文件类 media_type 集合 (其余如网页/笔记/文件夹不处理) */
const PULLABLE_TYPES = new Set([1, 3, 4, 5, 7, 9, 13, 14, 15, 20, 21]);

function fileTypeInfo(name) {
  const m = String(name).match(/\.([a-z0-9]+)$/i);
  return m ? (EXT_MAP[m[1].toLowerCase()] || null) : null;
}

function bufHash(data) {
  /* VULN-03: 拉取方向二进制比对由 MD5 升级为 SHA-256 (内存内比对, 不落盘, 无兼容负担) */
  return crypto.createHash('sha256').update(Buffer.from(data)).digest('hex');
}

const DEFAULT_SETTINGS = {
  clientId: '',
  apiKey: '',
  whitelist: '',           // Obsidian 目录白名单, 一行一个文件夹名
  targetKbId: '',          // 遗留字段: 仅迁移旧白名单时读取一次; 业务隐患②后不再作为推送兜底目标
  targetKbName: '',
  dirMappings: [],         // 统一同步规则: [{dirs, dir, kbName, kbId, kbName, kbIds, kbNames, direction, time, timerDone}]
  /* v0.7.0 重构: 规则行目录以数组 dirs 存储(修复含逗号目录名的同步范围歧义); dir 逗号串仅作旧数据兼容读 */
  /* 以下为 v0.6.2 及更早的旧字段, v0.7.0 起由 dirMappings 统一承接(启动时自动迁移), 保留仅为兼容读路径 */
  pullKbId: '',            // 拉取方向: 源知识库 id (IMA -> OB), 兼容旧版单选
  pullKbName: '',
  pullKbList: [],          // 拉取方向: 源知识库多选列表 [{id,name}], 空时回落到 pullKbId
  enablePush: true,        // 方向开关: 上传 (关掉后 ⇅ 只拉取)
  enablePull: true,        // 方向开关: 拉取 (关掉后 ⇅ 只上传)
  pullDir: '',             // 拉取落地目录: vault 内文件夹, 留空 = 根目录
  fileStates: {},          // path -> {pushHash, kbId, uploadedName, mediaId, syncedAt}
  lastPushAt: 0,
  lastRun: null,           // 兼容旧版: 单一对象, 不再写入, 读路径仍保留避免兼容性问题
  runHistory: [],          // 运行历史: 最近 10 次, 每条 {at, dir, total, success, skipped, conflict, failed, errors}
  lastWatchdog: null,      // 最近一次运行锁强制释放留证: {at, reason, ranMs, idleMs, stage}

  /* ---------- 定时同步 (v0.6.0): 推送/拉取 各一套独立定时, 每天固定时刻 HH:MM ---------- */
  timerPush: { enabled: false, time: '09:00', lastDate: '' },
  timerPull: { enabled: false, time: '21:00', lastDate: '' },
};

/* ---------- utils ---------- */

/* VULN-03 修复: 32 位 FNV-1a 换 SHA-256。
   升级后旧 fileStates.pushHash(8 位 hex) 全部不匹配 → 首次推送全量重传一次
   (同名自动编号保护, 不会覆盖远端); 之后增量判定恢复, 属一次性成本 */
function hashStr(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

/* VULN-03 修复(续): 二进制文件增量判定由 "size|mtime" 元数据改为内容 SHA-256。
   原口径两核心缺陷: ① 内容变但 size/mtime 未变 → 静默漏传; ② 仅 touch(mtime 变)内容未变 → 误判重传产生 name(1) 副本。
   现统一走内容哈希, 两缺陷同时消除, 与 md 正文哈希口径对齐(均为 SHA-256 内容指纹)。
   性能: 大文件(>STREAM_THRESHOLD)走 fs 流式分块哈希, 不整文件进内存(与 uploadToKB 流式上传口径一致);
         移动端无 fs/absPath 时回落 vault.readBinary。
   升级代价: 旧 fileStates 中二进制 pushHash(原 size|mtime 的 SHA-256)全部不匹配 → 首次推送二进制全量重传一次(同名编号保护, 不覆盖远端), 属一次性成本。
   注意: 比对阶段(main.js:1105 附近)与 pushFile(1517 附近)必须调用同一函数, 保证两者哈希一致, 否则会出现"比对说没变、上传却重传/漏传" */
async function hashBinaryFile(app, file) {
  const size = file.stat.size;
  if (size > STREAM_THRESHOLD) {
    const absPath = vaultAbsPath(app, file.path);
    if (absPath) {
      const h = crypto.createHash('sha256');
      await vaultIO(new Promise((resolve, reject) => {
        const rs = fs.createReadStream(absPath);
        rs.on('data', c => h.update(c));
        rs.on('end', resolve);
        rs.on('error', reject);
      }), '流式读取 ' + file.name);
      return h.digest('hex');
    }
  }
  const buf = await vaultIO(app.vault.readBinary(file), '读取 ' + file.name);
  return crypto.createHash('sha256').update(Buffer.from(buf)).digest('hex');
}

function stripFrontmatter(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');   /* \r? 兼容 CRLF, 否则 Windows 换行文件改 frontmatter 会误判内容变更 */
}

function parseWhitelist(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(s => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(s => s.length > 0);
}

/* 目录名归一化: 去首尾空白与首尾斜杠 */
function normDir(d) {
  return String(d || '').trim().replace(/^\/+|\/+$/g, '');
}

/* vault 内相对路径 -> 磁盘绝对路径 (仅桌面端 FileSystemAdapter 可用; 移动端返回 null 自动退回内存模式) */
function vaultAbsPath(app, relPath) {
  try {
    const ad = app.vault.adapter;
    if (ad && typeof ad.getFullPath === 'function') return ad.getFullPath(relPath);
    if (ad && typeof ad.getBasePath === 'function') return nodePath.join(ad.getBasePath(), relPath);
  } catch (e) { /* 移动端无 node 环境, 忽略 */ }
  return null;
}

/* VULN-05 修复: 超时后清理 timer, 不再每次网络请求挂一个活跃定时器。
   注意: Obsidian requestUrl 不暴露 abort, 超时仅使调用方立即失败,
   底层请求仍可能在后台完成 —— 语义为"调用方不再等待", 不会重复提交业务动作 */
function withTimeout(promise, label) {
  return withTimeoutMs(promise, TIMEOUT_MS, label);
}

/* 本地文件 I/O 统一入口: 与网络调用同语义的超时保护 (阈值依据见 VAULT_IO_TIMEOUT_MS 注释) */
function vaultIO(promise, label) {
  return withTimeoutMs(promise, VAULT_IO_TIMEOUT_MS, label);
}

/* 全局活动时间戳 (2026-10-02): 任何一次网络调用 settle(成功/失败/超时)都刷新它,
   与面板进度心跳一起供运行看门狗判断"任务是否真的还在动" */
let lastNetActivity = 0;

/* 自定义超时版: 大文件需要远超 30s 的窗口, 不能沿用固定 TIMEOUT_MS */
function withTimeoutMs(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(label + ' 超时(' + ms + 'ms)')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
    lastNetActivity = Date.now();
  });
}

/* ---------- 敏感信息脱敏 (VULN-01 / INFO-01 / INFO-03) ---------- */

/* 对象级脱敏: 只保留 cos_credential 非敏感字段, 密钥一律替换 */
function redactCred(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactCred);
  const clone = Object.assign({}, obj);
  if (clone.cos_credential && typeof clone.cos_credential === 'object') {
    const c = clone.cos_credential;
    clone.cos_credential = {
      cos_key: c.cos_key,
      bucket_name: c.bucket_name,
      region: c.region,
      secret_id: c.secret_id ? String(c.secret_id).slice(0, 6) + '***' : undefined,
      has_secret_key: !!c.secret_key,
      has_token: !!c.token,
      start_time: c.start_time,
      expired_time: c.expired_time
    };
  }
  return clone;
}

/* 字符串级兜底脱敏: 覆盖 JSON 键值、key=value、COS 签名等形式 */
function redactText(text) {
  if (text == null) return '';
  const s = String(text);
  return s
    /* JSON 字符串值: "secret_key":"AKID..." */
    .replace(/("(?:secret_?key|secret_?id|token|api_?key|client_?id)"\s*:\s*")[^"]*(")/gi, '$1***$2')
    /* 键值赋值: key=value / key: value / key: "value"; 兼容 Bearer/Basic 前缀的令牌格式 */
    .replace(/((?:secret_?key|secret_?id|token|api_?key|authorization|x-cos-security-token|q-ak)\s*[:=]\s*"?)(?:Bearer\s+|Basic\s+)?[^\s,;}"']+/gi, '$1***')
    /* COS 签名串 */
    .replace(/(q-signature=)[0-9a-fA-F]+/gi, '$1***');
}

/* 统一错误消息安全化: 任何进入 errors[] / Notice / 日志的异常文本先过这里 */
function safeErrMsg(e) {
  if (e == null) return '未知错误';
  const m = (typeof e === 'object' && e && e.message) ? e.message : String(e);
  return redactText(m);
}

/* 生成同名候选名: 保留扩展名, a.pdf -> [a.pdf, a(1).pdf, a(2).pdf ... a(N).pdf] */
function buildNameCandidates(fileName, max) {
  const dot = fileName.lastIndexOf('.');
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  const ext = dot > 0 ? fileName.slice(dot) : '';
  const list = [fileName];
  for (let i = 1; i <= max; i++) list.push(base + '(' + i + ')' + ext);
  return list;
}

/* ---------- COS 上传 (官方签名算法, 参照 ima 官方 skill 包 cos-upload.cjs) ---------- */

/* Node 原生流式 PUT: 绕开 requestUrl 对大 body 的内存/IPC 限制, 全程磁盘读流, 内存占用恒定 */
function cosUploadStream(hostName, pathname, reqHeaders, absPath, size, timeoutMs, diag) {
  return new Promise((resolve, reject) => {
    /* 显式补 Host: 签名里 host 用的是不带端口的域名, 显式设置可杜绝 Node 自行推导带来的偏差 */
    const headers = Object.assign({}, reqHeaders, {
      'host': hostName,
      'Content-Length': String(size)
    });
    const req = https.request({
      hostname: hostName,
      port: 443,
      path: pathname,
      method: 'PUT',
      headers: headers
    }, res => {
      /* INFO-3: 先按 Buffer 累积, end 时一次性解码 —— 旧实现在每个 chunk 上单独 toString('utf8'),
         跨 chunk 边界的多字节字符(中文等)会被切碎成乱码。这里攒字节再一次解码, 乱码消失;
         上限 4KB 仅用于错误文本展示, 不影响上传结果 */
      const chunks = []; let got = 0;
      res.on('data', c => { if (got < 4096) { chunks.push(c); got += c.length; } });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 300) {
          /* 诊断信息随错误一起落盘: 便于比对"签名用的值"与"实际发出的值"是否一致 */
          const d = diag || {};
          reject(new Error('COS 流式上传失败 HTTP ' + res.statusCode + ' ' + body.slice(0, 200)
            + ' || DIAG host=' + hostName
            + ' path=' + pathname
            + ' signedLen=' + size
            + ' realFileLen=' + (d.realLen === undefined ? '?' : d.realLen)
            + ' keyTime=' + (d.keyTime || '?') + '(' + (d.keyTimeSrc || '?') + ')'
            + ' headerList=' + (d.headerList || '?')
            + ' httpString=' + (d.httpString || '?')));
        }
        else resolve();
      });
    });
    let settled = false;
    let rs = null;
    const fail = e => {
      if (!settled) {
        settled = true;
        try { req.destroy(); } catch (_) {}
        try { if (rs) rs.destroy(); } catch (_) {}   /* 同步销毁读流, 避免文件句柄滞留 */
        reject(e);
      }
    };
    req.setTimeout(timeoutMs, () => fail(new Error('COS 流式上传超时(' + timeoutMs + 'ms)')));
    req.on('error', fail);
    rs = fs.createReadStream(absPath);
    rs.on('error', fail);
    rs.pipe(req);
  });
}

/* COS 分片上传: 解决大文件(>100MB)单 PUT 被 STS policy 限制的问题.
   流程: InitMultipartUpload -> UploadPart(每片, 流式) -> CompleteMultipartUpload.
   每步单独签名(签名含 query 参数 + headers) */
async function cosUploadMultipart(cred, absPath, size, contentType, partSize, timeoutMs, diag) {
  const host = cred.bucket_name + '.cos.' + cred.region + '.myqcloud.com';
  const pathname = '/' + cred.cos_key;
  /* keyTime 优先用凭证时间窗, 与 cosUpload 保持一致 */
  const now = Math.floor(Date.now() / 1000);
  const hasCredTime = Number(cred.start_time) > 0 && Number(cred.expired_time) > 0;
  const keyTime = hasCredTime
    ? Number(cred.start_time) + ';' + Number(cred.expired_time)
    : now + ';' + (now + 3600);
  const signKey = crypto.createHmac('sha1', cred.secret_key).update(keyTime).digest('hex');

  /* COS URL 安全编码: 只保留 !~*'(), 其余编码 —— 官方 cosUrlEncode 实现。
     分片 query(partNumber/uploadId) 的值在【请求行】和【签名 httpString/q-url-param-list】必须用同一套编码,
     用 encodeURIComponent 会多编码 !*'() 导致 SignatureDoesNotMatch(分片 PUT 403 根因) */
  const cosUrlEncode = s => encodeURIComponent(String(s)).replace(/[!*'()]/g, c => c);

  /* 签名: method 全小写, queryParams 按 k 排序(签名/请求均按字典序), headers 按 k 排序 */
  const buildAuth = (method, queryParams, headers) => {
    const headerKeys = Object.keys(headers).sort();
    const queryStr = (queryParams || []).map(p => cosUrlEncode(p.k) + '=' + cosUrlEncode(p.v)).join('&');
    const httpString = method.toLowerCase() + '\n' + pathname + '\n' + queryStr + '\n'
      + headerKeys.map(k => k + '=' + cosUrlEncode(headers[k])).join('&') + '\n';
    const stringToSign = 'sha1\n' + keyTime + '\n' + crypto.createHash('sha1').update(httpString).digest('hex') + '\n';
    const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
    const auth = [
      'q-sign-algorithm=sha1',
      'q-ak=' + cred.secret_id,
      'q-sign-time=' + keyTime,
      'q-key-time=' + keyTime,
      'q-header-list=' + headerKeys.join(';'),
      'q-url-param-list=' + (queryParams || []).map(p => p.k).sort().join(';'),
      'q-signature=' + signature
    ].join('&');
    return { auth, httpString, stringToSign };
  };

  /* 通用 https.request: body 可以是 Buffer 或 stream, queryParams 数组
     分片场景(带 partNumber/uploadId query)下, 流式 chunked 传输会导致 COS 服务端解析请求行 query 异常 →
     SignatureDoesNotMatch。统一把流读成定长 Buffer 再发(每片 25MB, 内存安全), 无 chunked, 签名稳定 */
  /* INFO-3: len 形参从未被使用(Buffer.concat 按实际累积字节数), 移除以免误导读 */
  const streamToBuffer = (rs) => new Promise((resolve, reject) => {
    const chunks = []; let got = 0;
    rs.on('data', c => { chunks.push(c); got += c.length; });
    rs.on('end', () => resolve(Buffer.concat(chunks, got)));
    rs.on('error', reject);
  });

  const doReq = async (method, queryParams, headers, bodyOrStream, bodyLen) => {
    const built = buildAuth(method, queryParams, headers);
    const allHeaders = Object.assign({}, headers, {
      'Authorization': built.auth
    });
    if (cred.token) allHeaders['x-cos-security-token'] = cred.token;   /* 防御: 凭证缺 token 时不发送空头 */
    let bodyBuf = null;
    if (bodyOrStream) {
      if (typeof bodyOrStream.pipe === 'function') {
        bodyBuf = await streamToBuffer(bodyOrStream);
        allHeaders['Content-Length'] = String(bodyBuf.length);
      } else {
        bodyBuf = bodyOrStream;
        if (bodyLen != null) allHeaders['Content-Length'] = String(bodyLen);
        else allHeaders['Content-Length'] = String(bodyBuf.length);
      }
    } else if (bodyLen != null) allHeaders['Content-Length'] = String(bodyLen);
    const queryStr = (queryParams || []).map(p => cosUrlEncode(p.k) + '=' + cosUrlEncode(p.v)).join('&');
    return await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, port: 443, path: pathname + '?' + queryStr, method: method, headers: allHeaders
      }, res => {
        let body = '';
        res.on('data', c => { if (body.length < 4000) body += c.toString('utf8'); });
        res.on('end', () => {
          if (res.statusCode >= 300) {
            /* 计算客户端 sha1(httpString), 便于和服务器 StringToSign 的 sha1 对比定位: 一致=httpString 对,signKey 错; 不一致=httpString 格式错 */
            const clientSha1 = crypto.createHash('sha1').update(built.httpString).digest('hex');
            const diag = ' [DIAG-COS] httpString=' + JSON.stringify(built.httpString)
              + ' clientSha1=' + clientSha1
              + ' qParamList=' + built.auth.match(/q-url-param-list=([^&]+)/)[1]
              + ' path=' + pathname + '?' + queryStr;
            /* 扩到 600 字符以捕获服务器 StringToSign 完整 40 位 hash */
            reject(new Error('COS ' + method + ' HTTP ' + res.statusCode + ' ' + body.slice(0, 600) + diag));
          } else resolve({ body: body, headers: res.headers });
        });
      });
      let settled = false;
      const fail = e => { if (!settled) { settled = true; try { req.destroy(); } catch (_) {} reject(e); } };
      req.setTimeout(timeoutMs, () => fail(new Error('COS ' + method + ' 超时(' + timeoutMs + 'ms)')));
      req.on('error', fail);
      if (bodyBuf) req.end(bodyBuf);
      else req.end();
    });
  };

  /* 1. Init: POST /<key>?uploads */
  const init = await doReq('POST', [{ k: 'uploads', v: '' }], { 'host': host }, null, 0);
  const uploadIdMatch = init.body.match(/<UploadId>([^<]+)<\/UploadId>/);
  if (!uploadIdMatch) throw new Error('COS 分片初始化失败, 未取到 UploadId: ' + init.body.slice(0, 300));
  const uploadId = uploadIdMatch[1];
  if (diag) { diag.uploadId = uploadId; diag.keyTime = keyTime; diag.keyTimeSrc = hasCredTime ? 'credential' : 'local'; }

  /* 2. Upload Parts: 每片 PUT, 走 fs.createReadStream 的 start/end 切片读, 不读全文件 */
  const parts = [];
  let offset = 0;
  let partNumber = 1;
  while (offset < size) {
    const end = Math.min(offset + partSize, size);
    const len = end - offset;
    const rs = fs.createReadStream(absPath, { start: offset, end: end - 1 });
    const res = await doReq('PUT',
      [{ k: 'partnumber', v: String(partNumber) }, { k: 'uploadid', v: uploadId }],
      { 'host': host, 'content-type': contentType || 'application/octet-stream' },
      rs, len);
    const etag = res.headers.etag || res.headers.ETag;
    if (!etag) throw new Error('COS 分片 ' + partNumber + ' 响应缺 ETag: ' + JSON.stringify(res.headers));
    parts.push({ PartNumber: partNumber, ETag: etag });
    offset = end;
    partNumber++;
  }
  if (diag) { diag.partCount = parts.length; diag.partEtags = parts.map(p => p.PartNumber + '=' + p.ETag).join(','); }

  /* 3. Complete: POST /<key>?uploadId=... body 是 XML */
  const xmlParts = parts.map(p => '<Part><PartNumber>' + p.PartNumber + '</PartNumber><ETag>' + p.ETag + '</ETag></Part>').join('');
  const xmlBody = '<CompleteMultipartUpload>' + xmlParts + '</CompleteMultipartUpload>';
  const xmlBytes = Buffer.byteLength(xmlBody, 'utf8');
  const md5 = crypto.createHash('md5').update(xmlBody).digest('base64');
  const finalRes = await doReq('POST',
    [{ k: 'uploadid', v: uploadId }],
    { 'host': host, 'content-type': 'application/xml', 'content-md5': md5 },
    Buffer.from(xmlBody, 'utf8'), xmlBytes);
  if (/<Error>/i.test(finalRes.body)) throw new Error('COS 分片合并失败: ' + finalRes.body.slice(0, 300));
}

async function cosUpload(cred, data, contentType, absPath, sizeOverride) {
  const size = data ? data.byteLength : sizeOverride;
  if (typeof size !== 'number' || size < 0) throw new Error('cosUpload: 无法确定文件大小');
  const host = cred.bucket_name + '.cos.' + cred.region + '.myqcloud.com';
  const pathname = '/' + cred.cos_key;
  /* keyTime 必须用凭证返回的 start_time;expired_time, 不能本地自算 —— 这是 COS PUT 403 的根因。
     COS 服务端按凭证登记的时间窗校验 SignKey, 自算的窗口与之不符就 AccessDenied。
     官方 skill 流程(knowledge-base/SKILL.md Step 5)明确传入:
       --start-time <cos_credential.start_time> --expired-time <cos_credential.expired_time>
     凭证缺这两个字段时才退回本地时间窗, 且对齐官方默认的 3600s(原先自算的 600s 也偏短) */
  const now = Math.floor(Date.now() / 1000);
  const hasCredTime = Number(cred.start_time) > 0 && Number(cred.expired_time) > 0;
  const keyTime = hasCredTime
    ? Number(cred.start_time) + ';' + Number(cred.expired_time)
    : now + ';' + (now + 3600);

  /* 大文件不签 content-length, 只签 host:
     实测 36 个 ≤68MB 文件签 content-length 全部成功, 而 141MB/178MB 两个全部 403,
     排除了 keyTime/通道/路径/算法后, 唯一系统性差异就是大小 ——
     怀疑服务端对大文件 PUT 的 content-length 校验或 STS policy 有问题。
     让大文件的 content-length 走未签名通道; 小文件保持原样(零回归风险) */
  const signLength = size <= STREAM_THRESHOLD;
  const headers = { 'host': host };
  if (signLength) headers['content-length'] = String(size);
  const sortedKeys = Object.keys(headers).sort();
  const signKey = crypto.createHmac('sha1', cred.secret_key).update(keyTime).digest('hex');
  const httpHeaders = sortedKeys.map(k => k + '=' + encodeURIComponent(headers[k])).join('&');
  const httpString = 'put\n' + pathname + '\n\n' + httpHeaders + '\n';
  const stringToSign = 'sha1\n' + keyTime + '\n' + crypto.createHash('sha1').update(httpString).digest('hex') + '\n';
  const signature = crypto.createHmac('sha1', signKey).update(stringToSign).digest('hex');
  const auth = [
    'q-sign-algorithm=sha1',
    'q-ak=' + cred.secret_id,
    'q-sign-time=' + keyTime,
    'q-key-time=' + keyTime,
    'q-header-list=' + sortedKeys.join(';'),
    'q-url-param-list=',
    'q-signature=' + signature
  ].join('&');

  const url = 'https://' + host + pathname;
  const putHeaders = {
    'Content-Type': contentType || 'application/octet-stream',
    'Authorization': auth
  };
  if (cred.token) putHeaders['x-cos-security-token'] = cred.token;   /* 防御: 凭证缺 token 时不发送空头 */

  /* 大文件走 Node 读流: requestUrl 传 >100MB 级 body 会失败(内存/IPC), 这是 39/41 里那 2 个大 PDF 失败的根因 */
  if (absPath && size > STREAM_THRESHOLD) {
    /* 大文件优先走 COS 分片上传: 把 body 切成 25MB 一片, 每片单独 PUT,
       彻底绕开 STS policy 的 content-length-range 单请求上限(实测约 100MB).
       失败再退回流式/老路径兜底(理论上不再需要, 但保留以便对照诊断) */
    let realLen;
    try { realLen = fs.statSync(absPath).size; } catch (e) { realLen = 'stat失败:' + e.message; }
    const diag = {
      realLen: realLen,
      keyTime: keyTime,
      keyTimeSrc: hasCredTime ? 'credential' : 'local',
      headerList: sortedKeys.join(';'),
      httpString: httpString.replace(/\n/g, '\\n'),
      partSize: PART_SIZE
    };
    try {
      await cosUploadMultipart(cred, absPath, size, contentType, PART_SIZE, streamTimeoutMs(size), diag);
      return;
    } catch (eMul) {
      /* 分片失败 -> 退回旧的流式通道,
         目的: 万一分片不被 STS policy 允许, 仍能拿到对照数据(以及万一成功) */
      let streamErr = null;
      try {
        await cosUploadStream(host, pathname, putHeaders, absPath, size, streamTimeoutMs(size), diag);
        return;
      } catch (eStr) { streamErr = eStr; }

      /* INFO-04 修复: 原实现此时 readFileSync 整文件读入内存做 requestUrl 回退,
         >100MB 文件可达数百 MB 内存峰值且大概率仍失败 —— 移除该回退, 直接报错 */
      throw new Error('[multipart]' + (eMul.message || eMul)
        + ' || [stream]' + (streamErr.message || streamErr)
        + ' || 大文件上传失败(分片与流式均未成功), 已停止 requestUrl 整文件回退以免内存溢出');
    }
  }
  if (!data) throw new Error('cosUpload: 小文件路径缺少 data');

  const resp = await withTimeout(requestUrl({
    url: url,
    method: 'PUT',
    headers: putHeaders,
    body: data
  }), 'COS 上传');
  if (resp.status >= 300) throw new Error('COS 上传失败 HTTP ' + resp.status + ' ' + redactText(String(resp.text || '').slice(0, 200)));
}

/* ---------- IMA OpenAPI client ---------- */

class ImaApi {
  constructor(clientId, apiKey, version) {
    this.clientId = clientId;
    this.apiKey = apiKey;
    this.version = version || '0.0.0';
  }
  async post(path, body) {
    const resp = await withTimeout(requestUrl({
      url: BASE + path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ima-openapi-clientid': this.clientId,
        'ima-openapi-apikey': this.apiKey,
        /* INFO-02: 版本指纹不再硬编码 0.6.0, 跟随 manifest 版本 */
        'ima-openapi-ctx': 'skill_version=tencent-ima-sync/' + this.version
      },
      body: JSON.stringify(body || {})
    }), path);
    let j;
    try { j = JSON.parse(resp.text); }
    catch (e) { throw new Error(path + ' 返回非 JSON: ' + redactText(String(resp.text).slice(0, 120))); }
    if (typeof j.code === 'number' && j.code !== 0) throw new Error('code=' + j.code + ' ' + redactText(j.msg || ''));
    return j.data || {};
  }
  testConnection() { return this.listAddableKBs(); }
  /* 拉取方向: 递归列出知识库全部条目 (文件夹下钻 + 游标分页, 最多 2000 条)。
     IMA 的 get_knowledge_list 是分层返回: 根目录只给顶层条目, 文件夹(media_type=99)
     内部内容必须带 folder_id 再次请求 —— 旧版只拉根目录, 文件夹里的文件永远拉不到。
     文件夹本身不进结果, 但其相对路径记入 folderPath, 拉取侧按目录结构落地 */
  async listKnowledge(kbId) {
    const list = [];
    const visited = new Set();   /* 文件夹去重, 防御服务端异常数据成环 */
    const MAX_DEPTH = 8;
    const MAX_ENTRIES = 2000;
    const self = this;
    const walk = async (folderId, folderPath, depth) => {
      if (depth > MAX_DEPTH || list.length >= MAX_ENTRIES) return;
      const subFolders = [];
      let cursor = '';
      for (let i = 0; i < 40; i++) {
        /* N-6: 已达条目上限则停止翻页 —— 内层 for-of 的 break 只跳出本页条目循环,
           外层分页循环不感知, 会继续多发最多 39 次无效请求 */
        if (list.length >= MAX_ENTRIES) break;
        const body = { knowledge_base_id: kbId, cursor: cursor, limit: 50 };
        if (folderId) body.folder_id = folderId;
        const d = await self.post('/openapi/wiki/v1/get_knowledge_list', body);
        const infos = d.knowledge_list || [];
        for (const x of infos) {
          if (list.length >= MAX_ENTRIES) break;
          if (x.media_type === 99) {
            if (x.media_id && !visited.has(x.media_id)) {
              visited.add(x.media_id);
              subFolders.push({ id: x.media_id, path: folderPath ? folderPath + '/' + x.title : x.title });
            }
            continue;
          }
          list.push({ mediaId: x.media_id, title: x.title, mediaType: x.media_type, folderPath: folderPath || '' });
        }
        if (d.is_end || !d.next_cursor || infos.length === 0) break;
        cursor = d.next_cursor;
      }
      for (const f of subFolders) await walk(f.id, f.path, depth + 1);
    };
    await walk('', '', 0);
    return list;
  }
  /* 拉取方向: 取原文下载链接 (签名 URL + 专用 headers) */
  getMediaInfo(mediaId) {
    return this.post('/openapi/wiki/v1/get_media_info', { media_id: mediaId });
  }
  async listAddableKBs() {
    const list = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const d = await this.post('/openapi/wiki/v1/get_addable_knowledge_base_list', { cursor: cursor, limit: 50 });
      const infos = d.addable_knowledge_base_list || [];
      infos.forEach(x => list.push({ id: x.id, name: x.name, count: x.content_count }));
      if (d.is_end || !d.next_cursor || infos.length === 0) break;
      cursor = d.next_cursor;
    }
    return list;
  }
  /* 检查同名, 返回 {name: is_repeated} 映射 (media_type 按每个名字的扩展名自动判定) */
  async checkRepeatedNames(kbId, folderId, names) {
    const d = await this.post('/openapi/wiki/v1/check_repeated_names', {
      knowledge_base_id: kbId,
      folder_id: folderId || undefined,
      params: names.map(n => {
        const info = fileTypeInfo(n);
        return { name: n, media_type: info ? info.media_type : MEDIA_TYPE_MD };
      })
    });
    const map = {};
    (d.results || []).forEach(r => { map[r.name] = !!r.is_repeated; });
    return map;
  }
  createMedia(kbId, fileName, size, contentType, fileExt) {
    return this.post('/openapi/wiki/v1/create_media', {
      knowledge_base_id: kbId,
      file_name: fileName,
      file_size: size,
      content_type: contentType,
      file_ext: fileExt
    });
  }
  /* add_knowledge 未封装成独立方法: 它需要 create_media 返回的 cos_key, 完整上传链见 uploadToKB */
}

/* add_knowledge 需要 cos_key, 但它在 create_media 返回的凭证里, 单独封装完整上传链 (类型按文件名自动判定) */
async function uploadToKB(api, kbId, folderId, fileName, data, title, absPath, sizeOverride) {
  const info = fileTypeInfo(fileName) || EXT_MAP.md;
  const size = data ? data.byteLength : sizeOverride;
  if (typeof size !== 'number') throw new Error('uploadToKB: 缺少文件大小');
  const d = await api.createMedia(kbId, fileName, size, info.content_type, (fileName.match(/\.([a-z0-9]+)$/i) || ['', 'md'])[1].toLowerCase());
  const mediaId = d.media_id;
  const cred = d.cos_credential || d;
  /* VULN-01 修复: 异常消息只输出脱敏后的字段摘要, 不再把 cos_credential 的 secret_key/token 序列化出去 */
  if (!mediaId || !cred.cos_key) throw new Error('create_media 返回缺字段: ' + JSON.stringify(redactCred(d)).slice(0, 200));
  await cosUpload(cred, data, info.content_type, absPath, size);
  const r = await api.post('/openapi/wiki/v1/add_knowledge', {
    knowledge_base_id: kbId,
    folder_id: folderId || undefined,
    media_type: info.media_type,
    media_id: mediaId,
    title: title,
    file_info: {
      cos_key: cred.cos_key,
      file_name: fileName,
      file_size: size,
      last_modify_time: Math.floor(Date.now() / 1000)
    }
  });
  return r.media_id || mediaId;
}

/* ---------- 状态栏面板: 手动上传按钮 + 进度条 (容器由 addStatusBarItem 提供) ---------- */

class StatusPanel {
  /* onProgress(phase, item): 进度心跳回调, 转发给插件记录运行态(供运行中提示与看门狗使用) */
  constructor(container, onSync, onProgress) {
    this.hideTimer = null;
    this.onProgress = typeof onProgress === 'function' ? onProgress : null;

    this.root = container.createEl('div');
    this.root.style.cssText =
      'display:inline-flex;align-items:center;gap:6px;max-width:300px;' +
      'font-family:var(--font-interface);font-size:11px;line-height:1.2;' +
      'color:var(--text-normal);';

    this.btn = this.root.createEl('button', { text: '杨 ⇅' });
    this.btn.style.cssText =
      'flex:0 0 auto;padding:2px 7px;cursor:pointer;font-size:11px;' +
      'border:1px solid var(--background-modifier-border);border-radius:4px;' +
      'background:var(--interactive-normal);color:var(--text-normal);';
    this.btn.setAttribute('aria-label', '杨宇轩：知识库同步（点击按同步规则排列顺序依次执行）');
    this.btn.onclick = () => { if (!this.btn.disabled) onSync(); };

    this.body = this.root.createEl('div');
    this.body.style.cssText = 'flex:1 1 auto;min-width:0;display:none;align-items:center;gap:6px;';

    this.bar = this.body.createEl('div');
    this.bar.style.cssText =
      'flex:0 0 auto;width:56px;height:4px;border-radius:2px;overflow:hidden;' +
      'background:var(--background-modifier-border);';

    this.fill = this.bar.createEl('div');
    this.fill.style.cssText = 'height:100%;width:0%;background:var(--interactive-accent);transition:width .2s;';

    this.infoEl = this.body.createEl('div');
    this.infoEl.style.cssText = 'opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  }

  start(total, label) {
    if (this.onProgress) this.onProgress(label || '同步中', '');
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    this.btn.setText(label || '同步中');
    this.btn.disabled = true;
    this.btn.style.opacity = '.55';
    this.btn.style.cursor = 'default';
    this.body.style.display = '';
    this.fill.style.background = 'var(--interactive-accent)';
    this.update(0, total, '');
  }

  update(done, total, name) {
    if (this.onProgress) this.onProgress('', done + '/' + total + (name ? ' ' + name : ''));
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    this.fill.style.width = pct + '%';
    this.infoEl.setText(done + '/' + total + ' ' + pct + '%' + (name ? ' · ' + name : ''));
  }

  finish(text, isError) {
    this.btn.setText('杨 ⇅');
    this.btn.disabled = false;
    this.btn.style.opacity = '';
    this.btn.style.cursor = 'pointer';
    this.fill.style.width = '100%';
    this.fill.style.background = isError ? 'var(--color-red)' : 'var(--color-green)';
    this.infoEl.setText((isError ? '✗ ' : '✓ ') + text);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => this.idle(), 6000);
  }

  idle() {
    this.body.style.display = 'none';
    this.fill.style.width = '0%';
    this.fill.style.background = 'var(--interactive-accent)';
  }

  destroy() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    if (this.root) this.root.remove();
  }
}

/* ---------- main plugin ---------- */

class ImaPushPlugin extends Plugin {
  async onload() {
    /* 版本标记: 插件 main.js 不热重载, 改完必须关/开插件或重启 OB 才生效。
       在控制台(Ctrl+Shift+I)看到这行即证明跑的是新代码 */
    console.log('[ima-sync] loaded v' + this.pluginVersion() + ' (refactor: 脱敏/哈希/目录数组/超时清理/锁/批量保存/行级定时凭据检查/冗余收敛 runPush-runPull-路径谓词-preHash-迁移清旧字段/运行看门狗-强制解锁-本地IO超时)');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.migrateRules();
    /* 运行态 (2026-10-02): running = 有任务持锁; 其余四项供「运行中提示」与看门狗读取 */
    this.running = false;
    this.runStartedAt = 0;   /* 本轮任务开始时刻(ms), 0 = 无任务 */
    this.runPhase = '';      /* 当前阶段: 比对中 / 上传中 / 拉取中 ... */
    this.runItem = '';       /* 当前条目: 12/31 xxx.pdf */
    this.runLastBeat = 0;    /* 最近一次进度心跳(ms) */
    this._stallWarned = false;
    this._gitWarned = false;
    this.api = new ImaApi(this.settings.clientId, this.settings.apiKey, this.pluginVersion());

    /* 状态栏(右下角)面板: [杨宇轩 ↑↓] 单按钮 + 进度条, 点击双向同步 */
    const statusItem = this.addStatusBarItem();
    statusItem.style.marginLeft = 'auto';   /* 推到状态栏右侧 */
    statusItem.style.display = 'flex';
    statusItem.style.alignItems = 'center';
    this.panel = new StatusPanel(statusItem, () => this.syncAll(), (phase, item) => this.noteProgress(phase, item));

    /* 唯一竖栏图标: 同样触发双向同步, 与右下角按钮等价; 图标内容替换为「杨」字 */
    const _rib = this.addRibbonIcon('database', '杨宇轩：知识库同步', () => this.syncAll());
    _rib.empty();
    _rib.style.cssText += 'display:flex;align-items:center;justify-content:center;';
    const _ribTxt = _rib.createEl('span', { text: '杨' });
    _ribTxt.style.cssText = 'font-size:16px;font-weight:700;line-height:1;color:var(--text-normal);';

    this.addCommand({
      id: 'push-all',
      name: 'Push now（按同步规则上传到知识库）',
      callback: () => this.pushAll(false)
    });
    this.addCommand({
      id: 'push-current',
      name: 'Push current note（上传当前笔记）',
      callback: () => this.pushCurrent()
    });
    this.addCommand({
      id: 'push-all-force',
      name: 'Force re-push all（忽略本地记录，全部重新上传）',
      callback: () => this.pushAll(true)
    });
    this.addCommand({
      id: 'pull-from-ima',
      name: 'Pull from IMA（拉取知识库笔记到本地）',
      callback: () => this.pullAll()
    });
    this.addCommand({
      id: 'sync-two-way',
      name: 'Sync（双向同步：按同步规则排列顺序依次执行）',
      callback: () => this.syncAll()
    });
    /* 2026-10-02: 运行锁卡死时的唯一出口 —— 任务卡在无超时的本地 I/O 上时界面不会自己恢复 */
    this.addCommand({
      id: 'force-unlock',
      name: 'Force unlock（强制解锁：上一次任务一直提示未结束时用）',
      callback: () => { void this.forceUnlock('手动'); }
    });

    this.addSettingTab(new ImaPushSettingTab(this.app, this));

    /* 定时同步 (v0.6.0): 每分钟检查一次是否到达设定时刻 */
    this.setupTimers();
    /* 运行看门狗 (2026-10-02): 每分钟检查运行中的任务是否已无进展 */
    this.setupRunWatchdog();
  }

  onunload() {
    if (this.panel) this.panel.destroy();
  }

  pluginVersion() {
    return (this.manifest && this.manifest.version) || '0.0.0';
  }

  /* ---------- 运行态与看门狗 (2026-10-02) ----------
     running 是互斥锁: 一次触发(双向同步/上传/拉取/定时)从开始到汇总结束一直持有, 期间再点会被拦下。
     拦截本身是预期行为, 但必须能区分"还在跑"与"卡死了" —— 因此记录开始时刻/阶段/心跳,
     并提供看门狗(无活动告警 + 超长时间自动解锁)与命令面板「强制解锁」。 */

  /* 取锁: tag 进提示文案(如"双向同步") */
  beginRun(tag) {
    this.running = true;
    this.runStartedAt = Date.now();
    this.runPhase = tag || '同步';
    this.runItem = '';
    this.runLastBeat = Date.now();
    this._stallWarned = false;
  }

  /* 放锁: 幂等, 重复调用不会清掉新一轮的状态 */
  endRun() {
    if (!this.running) return;
    this.running = false;
    this.runStartedAt = 0;
    this.runPhase = '';
    this.runItem = '';
    this.runLastBeat = 0;
    this._stallWarned = false;
  }

  /* 进度心跳: 由面板 start/update 转发; phase 为空表示只刷新条目与心跳 */
  noteProgress(phase, item) {
    if (!this.running) return;
    if (phase) this.runPhase = phase;
    if (item) this.runItem = item;
    this.runLastBeat = Date.now();
  }

  /* 本轮已运行时长, 人读格式 */
  runElapsed() {
    if (!this.running) return '0 秒';
    const s = Math.round(Math.max(0, Date.now() - this.runStartedAt) / 1000);
    if (s < 60) return s + ' 秒';
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }

  /* 最近一次活动的距今毫秒: 进度心跳与网络活动取较新者 */
  runIdleMs() {
    const last = Math.max(this.runLastBeat || 0, lastNetActivity || 0, this.runStartedAt || 0);
    return Math.max(0, Date.now() - last);
  }

  /* 运行中拦截统一提示: 带上已运行时长与当前阶段, 便于分辨"正常在跑"与"卡住了" */
  busyNotice() {
    const where = [this.runPhase, this.runItem].filter(Boolean).join(' ');
    new Notice('知识库同步：上一次任务还没结束（已运行 ' + this.runElapsed()
      + (where ? '，当前：' + where : '') + '）。请等右下角汇总提示；若长时间无变化，'
      + '可在命令面板执行「Force unlock 强制解锁」', 8000);
  }

  /* 强制释放运行锁: 卡死时的唯一出口; 已落盘数据与已下载文件不受影响 */
  async forceUnlock(reason) {
    if (!this.running) { new Notice('知识库同步：运行锁当前是空闲的，无需解锁'); return false; }
    const startedAt = this.runStartedAt || Date.now();
    const stage = [this.runPhase, this.runItem].filter(Boolean).join(' ') || '未知';
    const idleMs = this.runIdleMs();
    this.endRun();
    this.panel.idle();
    /* 留证: 卡死原因事后无从追查, 落一条记录进 data.json 的 lastWatchdog */
    this.settings.lastWatchdog = {
      at: Date.now(),
      reason: reason || '手动',
      ranMs: Date.now() - startedAt,
      idleMs: idleMs,
      stage: stage
    };
    console.warn('[ima-push] 运行锁已强制释放: 原因=' + (reason || '手动')
      + ' 已运行=' + Math.round((Date.now() - startedAt) / 1000) + 's'
      + ' 无活动=' + Math.round(idleMs / 1000) + 's 阶段=' + stage);
    try { await this.saveSettings(); } catch (e) { console.error('[ima-push] 看门狗记录保存失败', e); }
    new Notice('知识库同步：已强制释放运行锁（原任务若仍在后台跑，其收尾不会再影响面板）', 6000);
    return true;
  }

  /* 运行看门狗: 每分钟一次; 无活动超 WARN 提示, 超 AUTO 判定卡死并自动解锁 */
  checkRunWatchdog() {
    if (!this.running) return;
    const idleMs = this.runIdleMs();
    const mins = Math.round(idleMs / 60000);
    const where = [this.runPhase, this.runItem].filter(Boolean).join(' ') || '未知';
    if (idleMs >= RUN_STALL_AUTO_MS) {
      console.warn('[ima-push] 运行看门狗: ' + mins + ' 分钟无任何活动, 判定任务卡死');
      void this.forceUnlock('看门狗: ' + mins + ' 分钟无活动');
      return;
    }
    if (idleMs >= RUN_STALL_WARN_MS && !this._stallWarned) {
      this._stallWarned = true;
      console.warn('[ima-push] 运行看门狗: 已 ' + mins + ' 分钟无进展, 阶段=' + where);
      new Notice('知识库同步：任务已 ' + mins + ' 分钟没有进展（当前：' + where
        + '），可能卡住了 —— 可在命令面板执行「Force unlock 强制解锁」', 10000);
    }
  }

  setupRunWatchdog() {
    this.registerInterval(window.setInterval(() => this.checkRunWatchdog(), 60 * 1000));
  }

  /* ---------- 定时同步 (v0.6.0) ---------- */
  /* 每分钟轮询: 到点且当天未跑过 -> 触发。registerInterval 保证插件卸载时自动清理定时器 */
  setupTimers() {
    const tick = () => { void this.checkTimers(); };
    this.registerInterval(window.setInterval(tick, 60 * 1000));
    const _t0 = window.setTimeout(tick, 5000);   /* 启动 5 秒后先查一次, 不必等满一分钟 */
    this.register(() => window.clearTimeout(_t0));   /* 注册进插件生命周期, 卸载时清理, 防止卸载后触发回调 */
  }

  /* 今日日期键 YYYY-MM-DD */
  todayKey() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /* 校验并归一化 HH:MM, 非法返回 null */
  normTime(v) {
    const m = String(v || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h < 0 || h > 23 || mi < 0 || mi > 59) return null;
    const p = n => String(n).padStart(2, '0');
    return p(h) + ':' + p(mi);
  }

  async checkTimers() {
    const now = new Date();
    const p = n => String(n).padStart(2, '0');
    const hhmm = p(now.getHours()) + ':' + p(now.getMinutes());
    const today = this.todayKey();
    /* 规则表行级定时优先: 存在带时刻的规则行时, 旧的全局定时推送/拉取不再执行 */
    if (await this.runRuleTimers(today, hhmm)) return;
    const jobs = [
      { key: 'timerPush', label: '推送', run: b => this.pushAll(false, b) },
      { key: 'timerPull', label: '拉取', run: b => this.pullAll(b) }
    ];
    /* 先筛出这一 tick 真正要跑的作业, 让它们共用一个批次号 (一次触发 = 汇总里一行) */
    const due = [];
    for (const job of jobs) {
      const cfg = this.settings[job.key];
      if (!cfg || !cfg.enabled) continue;
      const t = this.normTime(cfg.time);
      if (!t || hhmm < t) continue;                     /* 时刻未到或格式非法; 到点/晚点均触发, 规避后台节流漏跑 */
      if (cfg.lastDate === today) continue;             /* 当天已跑过 */
      if (this.running) {                               /* 上一次任务还在跑, 本次让位 */
        console.log('[ima-push] 定时' + job.label + '跳过: 上一次任务仍在运行');
        continue;
      }
      due.push({ job, cfg, t });
    }
    if (!due.length) return;
    const batch = this.newBatchId();
    for (const d of due) {
      d.cfg.lastDate = today;                           /* 先落盘再执行, 防止崩溃后重复触发 */
      try { await this.saveSettings(); } catch (e) { console.error('[ima-push] 定时状态保存失败', e); }
      new Notice('知识库同步：定时' + d.job.label + '触发（' + d.t + '）');
      await d.job.run(batch);
    }
  }

  async saveSettings() {
    try {
      await vaultIO(this.saveData(this.settings), '保存设置');
    } catch (e) {
      /* 失败必须可见: 设置页 onChange 是异步回调, 只抛错的话用户只会看到"改了没生效" */
      console.error('[ima-push] 保存设置失败', redactText(safeErrMsg(e)));
      new Notice('知识库同步：设置保存失败（' + safeErrMsg(e) + '）', 6000);
      throw e;
    }
    this._pushTargets = null;   /* INFO-1: 规则可能已改动, 失效推送目标缓存, 下轮重建 */
    this.api = new ImaApi(this.settings.clientId, this.settings.apiKey, this.pluginVersion());
    /* VULN-02 低成本方案: 检测 vault 是否在 git 仓库中, 提醒密钥随仓库外泄的风险 */
    if (this.settings.apiKey && !this._gitWarned) {
      this._gitWarned = true;
      this.warnGitExposure();
    }
  }

  getVaultBasePath() {
    try {
      const ad = this.app.vault.adapter;
      if (ad && typeof ad.getBasePath === 'function') return ad.getBasePath();
    } catch (e) { /* 忽略 */ }
    return null;
  }

  warnGitExposure() {
    try {
      const base = this.getVaultBasePath();
      if (base && fs.existsSync(nodePath.join(base, '.git'))) {
        new Notice('提示：检测到 vault 位于 git 仓库中。API Key 明文保存在 data.json，建议将 .obsidian/plugins/tencent-ima-sync/data.json 加入 .gitignore 后再提交', 8000);
      }
    } catch (e) { /* 提示失败不影响主流程 */ }
  }

  getWhitelist() { return parseWhitelist(this.settings.whitelist); }

  inWhitelist(path) {
    const list = this.getWhitelist();
    if (!list.length) return false;
    return list.some(dir => path === dir + '.md' || path.startsWith(dir + '/'));
  }

  /* 旧配置(白名单/v0.6.2映射表/拉取多选/两套定时) -> 统一规则表 dirMappings, 仅旧数据首次加载时执行一次 */
  migrateRules() {
    const s = this.settings;
    const cur = Array.isArray(s.dirMappings) ? s.dirMappings : [];
    /* 已全部是新格式(有 direction 字段且无旧 src 字段) -> 不迁移 */
    if (cur.length && cur.every(m => m && !m.src && typeof m.direction === 'string')) return;
    const rules = [];
    /* ① v0.6.2 目录→知识库映射行: 每条 → 一行, 继承旧的全局定时推送时刻 */
    const pushTime = (s.timerPush && s.timerPush.enabled) ? (s.timerPush.time || '') : '';
    cur.forEach(m => {
      const d = normDir(m.src);
      if (d && m.kbId) {
        const r = { dirs: [d], dir: d, kbId: m.kbId, kbName: m.kbName || '', direction: 'push', time: pushTime, timerDone: '' };
        rules.push(r);
      }
    });
    /* ② 白名单里没有映射覆盖的目录 → 归到默认兜底库一行(定时同样继承) */
    const wl = this.getWhitelist();
    const mapped = rules.map(r => r.dir);
    const wlUncovered = wl.filter(d => !mapped.some(md => d === md || d.startsWith(md + '/')));
    if (wlUncovered.length && s.targetKbId)
      rules.push({ dirs: wlUncovered.slice(), dir: wlUncovered.join(','), kbId: s.targetKbId, kbName: s.targetKbName || '', direction: 'push', time: pushTime, timerDone: '' });
    /* ③ 拉取: pullKbList 多库 + pullDir → 合并成一行 ← (发起方多选、接收方单选) */
    const pullTime = (s.timerPull && s.timerPull.enabled) ? (s.timerPull.time || '') : '';
    const pullKbs = this.getPullKbs();
    if (pullKbs.length) {
      const pd = normDir(s.pullDir);
      const r = { dirs: pd ? [pd] : [], dir: pd, kbId: '', kbName: '', kbIds: [], kbNames: [], direction: 'pull', time: pullTime, timerDone: '' };
      this.setRuleKbs(r, pullKbs, false);
      rules.push(r);
    }
    /* 统一补齐 kbIds/kbNames: 上传行只留第一个(接收方单选), 拉取行保留全部(发起方多选) */
    rules.forEach(r => this.setRuleKbs(r, this.ruleKbs(r), r.direction !== 'pull'));
    if (rules.length) {
      s.dirMappings = rules;
      /* 旧全局定时已折算进行内时间, 必须关掉, 否则清空行内时间后旧定时会"复活"且无 UI 可关 */
      if (s.timerPush) s.timerPush.enabled = false;
      if (s.timerPull) s.timerPull.enabled = false;
      /* 冗余收敛(兼容链): 旧字段已全部折算进规则表, 迁移完成后清空 ——
         data.json 瘦身, 并关闭"旧白名单/旧拉取配置/旧定时"这些已被规则表取代的隐藏读取路径 */
      s.whitelist = '';
      s.pullKbId = '';
      s.pullKbName = '';
      s.pullKbList = [];
      s.pullDir = '';
      if (s.timerPush) { s.timerPush.time = ''; s.timerPush.lastDate = ''; }
      if (s.timerPull) { s.timerPull.time = ''; s.timerPull.lastDate = ''; }
      this.saveSettings().catch(e => console.error('[ima-sync] 迁移配置保存失败', e));
      new Notice('IMA 同步：已将旧配置自动迁移为 ' + rules.length + ' 条同步规则（上传/拉取设置已合并为一张规则表）');
    }
  }

  /* 规则表: [{dirs:[], dir, kbId, kbName, kbIds, kbNames, direction:'push'|'pull', time:'HH:MM'|'', timerDone:'YYYY-MM-DD'}]
     方向决定谁是发起方: → 发起方=目录(可多选)/接收方=知识库(单选); ← 发起方=知识库(可多选)/接收方=目录(单选) */
  getRules() { return Array.isArray(this.settings.dirMappings) ? this.settings.dirMappings : []; }
  pushRules() { return this.getRules().filter(r => r && r.kbId && r.direction !== 'pull' && this.ruleDirs(r).length); }
  pullRules() { return this.getRules().filter(r => r && r.direction === 'pull' && this.ruleKbs(r).length); }

  /* VULN-04 修复: 目录读取优先数组 dirs, 旧数据(dir 逗号串)回落拆分。
     含逗号的真实目录名在新写入路径下不再歧义 */
  ruleDirs(r) {
    if (!r) return [];
    const raw = Array.isArray(r.dirs) ? r.dirs : [];
    if (raw.length) return raw.map(normDir).filter(Boolean);
    return String(r.dir || '').split(',').map(normDir).filter(Boolean);
  }

  /* VULN-04 修复: 目录写入统一走数组 dirs(去重保序), dir 逗号串同步维护仅为旧读路径兼容 */
  setRuleDirs(r, list) {
    const arr = (list || []).map(normDir).filter(Boolean);
    const seen = new Set();
    const uniq = [];
    arr.forEach(d => { if (!seen.has(d)) { seen.add(d); uniq.push(d); } });
    r.dirs = uniq;
    r.dir = uniq.join(',');
  }

  /* R-05: 路径-目录前缀匹配谓词 (原 5 处复制, 收敛后单点维护) */
  pathInDirs(path, dirs) {
    return dirs.some(d => path === d + '.md' || path.startsWith(d + '/'));
  }

  /* R-05: 推送范围判断 —— 旧白名单(兼容) 或 任一 push 规则目录。
     pushFile/pushCurrent 的调用方已按规则过滤, 此处为防御性校验(纵深防御), 非必要业务逻辑 */
  inPushScope(path) {
    /* INFO-1: 同样走 pushTargets() 缓存, 不再每个文件重建规则数组 */
    return this.inWhitelist(path) || this.pushTargets().some(t => this.pathInDirs(path, t.dirs));
  }

  /* 规则行的知识库集合: 优先多选数组 kbIds/kbNames, 回落单值 kbId/kbName(旧数据 & 上传行) */
  ruleKbs(r) {
    if (!r) return [];
    const ids = Array.isArray(r.kbIds) ? r.kbIds.filter(Boolean) : [];
    const names = Array.isArray(r.kbNames) ? r.kbNames : [];
    if (ids.length) return ids.map((id, i) => ({ id, name: names[i] || id }));
    return r.kbId ? [{ id: r.kbId, name: r.kbName || r.kbId }] : [];
  }
  /* 写回知识库集合(keep-one: 上传行只保留第一个, 因为接收方只能单选) */
  setRuleKbs(r, list, keepOne) {
    const arr = (list || []).filter(k => k && k.id);
    const use = keepOne ? arr.slice(0, 1) : arr;
    r.kbIds = use.map(k => k.id);
    r.kbNames = use.map(k => k.name || k.id);
    r.kbId = use.length ? use[0].id : '';
    r.kbName = use.length ? (use[0].name || use[0].id) : '';
  }

  /* INFO-1: 整轮推送复用 —— 原实现在逐文件循环里反复 pushRules() 重建数组, 并对每条规则再 ruleDirs() 拆串,
     复杂度 O(文件数×规则数)(当前规模无感, 规则多了白白浪费)。这里一次构建 {dirs,kbId,kbName} 缓存整轮复用;
     缓存随 saveSettings() 与 runPush 结束失效, 保证用户改规则后下次即生效 */
  pushTargets() {
    if (!this._pushTargets) {
      this._pushTargets = this.pushRules().map(r => ({ dirs: this.ruleDirs(r), kbId: r.kbId, kbName: r.kbName }));
    }
    return this._pushTargets;
  }

  /* 解析某文件应上传到的目标知识库: 只认规则表(push 行, 目录前缀命中)。
     业务隐患②: 原实现未命中时静默回落 settings.targetKbId —— 该字段无 UI 入口(2026-09-11 已移除设置项),
     属"静默生效且用户不可控"。现移除兜底: 未命中规则即无目标(该文件不上传), 行为显式。 */
  resolvePushKb(filePath) {
    for (const t of this.pushTargets()) {
      if (this.pathInDirs(filePath, t.dirs)) return { kbId: t.kbId, kbName: t.kbName };
    }
    return { kbId: '', kbName: '' };
  }

  /* ---------- 推送入口 (R-04: pushAll 与 pushRulesOnly 收敛为 runPush 单一核心) ----------
     pushAll       = 独立推送入口(命令面板/旧全局定时): 完整提示 + 白名单回落 + 存在性校验 + lastPushResult
     pushRulesOnly = 按规则行执行(双向同步/行级定时逐行调用): 无独立提示, deferFinish/locked 由调用方决定 */
  async pushAll(force, batch) {
    if (this.running) { this.busyNotice(); return; }
    if (this.settings.enablePush === false) { new Notice('知识库同步：上传方向已被开关关闭，如需上传请在设置里开启'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('知识库同步：请先在设置里填 Client ID / API Key'); return; }
    const prules = this.pushRules();
    if (!prules.length) {
      new Notice('知识库同步：请先在「同步规则」里添加上传规则（目录 → 知识库）'); return;
    }
    this.beginRun('上传');
    try {
      await this.runPush(prules, batch, false, { force, full: true, compare: true });
    } finally {
      this.endRun();
    }
  }

  /* 推送核心 (R-04): 文件收集 → 可选存在性校验 → 逐文件上传 → 汇总落盘。
     opts.force   : 忽略本地记录与存在性校验, 全部重传
     opts.full    : 独立入口语义(白名单回落、0 文件 Notice、lastPushResult、"完成"面板文案、控制台输出)
     opts.compare : 执行服务端存在性校验(远端已删→自动重传); 逐行调用保持原行为不比对 */
  async runPush(rules, batch, deferFinish, opts) {
    const o = Object.assign({ force: false, full: false, compare: false }, opts || {});
    const stats = { total: 0, created: 0, renamed: 0, skipped: 0, failed: 0 };
    const errors = [];
    try {
      /* 上传范围 = 各 push 规则勾选的目录(前缀匹配); full 模式无规则时回落旧白名单 */
      let files;
      if (rules && rules.length) {
        const dirs = [];
        rules.forEach(r => this.ruleDirs(r).forEach(d => { if (!dirs.includes(d)) dirs.push(d); }));
        files = this.app.vault.getFiles().filter(f => this.pathInDirs(f.path, dirs));
      } else {
        /* full 模式无规则: 回落旧白名单(兼容); 迁移已清空 whitelist, 实际为空 */
        files = this.app.vault.getFiles().filter(f => this.inWhitelist(f.path));
      }
      const resolvable = files.filter(f => !!this.resolvePushKb(f.path).kbId);
      if (resolvable.length < files.length)
        console.warn('[ima-push] 部分文件未匹配到目标库(无规则且无默认库), 已跳过', files.length - resolvable.length);
      stats.total = resolvable.length;
      if (resolvable.length === 0) {
        if (o.full) new Notice('知识库同步：规则勾选的目录下没有找到任何可上传的文件');
        await this.recordRun('push', stats, [], batch);   // 0 文件也是一次运行, 必须留痕
        return;
      }
      /* 比对阶段: 本地 hash 比对 + 服务端存在性校验, 先于上传; 状态栏显式标「比对中」 */
      const forceSet = new Set();
      const preHashes = new Map();   /* R-06: 比对阶段算好的 path->hash 传给 pushFile, 同一 md 文件只算一遍 */
      if (o.compare && !o.force) {
        this.panel.start(resolvable.length, '比对中');
        let cmpDone = 0;
        try {
          const unchanged = [];
          for (const f of resolvable) {
            cmpDone++;
            this.panel.update(cmpDone - 1, resolvable.length, f.name);
            const info = fileTypeInfo(f.name);
            if (!info) { this.panel.update(cmpDone, resolvable.length, f.name); continue; }
            let h;
            if (info.media_type === MEDIA_TYPE_MD) {
              const raw = await vaultIO(this.app.vault.cachedRead(f), '读取 ' + f.name);
              const body = stripFrontmatter(raw);
              if (!body.trim()) { this.panel.update(cmpDone, resolvable.length, f.name); continue; }
              h = hashStr(body);
              preHashes.set(f.path, h);
            } else {
              h = await hashBinaryFile(this.app, f);
            }
            const kbId = this.resolvePushKb(f.path).kbId;
            const st = this.settings.fileStates[f.path];
            if (st && st.pushHash === h && st.kbId === kbId)
              unchanged.push({ path: f.path, name: st.uploadedName, kbId });
            this.panel.update(cmpDone, resolvable.length, f.name);
          }
          /* 按目标库分组校验同名: 不同库的文件不能互相干扰 */
          const byKb = new Map();
          for (const u of unchanged) {
            if (!byKb.has(u.kbId)) byKb.set(u.kbId, []);
            byKb.get(u.kbId).push(u);
          }
          /* 修复: gone 按 kbId 合并, 不再被最后一个 chunk 覆盖 —— 否则前几批"远端已删"判定丢失, 自动补传漏触发 */
          const gone = new Map();
          for (const [kbId, us] of byKb) {
            const names = [...new Set(us.map(u => u.name))];
            for (let i = 0; i < names.length; i += 50) {
              const chunk = names.slice(i, i + 50);
              const rep = await this.api.checkRepeatedNames(kbId, null, chunk);
              if (!gone.has(kbId)) gone.set(kbId, new Set());
              const gs = gone.get(kbId);
              chunk.forEach(n => { if (rep[n] === false) gs.add(n); });
            }
          }
          unchanged.forEach(u => { const gs = gone.get(u.kbId); if (gs && gs.has(u.name)) forceSet.add(u.path); });
          if (forceSet.size) console.log('[ima-push] 服务端已删除, 将自动重传:', [...forceSet]);
        } catch (e) {
          console.warn('[ima-push] 服务端存在性校验失败, 退回纯本地增量模式:', redactText(safeErrMsg(e)));
        }
      }
      /* 比对结束(或强制重传跳过比对), 进入上传阶段 */
      await this.processPushFiles(resolvable, f => o.force || forceSet.has(f.path), stats, errors, preHashes);

      this.settings.lastPushAt = Date.now();
      if (o.full) {
        /* 失败清单落盘: 只在控制台打印的话事后无从追查, 这里持久化最近 20 条(已脱敏) */
        this.settings.lastPushResult = {
          at: Date.now(),
          total: stats.total,
          created: stats.created,
          renamed: stats.renamed,
          skipped: stats.skipped,
          failed: stats.failed,
          errors: errors.slice(0, 20).map(redactText)
        };
      }
      /* 落盘失败不应把"文件都已传完"的一轮报成异常中断: 记录后继续收尾 */
      try { await this.saveSettings(); } catch (e) { console.error('[ima-push] 推送结果落盘失败', e); }
      await this.recordRun('push', stats, errors, batch);

      const msg = o.full
        ? '完成：新增 ' + stats.created + ' / 换名 ' + stats.renamed + ' / 跳过 ' + stats.skipped + ' / 失败 ' + stats.failed
        : '同步完成（上传）：新增 ' + stats.created + ' / 跳过 ' + stats.skipped + ' / 失败 ' + stats.failed;
      if (!deferFinish) this.panel.finish(msg, errors.length > 0);
      if (o.full) {
        if (errors.length) console.warn('[ima-push] failures:', errors.map(redactText));
        console.log('[ima-push]', msg, stats);
      }
    } catch (e) {
      if (!deferFinish) this.panel.finish('推送异常中断：' + safeErrMsg(e), true);
      if (o.full) console.error('[ima-push]', e);
      errors.push('异常中断 — ' + safeErrMsg(e));
      await this.recordRun('push', stats, errors, batch);
    } finally {
      this._pushTargets = null;   /* INFO-1: 一轮结束释放缓存, 下轮重新读取最新规则 */
    }
  }

  /* 核心上传循环: 逐文件 pushFile + 统计 + 周期落盘检查点 (每 20 个文件一次)
     preHashes: R-06 比对阶段算好的 path->hash, 传给 pushFile 避免同一 md 文件重复计算 */
  async processPushFiles(resolvable, isForce, stats, errors, preHashes) {
    this.panel.start(resolvable.length, '上传中');
    let done = 0;
    for (const file of resolvable) {
      done++;
      try {
        this.panel.update(done - 1, resolvable.length, file.name);
        const r = await this.pushFile(file, isForce(file), false, preHashes && preHashes.get(file.path));
        this.panel.update(done, resolvable.length, file.name);
        if (r.result === 'skipped') stats.skipped++;
        else if (r.result === 'created') stats.created++;
        else if (r.result === 'renamed') stats.renamed++;
        else stats.failed++;
        /* 性能: 批量任务内存累计 fileStates, 每 20 个文件落盘一次检查点,
           避免上千文件每次全量序列化 data.json(含 fileStates 全量) */
        if (done % 20 === 0) { try { await this.saveSettings(); } catch (e) { console.error('[ima-push] 检查点落盘失败', e); } }
      } catch (err) {
        stats.failed++;
        errors.push(file.path + ' — ' + safeErrMsg(err));
      }
    }
  }

  /* ---------- 双向同步: 按「同步规则」表的排列顺序自上而下逐行执行 ----------
     行序即执行序 —— 每行按自己的箭头方向跑(→ 上传该行目录 / ← 拉取该行知识库)。
     一次触发共用一个批次号, 各行结果在「运行汇总」里合并成一行。 */
  async syncAll() {
    if (this.running) { this.busyNotice(); return; }
    const doPush = this.settings.enablePush !== false;
    const doPull = this.settings.enablePull !== false;
    if (!doPush && !doPull) { new Notice('知识库同步：上传和拉取开关都已关闭，请到设置里至少开启一个方向'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('知识库同步：请先在设置里填 Client ID / API Key'); return; }

    /* 可执行的规则行: 目录和知识库都选好了, 且该方向没被开关关掉 */
    const rows = this.getRules().filter(r => {
      if (!r || !this.ruleDirs(r).length) return false;
      return r.direction === 'pull' ? (doPull && this.ruleKbs(r).length > 0) : (doPush && !!r.kbId);
    });
    if (!rows.length) {
      new Notice('知识库同步：没有可执行的规则 — 请在「同步规则」里添加规则（目录 ↔ 知识库）');
      return;
    }

    /* 修复: 外层统一持运行锁, 消除逐行调用间(上一行结束→下一行开始)的竞态窗口 */
    this.beginRun('双向同步');
    const batch = this.newBatchId();
    try {
      for (const r of rows) {
        if (r.direction === 'pull') await this.pullRulesOnly([r], batch, true, true);
        else await this.pushRulesOnly([r], batch, true, true);
      }
      this.finishBatchPanel(batch);   /* 全部行跑完才收尾, 汇总本批次所有行 */
    } finally {
      this.endRun();
    }
  }

  /* ---------- 定时: 规则表行级 time 触发(每天一行一跑); 无行级定时时回落旧全局定时 ---------- */
  /* 返回 true 表示本轮 tick 已由行级定时接管, checkTimers 不再走旧的全局定时 */
  async runRuleTimers(today, hhmm) {
    const rules = this.getRules().filter(r => r && this.normTime(r.time) && (r.direction === 'pull' ? this.ruleKbs(r).length : r.kbId));
    if (!rules.length) return false;
    /* 凭据缺失: 行级定时照常"接管"本轮 tick 但跳过执行, 避免空跑 API 制造 failed 运行记录 (与 syncAll 同口径) */
    if (!this.settings.clientId || !this.settings.apiKey) {
      console.log('[ima-push] 行级定时跳过: 未配置 Client ID / API Key');
      return true;
    }
    const due = [];
    for (const r of rules) {
      if (r.timerDone === today) continue;              /* 当天该行已跑过 */
      if (hhmm < this.normTime(r.time)) continue;       /* 时刻未到; 晚点均触发, 规避后台节流漏跑 */
      due.push(r);
    }
    if (!due.length) return true;
    if (this.running) {                                 /* 上一次任务还在跑, 本轮让位, 下一分钟再试 */
      console.log('[ima-push] 行级定时跳过: 上一次任务仍在运行');
      return true;
    }
    const batch = this.newBatchId();
    for (const r of due) r.timerDone = today;             /* 先全部落盘再执行, 防止崩溃后重复触发 */
    try { await this.saveSettings(); } catch (e) { console.error('[ima-push] 定时状态保存失败', e); }
    new Notice('知识库同步：行级定时触发（' + due.length + ' 条规则）');
    /* 修复: 与 syncAll 相同, 外层统一持锁, 逐行执行 */
    this.beginRun('定时同步');
    try {
      for (const r of due) {
        if (r.direction === 'pull') await this.pullRulesOnly([r], batch, true, true);
        else await this.pushRulesOnly([r], batch, true, true);
      }
      this.finishBatchPanel(batch);
    } finally {
      this.endRun();
    }
    return true;
  }

  /* 只跑指定 push 规则: 范围限定为这些规则勾选的目录 (R-04: 逻辑收敛到 runPush)
     deferFinish=true 时(一次触发拆成多行调用)不由单行收尾面板, 交给 finishBatchPanel 汇总
     locked=true 时运行锁由调用方(syncAll/runRuleTimers)统一持有 */
  async pushRulesOnly(rules, batch, deferFinish, locked) {
    if (!locked) {
      if (this.running) { this.busyNotice(); return; }
      if (!this.settings.clientId || !this.settings.apiKey) return;
      this.beginRun('上传');
    }
    try {
      await this.runPush(rules, batch, deferFinish, { force: false, full: false, compare: false });
    } finally {
      if (!locked) this.endRun();
    }
  }

  /* 只跑指定 pull 规则; deferFinish/locked 语义同 pushRulesOnly (R-04: 逻辑收敛到 runPull) */
  async pullRulesOnly(rules, batch, deferFinish, locked) {
    if (!locked) {
      if (this.running) { this.busyNotice(); return; }
      if (!this.settings.clientId || !this.settings.apiKey) return;
      this.beginRun('拉取');
    }
    const plan = [];
    for (const r of rules) {
      const dir = this.ruleDirs(r)[0] || '';
      this.ruleKbs(r).forEach(k => plan.push({ kbId: k.id, kbName: k.name, dir }));
    }
    try {
      await this.runPull(plan, batch, deferFinish, { full: false });
    } finally {
      if (!locked) this.endRun();
    }
  }

  /* 核心拉取循环: 目录创建 + 逐条目下载/比对/落地 (pullAll 与 pullRulesOnly 共用) */
  async processPullEntries(entries, stats, errors) {
    const pullable = entries.filter(x => PULLABLE_TYPES.has(x.mediaType));
    stats.total = pullable.length;
    if (!pullable.length) return;   /* 由调用方处理留痕与提示 */
    this.panel.start(pullable.length, '拉取中');
    const madeDirs = new Set();
    /* 逐段创建目录 (dir 可含 IMA 侧带来的子路径, 如 "_inbox/lockobsidian/lockobsidian") */
    const ensureDir = async (rel) => {
      let cur = '';
      for (const seg of String(rel).split('/')) {
        if (!seg) continue;
        cur = cur ? cur + '/' + seg : seg;
        if (!madeDirs.has(cur)) {
          if (!this.app.vault.getAbstractFileByPath(cur)) await vaultIO(this.app.vault.createFolder(cur), '创建目录 ' + cur);
          madeDirs.add(cur);
        }
      }
    };
    let done = 0;
    for (const e of pullable) {
      done++;
      try {
        this.panel.update(done - 1, pullable.length, e.title);
        const baseDir = e.dir || '';
        /* IMA 侧文件夹路径逐段做 Windows 非法字符兜底, 与文件名同规则。
           N-5: 过滤 "." / ".." 段 —— 非法字符替换消灭了分隔符, 但 IMA 侧名为 "." 或 ".." 的文件夹
           会原样拼进落地路径(Obsidian adapter 大概率拒绝)。服务端可信、风险很低, 但单条目已有
           「未命名_」兜底, 这里补一个过滤成本为零, 属纵深防御补齐 */
        const subPath = (e.folderPath || '')
          .split('/')
          .map(s => (s || '').replace(/[\\/:*?"<>|]/g, '_').trim())
          .filter(s => s && s !== '.' && s !== '..')
          .join('/');
        const dir = [baseDir, subPath].filter(Boolean).join('/');
        if (dir) await ensureDir(dir);
        /* Windows 非法文件名字符兜底; 全非法字符时给出缺省名, 避免空路径创建失败 */
        let safeName = (e.title || '').replace(/[\\/:*?"<>|]/g, '_').trim() || ('未命名_' + e.mediaId);
        /* N-4: IMA 的 title 常不带扩展名 → 按 media_type 反查补后缀。
           否则落地文件无扩展名: Obsidian 不识别为笔记、系统双击关联错程序 */
        if (!/\.[a-z0-9]+$/i.test(safeName)) {
          const ext = EXT_BY_TYPE[e.mediaType];
          if (ext) safeName += '.' + ext;
        }
        const targetPath = (dir ? dir + '/' : '') + safeName;
        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        /* 取原文: get_media_info -> 签名 URL + headers -> GET */
        const info = await this.api.getMediaInfo(e.mediaId);
        const ui = info.url_info;
        if (!ui || !ui.url) throw new Error('get_media_info 未返回下载链接');
        /* INFO-06: 下载 URL 协议白名单, 拒绝非 https 链接 */
        if (!/^https:\/\//i.test(String(ui.url))) throw new Error('下载链接不是 HTTPS，已拒绝下载');
        const hdrs = {};
        if (ui.headers) Object.keys(ui.headers).forEach(k => { if (ui.headers[k]) hdrs[k] = ui.headers[k]; });
        const resp = await withTimeout(requestUrl({ url: ui.url, method: 'GET', headers: hdrs }), '下载 ' + e.title);
        if (e.mediaType === MEDIA_TYPE_MD) {
          /* markdown: 文本处理, 与旧版增量逻辑兼容 */
          const remoteText = resp.text;
          if (!remoteText || !remoteText.trim()) throw new Error('下载内容为空');
          if (existing && existing.stat) {
            const localRaw = await vaultIO(this.app.vault.cachedRead(existing), '读取 ' + targetPath);
            if (hashStr(stripFrontmatter(localRaw)) === hashStr(stripFrontmatter(remoteText))) { stats.same++; continue; }
            stats.conflict++;
            errors.push(targetPath + ' — 本地与远端内容不同，为保护本地修改未覆盖');
            continue;
          }
          await vaultIO(this.app.vault.create(targetPath, remoteText), '写入 ' + targetPath);
        } else {
          /* 其它类型: 二进制处理 */
          const buf = resp.arrayBuffer;
          if (!buf || !buf.byteLength) throw new Error('下载内容为空');
          if (existing && existing.stat) {
            const localBuf = await vaultIO(this.app.vault.readBinary(existing), '读取 ' + targetPath);
            if (bufHash(localBuf) === bufHash(buf)) { stats.same++; continue; }
            stats.conflict++;
            errors.push(targetPath + ' — 本地与远端内容不同，为保护本地修改未覆盖');
            continue;
          }
          await vaultIO(this.app.vault.createBinary(targetPath, buf), '写入 ' + targetPath);
        }
        stats.created++;
        this.panel.update(done, pullable.length, e.title);
      } catch (err) {
        stats.failed++;
        errors.push('[' + (e.kbName || '源库') + '] ' + e.title + ' — ' + safeErrMsg(err));
        this.panel.update(done, pullable.length, e.title);
      }
    }
  }

  /* ---------- IMA -> OB 拉取 ---------- */
  /* 解析拉取源知识库列表: 多选列表优先, 空则回落旧版单选字段 */
  getPullKbs() {
    const s = this.settings;
    if (Array.isArray(s.pullKbList) && s.pullKbList.length) {
      return s.pullKbList.filter(k => k && k.id).map(k => ({ id: k.id, name: k.name || k.id }));
    }
    return s.pullKbId ? [{ id: s.pullKbId, name: s.pullKbName || '源知识库' }] : [];
  }

  /* ---------- 拉取入口 (R-04: pullAll 与 pullRulesOnly 收敛为 runPull 单一核心) ---------- */
  async pullAll(batch) {
    if (this.running) { this.busyNotice(); return; }
    if (this.settings.enablePull === false) { new Notice('知识库同步：拉取方向已被开关关闭，如需拉取请在设置里开启'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('IMA Pull：请先在设置里填 Client ID / API Key'); return; }
    /* 拉取源 = 规则表 pull 行; 无规则时回落旧配置 pullKbList + pullDir */
    let plan;   /* [{kbId, kbName, dir}] */
    const rules = this.pullRules();
    if (rules.length) {
      /* 一条 ← 规则可勾多个源库, 每个库都拉回该行唯一的本地接收目录 */
      plan = [];
      for (const r of rules) {
        const dir = this.ruleDirs(r)[0] || '';
        this.ruleKbs(r).forEach(k => plan.push({ kbId: k.id, kbName: k.name, dir }));
      }
    } else {
      const kbs = this.getPullKbs();
      if (!kbs.length) { new Notice('IMA Pull：请先在「同步规则」里添加拉取规则（知识库 → 本地目录）'); return; }
      const d = normDir(this.settings.pullDir);
      plan = kbs.map(k => ({ kbId: k.id, kbName: k.name, dir: d }));
    }
    this.beginRun('拉取');
    try {
      await this.runPull(plan, batch, false, { full: true });
    } finally {
      this.endRun();
    }
  }

  /* 拉取核心 (R-04): 逐库列表 → 逐条目下载/落地 → 汇总。
     full=true 时带独立入口语义(0 文件 Notice、"拉取完成"面板文案、控制台输出) */
  async runPull(plan, batch, deferFinish, opts) {
    const o = Object.assign({ full: false }, opts || {});
    const stats = { total: 0, created: 0, same: 0, conflict: 0, failed: 0 };
    const errors = [];
    try {
      /* 逐库拉取条目列表, 汇总后统一处理 */
      const entries = [];
      for (const kb of plan) {
        try {
          const lst = await this.api.listKnowledge(kb.kbId);
          lst.forEach(x => entries.push({ mediaId: x.mediaId, title: x.title, mediaType: x.mediaType, folderPath: x.folderPath || '', kbName: kb.kbName, dir: kb.dir }));
        } catch (err) {
          errors.push('[' + kb.kbName + '] 列表获取失败 — ' + safeErrMsg(err));
        }
      }
      await this.processPullEntries(entries, stats, errors);
      if (!stats.total) {
        if (o.full) {
          const tip = errors.length ? '（另有 ' + errors.length + ' 个库列表获取失败）' : '';
          new Notice('知识库同步：' + plan.length + ' 个源知识库里没有可拉取的文件' + tip);
        }
        await this.recordRun('pull', stats, errors, batch);   // 0 可拉文件也是一次运行, 必须留痕
        return;
      }
      const msg = (o.full ? '拉取完成' : '同步完成（拉取）') +
        '：新增 ' + stats.created + ' / 相同 ' + stats.same + ' / 冲突 ' + stats.conflict + ' / 失败 ' + stats.failed;
      if (!deferFinish) this.panel.finish(msg, errors.length > 0);
      if (o.full) {
        if (errors.length) console.warn('[ima-push] pull issues:', errors.map(redactText));
        console.log('[ima-push]', msg, stats);
      }
      await this.recordRun('pull', stats, errors, batch);
    } catch (e) {
      if (!deferFinish) this.panel.finish('拉取异常中断：' + safeErrMsg(e), true);
      if (o.full) console.error('[ima-push] pull:', e);
      errors.push('异常中断 — ' + safeErrMsg(e));
      await this.recordRun('pull', stats, errors, batch);
    }
  }

  /* 开一个新批次: 同一次触发 (点双向同步 / 一次定时 tick) 里的多个动作共用, 展示时合并成一行 */
  newBatchId() { return 'b' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }

  /* 一次触发的面板收尾: 从本批次记录里汇总全部行, 面板只收尾一次
     (逐行 finish 会把进度数字缩成最后一行, 看着像没干活 — 同 2026-09-10 定稿口径) */
  finishBatchPanel(batch) {
    const recs = (this.settings.runHistory || []).filter(x => x.batch === batch);
    if (!recs.length) return;   /* 一行都没跑成(如凭据/规则缺失), 不谎报汇总 */
    const sum = k => recs.reduce((s, x) => s + (Number(x[k]) || 0), 0);
    const failed = sum('failed');
    this.panel.finish('同步完成：共 ' + sum('total') + ' 个文件，成功 ' + (sum('success') + sum('skipped')) + '，失败 ' + failed, failed > 0);
  }

  /* ---------- 运行汇总落盘: 每次 pushAll/pullAll 结束都写一条, 进 runHistory ---------- */
  /* 覆盖 4 条路径: 正常完成 / 0 文件早返回 / 异常中断 / 凭据缺失 (后两种调用方决定是否调) */
  async recordRun(dir, stats, errors, batch) {
    const h = this.settings.runHistory || (this.settings.runHistory = []);
    h.unshift({
      at: Date.now(),
      batch: batch || this.newBatchId(),
      dir,
      total: stats.total || 0,
      success: (stats.created || 0) + (stats.renamed || 0),
      skipped: stats.skipped !== undefined ? (stats.skipped || 0) : ((stats.same || 0) + (stats.conflict || 0)),
      conflict: stats.conflict || 0,
      failed: stats.failed || 0,
      /* INFO-03/VULN-01: 落盘前统一脱敏, 防止敏感片段随 data.json 扩散 */
      errors: (errors || []).slice(0, 5).map(redactText)
    });
    if (h.length > 10) h.length = 10;
    /* 顺手维护 lastRun.at, 给"上次运行时间"显示用; 同时给"上方向分项"留一个聚合快照 */
    this.settings.lastRun = { at: h[0].at, push: h.find(r => r.dir === 'push'), pull: h.find(r => r.dir === 'pull') };
    /* 运行记录属留痕, 落盘失败不应反过来把整轮任务判成异常中断 */
    try { await this.saveSettings(); } catch (e) { console.error('[ima-push] 运行记录落盘失败', e); }
  }

  /* saveNow=false 时由批量调用方(processPushFiles)按检查点统一落盘;
     preHash: R-06 调用方(推送比对阶段)已按同一口径(stripFrontmatter 后正文)算好的 hash, 命中时跳过重复计算 */
  async pushFile(file, force, saveNow, preHash) {
    /* 防御性校验: 调用方(pushAll/processPushFiles/命令面板)已按规则过滤, 此处兜底防越权调用 */
    if (!this.inPushScope(file.path)) return { result: 'skipped' };
    const info = fileTypeInfo(file.name);
    if (!info) return { result: 'skipped' };   // 不认识的扩展名, 跳过
    const h = info.media_type === MEDIA_TYPE_MD
      ? (typeof preHash === 'string' && preHash
          ? preHash
          : (await (async () => {
              const raw = await vaultIO(this.app.vault.cachedRead(file), '读取 ' + file.name);
              const body = stripFrontmatter(raw);
              if (!body.trim()) return null;   // 空笔记 -> 跳过
              return hashStr(body);
            })()))
      : await hashBinaryFile(this.app, file);
    if (h === null) return { result: 'skipped' };
    if (info.media_type !== MEDIA_TYPE_MD) {
      const limit = SIZE_LIMITS[info.media_type];
      if (limit && file.stat.size > limit)
        throw new Error('超出 IMA 大小上限 ' + Math.round(limit / MB) + 'MB');
    }
    const st = this.settings.fileStates[file.path];
    const { kbId } = this.resolvePushKb(file.path);
    if (!kbId) return { result: 'skipped' };   // 该文件未匹配到任何目标库(无映射且无默认库)

    if (!force && st && st.pushHash === h && st.kbId === kbId) return { result: 'skipped' };

    /* 1. 同名检查 + 候选名: A.ext, A(1).ext ... A(20).ext, 批量查一次, 取第一个空闲 */
    const candidates = buildNameCandidates(file.name, 20);
    const rep = await this.api.checkRepeatedNames(kbId, null, candidates);
    let chosen = null;
    for (const name of candidates) {
      if (rep[name] === false) { chosen = name; break; }
    }
    if (!chosen) throw new Error('同名候选名全部被占用（' + candidates[0] + ' ~ ' + candidates[candidates.length - 1] + '）');

    /* 2. 上传链: create_media -> COS -> add_knowledge
          大文件(>100MB)不做 readBinary, 直接把绝对路径交给流式上传, 避免整文件进内存
          md 上传 stripFrontmatter 后的正文, 与上面 pushHash 的计算口径保持一致 */
    const absPath = vaultAbsPath(this.app, file.path);
    const useStream = !!absPath && info.media_type !== MEDIA_TYPE_MD && file.stat.size > STREAM_THRESHOLD;
    let data = null;
    if (!useStream) {
      if (info.media_type === MEDIA_TYPE_MD) {
        /* 与 pushHash 口径一致: 剥掉 frontmatter 再编码, slice() 保证 buffer 精确等于内容长度 */
        const body = stripFrontmatter(await vaultIO(this.app.vault.cachedRead(file), '读取 ' + file.name));
        data = new TextEncoder().encode(body).slice().buffer;
        /* N-3: md 此前被排除在大小上限检查之外(SIZE_LIMITS[7]=10MB 形同虚设),
           超限只能走到服务端才报错 —— 错误信息可读性差且浪费一次上传链路。
           这里按实际上传正文(已剥 frontmatter)的字节数本地判定, 直接给出可读错误 */
        const mdLimit = SIZE_LIMITS[MEDIA_TYPE_MD];
        if (mdLimit && data.byteLength > mdLimit)
          throw new Error('超出 IMA 大小上限 ' + Math.round(mdLimit / MB) + 'MB（md 正文 ' + data.byteLength + ' 字节）');
      } else {
        data = await vaultIO(this.app.vault.readBinary(file), '读取 ' + file.name);
      }
    }
    const title = chosen.replace(/\.[a-z0-9]+$/i, '');
    const mediaId = await uploadToKB(this.api, kbId, null, chosen, data, title, absPath, file.stat.size);

    const prevName = st && st.uploadedName;
    this.settings.fileStates[file.path] = {
      pushHash: h, kbId: kbId,
      uploadedName: chosen, mediaId: mediaId,
      syncedAt: Date.now()
    };
    if (saveNow) await this.saveSettings();
    /* 新文件或名字带序号都归为 created; 只有内容变了但名字仍空闲时算 renamed 场景的逆: 这里统一 */
    return { result: (prevName && prevName !== chosen) ? 'renamed' : 'created', name: chosen };
  }

  async pushCurrent() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('知识库同步：当前没有打开的笔记'); return; }
    if (this.settings.enablePush === false) { new Notice('知识库同步：上传方向已被开关关闭，如需上传请在设置里开启'); return; }
    if (!this.inPushScope(file.path)) { new Notice('知识库同步：当前笔记不在任何同步规则的目录里'); return; }
    if (this.running) { this.busyNotice(); return; }
    this.beginRun('上传当前笔记');
    this.panel.start(1, '上传中');
    try {
      this.panel.update(0, 1, file.name);
      const r = await this.pushFile(file, false, true);
      this.panel.update(1, 1, file.name);
      if (r.result === 'skipped') this.panel.finish('内容没变，已跳过', false);
      else this.panel.finish('已上传为「' + r.name + '」', false);
    } catch (err) {
      this.panel.finish('上传失败：' + safeErrMsg(err), true);
      console.error('[ima-push]', err);
    } finally {
      this.endRun();
    }
  }
}

/* ---------- 选择弹窗统一样式 (东东 2026-09-11 定) ----------
   目录弹窗(单选/多选)与知识库弹窗共用同一套尺寸与样式, 宽度收窄到 25%;
   单选/多选行外观完全统一 = 勾选框行; 单选仅逻辑不同(整行点击即选中并清掉其它)。 */
const PICKER_W = '25%';
const PICKER_TITLE = 'margin:0 0 4px;';
const PICKER_DESC = 'font-size:var(--font-ui-smaller);color:var(--text-muted);margin:0 0 10px;';
const PICKER_WRAP = 'max-height:320px;overflow-y:auto;border:1px solid var(--background-modifier-border);border-radius:8px;padding:4px 10px;background:var(--background-primary);';
const PICKER_ROW = 'display:flex;align-items:center;gap:8px;padding:5px 0;cursor:pointer;font-size:0.92em;color:var(--text-normal);';
/* 单选行(接收方): 与多选行完全同风格(勾选框外观, 东东 2026-09-11 定: 统一所有选择框风格),
   区别仅在逻辑——点整行即选中并清掉其它, 选中行淡色高亮 */
const PICKER_ROW_SEL = PICKER_ROW + 'user-select:none;';
const PICKER_BOX = 'accent-color:var(--interactive-accent);margin:0;cursor:pointer;';
const PICKER_FOOT = 'display:flex;justify-content:flex-end;gap:8px;margin-top:14px;';
/* 统一弹窗宽度: 覆盖 Obsidian 默认 --modal-width / --modal-max-width */
const applyPickerWidth = (modalEl) => { modalEl.style.width = PICKER_W; modalEl.style.maxWidth = PICKER_W; modalEl.style.minWidth = '360px'; };
/* 单选接收方(← 行的目录 / → 行的知识库)统一成与多选弹窗一致的「选择…」按钮框外观,
   不再用原生 select(Windows 原生下拉不跟随主题配色), 点击弹出同风格选择窗。 */
const PICKER_TRIGGER = 'border:1px solid var(--background-modifier-border);border-radius:6px;padding:3px 7px;background:var(--background-primary);cursor:pointer;display:flex;align-items:center;gap:4px;box-sizing:border-box;overflow:hidden;';

/* ---------- 目录选择弹窗(单选/多选) ----------
   用 Obsidian 原生 Modal 承载选择: 由 Obsidian 自己插入到最上层, 不再受设置面板
   遮挡 / position:fixed 定位漂移影响。勾选即时生效(写 dirMappings 行)。 */
/* N-8: 弹窗 onDone(保存勾选结果)的失败不得静默吞掉 ——
   用户勾了却没落盘(saveSettings 磁盘错误)会毫无感知, 此处统一记日志 + Notice 提示 */
function doneGuard(p) {
  return Promise.resolve(p).catch(e => {
    console.error('[ima-sync] 保存选择失败:', e);
    new Notice('保存失败：' + safeErrMsg(e));
  });
}

class DirPickerModal extends Modal {
  /* single=true 用于 ← 拉取行: 目录此时是接收方, 只能选一个 */
  constructor(app, tree, selected, onDone, single) {
    super(app);
    this.tree = tree || [];
    this.cur = new Set(selected || []);
    /* 拍平所有目录路径, 用于判定「已选但不在当前树」的缺失项 */
    const flat = new Set();
    const flatWalk = (nodes) => (nodes || []).forEach(n => { flat.add(n.path); flatWalk(n.children); });
    flatWalk(this.tree);
    this.flat = flat;
    this.expanded = new Set(); /* 默认全折叠, 点箭头展开 */
    this.onDone = onDone || (() => {});
    this.single = !!single;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    applyPickerWidth(this.modalEl);
    contentEl.createEl('h3', { text: this.single ? '选择 Obsidian 目录（单选）' : '选择 Obsidian 目录（可多选）' })
      .style.cssText = PICKER_TITLE;
    contentEl.createEl('div', { text: this.single
      ? '← 拉取方向：知识库 → 本地目录，接收方只能一个目录，点一下即选中。'
      : '→ 上传方向：目录 → 知识库，可勾选多个目录；点 ▶ 展开子目录，勾选父目录即同步其下全部内容。' })
      .style.cssText = PICKER_DESC;

    const wrap = contentEl.createEl('div');
    wrap.style.cssText = PICKER_WRAP;
    const extra = contentEl.createEl('div');
    extra.style.cssText = 'margin-top:12px;font-size:0.85em;color:var(--text-muted);';

    const render = () => {
      wrap.empty(); extra.empty();
      if (!this.tree.length) {
        wrap.createEl('div', { text: 'vault 根目录下没有子文件夹' })
          .style.cssText = 'font-size:0.9em;color:var(--text-faint);padding:6px 0;';
      }
      const self = this;
      const drawNode = (node, depth) => {
        const hasKids = !!(node.children && node.children.length);
        const sel = self.cur.has(node.path);
        const isOpen = self.expanded.has(node.path);
        const rowEl = wrap.createEl('div');
        rowEl.style.cssText = (self.single ? PICKER_ROW_SEL : PICKER_ROW)
          + 'padding-left:' + (depth * 16 + 4) + 'px;'
          + (sel && self.single ? 'background:var(--interactive-accent-hover,rgba(120,120,240,.15));border-radius:6px;' : '');
        /* 展开箭头(仅含子目录的节点才有); 叶子节点用占位点对齐 */
        if (hasKids) {
          const arrow = rowEl.createEl('span', { text: isOpen ? '▼' : '▶' });
          arrow.style.cssText = 'cursor:pointer;width:16px;flex:0 0 16px;display:inline-block;color:var(--text-muted);font-size:0.8em;text-align:center;';
          arrow.onclick = (ev) => { ev.stopPropagation(); if (isOpen) self.expanded.delete(node.path); else self.expanded.add(node.path); render(); };
        } else {
          const dot = rowEl.createEl('span', { text: '·' });
          dot.style.cssText = 'width:16px;flex:0 0 16px;display:inline-block;color:var(--text-faint);font-size:0.9em;text-align:center;';
        }
        /* 单选=整行点选(无方框); 多选=勾选框(东东 2026-09-11 定) */
        if (self.single) {
          const nameEl = rowEl.createEl('span', { text: node.name });
          if (sel) rowEl.createEl('span', { text: '✓' }).style.cssText = 'margin-left:auto;color:var(--interactive-accent);font-weight:600;';
          rowEl.onclick = () => {
            self.cur.clear();
            if (!sel) self.cur.add(node.path);
            doneGuard(self.onDone([...self.cur]));
            render();
          };
        } else {
          const cb = rowEl.createEl('input');
          cb.type = 'checkbox';
          cb.checked = sel;
          cb.style.cssText = PICKER_BOX;
          rowEl.createEl('span', { text: node.name });
          cb.onchange = () => {
            if (cb.checked) self.cur.add(node.path); else self.cur.delete(node.path);
            doneGuard(self.onDone([...self.cur]));
            render();
          };
        }
      };
      const walkRender = (nodes, depth) => {
        (nodes || []).forEach(n => {
          drawNode(n, depth);
          if (n.children && n.children.length && self.expanded.has(n.path)) walkRender(n.children, depth + 1);
        });
      };
      walkRender(self.tree, 0);
      /* 已选但不在当前目录树中的(目录被改名/删除), 单独列出以便移除 */
      const missing = [...self.cur].filter(d => !self.flat.has(d));
      if (missing.length) {
        extra.createEl('div', { text: '已选但不在当前目录树中：' });
        missing.forEach(d => {
          const b = extra.createEl('button', { text: d + ' ✕' });
          b.style.cssText = 'margin:4px 4px 0 0;font-size:0.9em;';
          b.onclick = () => { self.cur.delete(d); doneGuard(self.onDone([...self.cur])); render(); };
        });
      }
    };
    render();

    const row = contentEl.createEl('div');
    row.style.cssText = PICKER_FOOT;
    if (this.single) {
      row.createEl('button', { text: '清空' }).onclick = () => {
        this.cur.clear(); doneGuard(this.onDone([])); render();
      };
    }
    row.createEl('button', { text: '完成', cls: 'mod-cta' }).onclick = () => this.close();
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------- 知识库选择弹窗(单选/多选) ----------
   ← 拉取行的知识库是发起方, 可多选; → 上传行的知识库是接收方, single=true 单选。
   两个方向共用本弹窗, 与目录弹窗同风格(东东 2026-09-11 定: 单选不用原生 select)。 */
class KbPickerModal extends Modal {
  constructor(app, kbs, selected, onDone, single) {
    super(app);
    this.kbs = kbs || [];
    this.cur = new Map((selected || []).filter(k => k && k.id).map(k => [k.id, k.name || k.id]));
    this.onDone = onDone || (() => {});
    this.single = !!single;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    applyPickerWidth(this.modalEl);
    contentEl.createEl('h3', { text: this.single ? '选择 IMA 知识库（单选）' : '选择 IMA 知识库（可多选）' }).style.cssText = PICKER_TITLE;
    contentEl.createEl('div', { text: this.single
      ? '→ 上传方向：本地目录 → 知识库，接收方只能一个库，点一下即选中。'
      : '← 拉取方向：知识库 → 本地目录，可勾选多个源库，全部拉回本行选定的那一个目录。' })
      .style.cssText = PICKER_DESC;

    const wrap = contentEl.createEl('div');
    wrap.style.cssText = PICKER_WRAP;
    const extra = contentEl.createEl('div');
    extra.style.cssText = 'margin-top:12px;font-size:0.85em;color:var(--text-muted);';

    const render = () => {
      wrap.empty(); extra.empty();
      if (!this.kbs.length) {
        wrap.createEl('div', { text: '知识库列表为空：请先关掉本窗，点上方「刷新知识库列表」' })
          .style.cssText = 'font-size:0.9em;color:var(--text-faint);padding:6px 0;';
      }
      this.kbs.forEach(k => {
        const sel = this.cur.has(k.id);
        /* 多选=勾选框行; 单选=无方框, 整行可点, 选中行淡色高亮+行尾✓ (与目录弹窗同风格) */
        if (this.single) {
          const rowEl = wrap.createEl('div');
          rowEl.style.cssText = PICKER_ROW_SEL
            + (sel ? 'background:var(--interactive-accent-hover,rgba(120,120,240,.15));border-radius:6px;' : '');
          rowEl.createEl('span', { text: k.name });
          if (sel) rowEl.createEl('span', { text: '✓' }).style.cssText = 'margin-left:auto;color:var(--interactive-accent);font-weight:600;';
          rowEl.onclick = () => {
            this.cur.clear();
            if (!sel) this.cur.set(k.id, k.name);
            doneGuard(this.onDone(this.pick()));
            render();
          };
          return;
        }
        const lab = wrap.createEl('label');
        lab.style.cssText = PICKER_ROW;
        const cb = lab.createEl('input');
        cb.type = 'checkbox';
        cb.checked = sel;
        cb.style.cssText = PICKER_BOX;
        lab.createEl('span', { text: k.name });
        cb.onchange = () => {
          if (cb.checked) this.cur.set(k.id, k.name); else this.cur.delete(k.id);
          doneGuard(this.onDone(this.pick()));
          render();
        };
      });
      /* 已选但不在当前列表中的(知识库被删/列表未加载), 单独列出以便移除 */
      const missing = [...this.cur.keys()].filter(id => !this.kbs.some(k => k.id === id));
      if (missing.length) {
        extra.createEl('div', { text: '已选但不在当前列表中：' });
        missing.forEach(id => {
          const b = extra.createEl('button', { text: this.cur.get(id) + ' ✕' });
          b.style.cssText = 'margin:4px 4px 0 0;font-size:0.9em;';
          b.onclick = () => { this.cur.delete(id); doneGuard(this.onDone(this.pick())); render(); };
        });
      }
    };
    render();

    const row = contentEl.createEl('div');
    row.style.cssText = PICKER_FOOT;
    if (this.single) {
      row.createEl('button', { text: '清空' }).onclick = () => {
        this.cur.clear(); doneGuard(this.onDone([])); render();
      };
    }
    row.createEl('button', { text: '完成', cls: 'mod-cta' }).onclick = () => this.close();
  }

  /* 按 kbList 原顺序返回 [{id,name}], 列表外的追加在后面 */
  pick() {
    const out = [];
    this.kbs.forEach(k => { if (this.cur.has(k.id)) out.push({ id: k.id, name: k.name }); });
    [...this.cur.keys()].forEach(id => { if (!out.some(o => o.id === id)) out.push({ id, name: this.cur.get(id) }); });
    return out;
  }

  onClose() { this.contentEl.empty(); }
}

/* ---------- settings tab ---------- */

class ImaPushSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this.kbList = null; this._kbTried = false; }

  async display() {
    const { containerEl } = this;
    /* N-7: 先渲染 UI, 再后台拉知识库列表 —— 旧版在此 await, 弱网时设置页白屏最长 30s。
       现改为: 立刻渲染完整界面, 后台拉完再重渲染一次补上下拉选项;
       只自动预载一次(_kbTried), 失败不再重试(点「测试连接/刷新」仍可手动触发) */
    if (!this.kbList && !this._kbTried && this.plugin.settings.clientId && this.plugin.settings.apiKey) {
      this._kbTried = true;
      this.plugin.api.listAddableKBs()
        .then(list => { this.kbList = list || []; this.display(); })
        .catch(() => { /* 静默: 凭据无效时列表为空, 点「测试连接」会给出明确报错 */ });
    }
    containerEl.empty();
    containerEl.createEl('h2', { text: 'IMA 知识库同步设置（Obsidian ↔ IMA 双向）' });
    /* 版本号/署名不放插件列表(会被截断), 改在设置页顶部以弱化小字展示 */
    const _ver = (this.plugin.manifest && this.plugin.manifest.version) || '';
    if (_ver) containerEl.createEl('div', { text: 'v' + _ver + '　作者:杨宇轩' })
      .style.cssText = 'color:var(--text-muted);font-size:0.8em;margin:-10px 0 12px;';

    new Setting(containerEl).setName('Client ID').addText(t => t
      .setPlaceholder('ima OpenAPI Client ID')
      .setValue(this.plugin.settings.clientId)
      .onChange(async v => { this.plugin.settings.clientId = v.trim(); await this.plugin.saveSettings(); }));

    /* VULN-02: 设置页显著警告密钥明文落盘风险 */
    new Setting(containerEl).setName('API Key')
      .setDesc('明文保存在插件 data.json。请勿把 vault 推送到公开仓库或未加密云盘（.obsidian 目录会被一并上传）；建议在 .gitignore 中忽略 .obsidian/plugins/tencent-ima-sync/data.json')
      .addText(t => {
        t.inputEl.type = 'password';
        t.setPlaceholder('ima OpenAPI API Key')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async v => { this.plugin.settings.apiKey = v.trim(); await this.plugin.saveSettings(); });
      });

    new Setting(containerEl).setName('测试连接').setDesc('验证凭据并顺带拉取知识库列表').addButton(b => b
      .setButtonText('测试')
      .onClick(async () => {
        b.setDisabled(true);
        try {
          this.kbList = await this.plugin.api.testConnection();
          new Notice('连接成功，已连接到知识库');
          this.display();
        } catch (e) {
          new Notice('连接失败：' + safeErrMsg(e));
        }
        b.setDisabled(false);
      }));

    new Setting(containerEl).setName('刷新知识库列表').setDesc('一键拉取当前 Key 有写入权限的全部 IMA 知识库，供上方「测试连接」及下方两个知识库下拉框共用；首次配置或新建知识库后点一次即可').addButton(b => b
      .setButtonText('刷新')
      .onClick(async () => {
        b.setDisabled(true);
        try {
          this.kbList = await this.plugin.api.listAddableKBs();
          new Notice('知识库列表已刷新');
          this.display();
        } catch (e) {
          new Notice('拉取失败：' + safeErrMsg(e));
        }
        b.setDisabled(false);
      }));

    /* 传输规则和策略: 原「传输规则」「传输策略」两项合并(东东 2026-09-11 定)。
       执行顺序固定「按同步规则表的排列顺序依次执行」, 故不再提供全局先推/先拉的选项。
       说明文字按东东要求多行排版: 标题占一行, 内容逐行换行, 同步策略/同步命令用行内加粗标签 */
    {
      const s = new Setting(containerEl).setName('传输规则和策略').setDesc('');
      const _d = s.descEl;
      const _line = (label, text) => {
        const div = _d.createEl('div');
        div.style.cssText = 'margin:2px 0;line-height:1.55;';
        if (label) {
          const b = div.createEl('span', { text: label + '：' });
          b.style.cssText = 'font-weight:600;';
        }
        div.createEl('span', { text });
      };
      _line('双向同步', '本地没有 → 新增；同名同内容 → 跳过；同名不同内容 → 跳过不覆盖；自动编号 name(1)、name(2)。');
      _line('同步策略', '按目录顺序的排列顺序自上而下依次执行。');
      _line('同步命令', '命令面板搜 Push、Pull、Sync，左侧竖栏「杨」图标 / 右下角「杨 ⇅」按钮。');
    }

    /* ================= 同步规则 (v0.7.0): 上传/拉取合并为一张规则表 =================
       每行: [Obsidian 目录(多选)] [方向箭头 →/←] [IMA 知识库(限宽)] [定时 HH:MM 可空] [✕] */
    containerEl.createEl('h3', { text: '同步内容' });

    /* vault 根下全部一级文件夹, 供目录多选 */
    /* 递归构建 vault 目录树(含子目录), 供目录选择弹窗树形展开(东东 2026-09-11 要求) */
    const getDirTree = () => {
      const build = (folder, prefix) => (folder.children || [])
        .filter(f => f.children)
        .map(f => {
          const p = prefix ? prefix + '/' + f.name : f.name;
          return { name: f.name, path: p, children: build(f, p) };
        });
      return build(this.app.vault.getRoot(), '').sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    };

    /* 目录控件: 已选目录以标签展示, 点一下展开全部一级目录选择
       single=true (← 拉取行: 目录是接收方) 时只能选一个。
       VULN-04: 读写统一走 ruleDirs/setRuleDirs(数组), 不再手工逗号拆合 */
    const makeDirPicker = (row, r, single) => {
      const box = row.createEl('div');
      box.style.cssText = 'flex:0 0 200px;min-width:0;max-width:200px;height:30px;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none;box-sizing:border-box;border:1px solid var(--background-modifier-border);border-radius:6px;padding:3px 6px;background:var(--background-primary);cursor:pointer;display:flex;flex-wrap:nowrap;gap:3px;align-items:center;white-space:nowrap;';
      box.setAttribute('title', single ? '点击选择 Obsidian 目录（单选：拉取的落地目录）' : '点击选择 Obsidian 目录（可多选）');
      const redraw = () => {
        box.empty();
        const dirs = this.plugin.ruleDirs(r);
        if (!dirs.length) {
          box.createEl('span', { text: '选择目录…' }).style.cssText = 'color:var(--text-faint);font-size:0.85em;';
        } else {
          /* 多目录: 只显示第一个标签 +N(N=其余数量), 与知识库多选框同风格(东东 2026-09-11 定) */
          const shown = dirs.slice(0, 1);
          const hidden = dirs.length - shown.length;
          shown.forEach(d => {
            const tag = box.createEl('span');
            tag.style.cssText = 'flex:0 0 auto;display:inline-flex;align-items:center;gap:4px;background:var(--background-modifier-hover);border-radius:10px;padding:1px 8px;font-size:0.78em;color:var(--text-normal);max-width:184px;';
            const label = d.length > 18 ? d.slice(0, 17) + '…' : d;
            tag.setAttribute('title', dirs.join('\n'));
            tag.appendChild(document.createTextNode(label));
            const x = tag.createEl('span', { text: '×' });
            x.style.cssText = 'cursor:pointer;font-weight:700;color:var(--text-muted);';
            x.onclick = async (ev) => {
              ev.stopPropagation();
              this.plugin.setRuleDirs(r, this.plugin.ruleDirs(r).filter(v => v !== d));
              await this.plugin.saveSettings(); redraw();
            };
          });
          if (hidden > 0) {
            /* 角标直接显示目录总数(3 个目录显示 3, 不是 +2); 配色与知识库框 +N 一致(主题强调色), 不再用灰色(东东 2026-09-11 定) */
            const more = box.createEl('span', { text: String(dirs.length) });
            more.style.cssText = 'flex:0 0 auto;display:inline-flex;align-items:center;border-radius:8px;padding:0 6px;font-size:0.72em;line-height:1.5;color:var(--text-on-accent);background:var(--interactive-accent);';
            more.setAttribute('title', dirs.join('\n'));
          }
        }
        box.createEl('span', { text: '▾' }).style.cssText = 'color:var(--text-muted);font-size:0.8em;margin-left:auto;flex:0 0 auto;';
      };
      redraw();
      box.onclick = (ev) => {
        ev.stopPropagation();
        /* 用 Obsidian 原生 Modal 承载选择: 由 Obsidian 插到最上层, 不再被设置面板遮挡 */
        new DirPickerModal(this.app, getDirTree(), this.plugin.ruleDirs(r), async (list) => {
          this.plugin.setRuleDirs(r, list);
          await this.plugin.saveSettings();
          redraw();
        }, single).open();
      };
    };

    const _ruleWrap = containerEl.createEl('div');
    const renderRules = () => {
      _ruleWrap.empty();
      const rules = this.plugin.settings.dirMappings || (this.plugin.settings.dirMappings = []);
      /* 表头 */
      const head = _ruleWrap.createEl('div');
      head.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;font-size:0.75em;color:var(--text-faint);margin:0 0 2px;padding:0 2px;';
      /* 表头文字全部居中, 与各自正下方的框中线对齐(东东 2026-09-11 定) */
      head.createEl('span', { text: 'Obsidian 目录' }).style.cssText = 'flex:0 0 200px;min-width:0;max-width:200px;overflow:hidden;white-space:nowrap;text-align:center;';
      head.createEl('span', { text: '方向' }).style.cssText = 'flex:0 0 30px;text-align:center;';
      head.createEl('span', { text: 'IMA 知识库' }).style.cssText = 'flex:0 0 200px;min-width:0;max-width:200px;overflow:hidden;white-space:nowrap;text-align:center;';
      head.createEl('span', { text: '定时' }).style.cssText = 'flex:0 0 64px;text-align:center;';
      head.createEl('span', { text: '' }).style.cssText = 'flex:0 0 28px;';
      rules.forEach((r, idx) => {
        const isPull = r.direction === 'pull';
        const row = _ruleWrap.createEl('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;justify-content:center;margin:6px 0;';
        /* ① 目录: → 行多选(发起方); ← 行单选(接收方) */
        makeDirPicker(row, r, isPull);
        /* ② 方向箭头: 点击切换 →/← */
        const dirBtn = row.createEl('button', { text: isPull ? '←' : '→' });
        dirBtn.style.cssText = 'flex:0 0 30px;min-width:30px;height:30px;font-size:17px;font-weight:700;line-height:1;padding:0;cursor:pointer;color:' + (isPull ? 'var(--color-green,#1f883d)' : 'var(--color-red,#d0342c)') + ';';
        dirBtn.setAttribute('title', isPull ? '拉取：IMA 知识库 → Obsidian 目录（点击切换为上传）' : '上传：Obsidian 目录 → IMA 知识库（点击切换为拉取）');
        dirBtn.onclick = async () => {
          r.direction = isPull ? 'push' : 'pull';
          /* 方向决定谁是发起方, 接收方只能一个: 切到 ← 收敛目录, 切回 → 收敛知识库 */
          if (r.direction === 'pull') {
            const ds = this.plugin.ruleDirs(r);
            if (ds.length > 1) {
              this.plugin.setRuleDirs(r, ds.slice(0, 1));
              new Notice('拉取方向只能有一个接收目录，已保留「' + ds[0] + '」');
            }
          } else if (isPull) {
            const ks = this.plugin.ruleKbs(r);
            if (ks.length > 1) {
              this.plugin.setRuleKbs(r, ks, true);
              new Notice('上传方向只能有一个接收知识库，已保留「' + ks[0].name + '」');
            }
          }
          await this.plugin.saveSettings(); renderRules();
        };
        /* ③ 知识库: ← 行 = 发起方(多选弹窗); → 行 = 接收方(单选, 同风格弹窗, 不再用原生 select) */
        if (isPull) {
          const kbox = row.createEl('div');
          kbox.style.cssText = 'flex:0 0 200px;min-width:0;max-width:200px;height:30px;' + PICKER_TRIGGER;
          const redrawKb = () => {
            kbox.empty();
            const kbs = this.plugin.ruleKbs(r);
            if (!kbs.length) {
              kbox.createEl('span', { text: '选择知识库…' }).style.cssText = 'color:var(--text-faint);font-size:0.85em;';
            } else {
              const n = kbs[0].name;
              kbox.createEl('span', { text: n.length > 16 ? n.slice(0, 15) + '…' : n })
                .style.cssText = 'font-size:0.85em;color:var(--text-normal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
              if (kbs.length > 1) {
                kbox.createEl('span', { text: '+' + (kbs.length - 1) })
                  .style.cssText = 'flex:0 0 auto;font-size:0.72em;line-height:1.5;color:var(--text-on-accent);background:var(--interactive-accent);border-radius:8px;padding:0 5px;';
              }
            }
            kbox.createEl('span', { text: '▾' }).style.cssText = 'color:var(--text-muted);font-size:0.8em;margin-left:auto;';
            kbox.setAttribute('title', kbs.length ? kbs.map(k => k.name).join('\n') : '点击选择源知识库（可多选）');
          };
          redrawKb();
          kbox.onclick = (ev) => {
            ev.stopPropagation();
            new KbPickerModal(this.app, this.kbList || [], this.plugin.ruleKbs(r), async (list) => {
              this.plugin.setRuleKbs(r, list, false);
              await this.plugin.saveSettings();
              redrawKb();
            }).open();
          };
        } else {
          const kb2 = row.createEl('div');
          kb2.style.cssText = 'flex:0 0 200px;min-width:0;max-width:200px;height:30px;' + PICKER_TRIGGER;
          const redrawKb2 = () => {
            kb2.empty();
            if (!r.kbId) {
              kb2.createEl('span', { text: '选择知识库…' }).style.cssText = 'color:var(--text-faint);font-size:0.85em;';
            } else {
              const n = r.kbName || r.kbId;
              kb2.createEl('span', { text: n.length > 16 ? n.slice(0, 15) + '…' : n })
                .style.cssText = 'font-size:0.85em;color:var(--text-normal);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            }
            kb2.createEl('span', { text: '▾' }).style.cssText = 'color:var(--text-muted);font-size:0.8em;margin-left:auto;';
            kb2.setAttribute('title', r.kbName || '点击选择知识库（接收方只能一个）');
          };
          redrawKb2();
          kb2.onclick = (ev) => {
            ev.stopPropagation();
            const cur = r.kbId ? [{ id: r.kbId, name: r.kbName || r.kbId }] : [];
            new KbPickerModal(this.app, this.kbList || [], cur, async (list) => {
              this.plugin.setRuleKbs(r, list, true);
              await this.plugin.saveSettings();
              redrawKb2();
            }, true).open();
          };
        }
        /* ④ 行级定时: 宽度只够 HH:MM */
        const tm = row.createEl('input');
        tm.type = 'text'; tm.placeholder = 'HH:MM'; tm.value = r.time || '';
        tm.style.cssText = 'flex:0 0 64px;width:64px;min-width:64px;height:30px;padding:0 4px;text-align:center;font-variant-numeric:tabular-nums;box-sizing:border-box;';
        tm.setAttribute('title', '留空 = 仅手动触发；填 09:00 这类时刻 = 每天到点自动跑本行');
        tm.onchange = async () => {
          const v = tm.value.trim();
          if (v && !this.plugin.normTime(v)) { new Notice('时间格式应为 HH:MM（24 小时制），如 09:00 / 21:30'); tm.value = r.time || ''; return; }
          r.time = v ? this.plugin.normTime(v) : '';
          r.timerDone = '';
          await this.plugin.saveSettings();
        };
        /* ⑤ 删行 */
        const del = row.createEl('button', { text: '✕' });
        del.style.cssText = 'flex:0 0 28px;height:30px;padding:0;';
        del.onclick = async () => { rules.splice(idx, 1); await this.plugin.saveSettings(); renderRules(); };
      });
      const add = _ruleWrap.createEl('button', { text: '+ 添加规则' });
      add.style.cssText = 'margin-top:6px;';
      add.onclick = async () => { rules.push({ dirs: [], dir: '', kbId: '', kbName: '', kbIds: [], kbNames: [], direction: 'push', time: '', timerDone: '' }); await this.plugin.saveSettings(); renderRules(); };
    };
    renderRules();

    /* 「默认远程知识库（兜底）」设置项已移除（东东 2026-09-11）。
       业务隐患②（2026-09-26 定案）：targetKbId 兜底行为一并移除 —— 文件未命中任何上传规则即不上传，
       不再静默回落。该字段仅作遗留数据保留（迁移旧白名单时读取一次），运行时不再影响推送目标。 */

    containerEl.createEl('h3', { text: '行为说明' });
    const info = containerEl.createEl('div');
    info.innerHTML =
      '<ul style="font-size:0.85em; line-height:1.6;">' +
      '<li><b>双向同步</b>：左侧竖栏「杨」图标 / 右下角「杨 ⇅」按钮，点一下按同步规则表的排列顺序自上而下逐行执行（每行按自己的箭头方向跑）；命令面板搜 Push / Pull / Sync 可单方向执行</li>' +
      '<li><b>进度</b>：运行时按钮旁显示进度条 + 百分比（如 3/12 25% · 文件名）；结束显示 ✓ 汇总（失败 ✗），6 秒后收起</li>' +
      '<li><b>同步规则</b>：→ 行的勾选目录内全部<b>支持类型</b>文件上传到指定知识库（md / markdown / pdf / word / ppt / excel / csv / 图片 / txt / xmind / 音频 / html / epub，md 去掉 frontmatter，其它原样直传；各类型有官方大小上限，超限自动跳过并报告）；← 行把指定知识库拉回到勾选的第一个目录</li>' +
      '<li><b>行级定时</b>：规则填了时刻 = 每天到点自动跑该行，当天只跑一次；到点时若上一次任务仍在运行则跳过；已错过的时刻不补跑</li>' +
      '<li>内容没变 → 跳过；同名文件自动编号（保留扩展名）：<b>A.pdf</b> 被占用 → 传 <b>A(1).pdf</b> → 再占用 → <b>A(2).pdf</b></li>' +
      '<li><b>自动补传</b>：每次推送前批量核验远端同名文件是否还在，你在 IMA 端删过的文件会自动重新上传</li>' +
      '<li>拉取支持全部文件类型：md 文本比对增量，其它类型二进制哈希比对；同名不同内容 → 冲突跳过，绝不覆盖本地修改</li>' +
      '<li>IMA OpenAPI 对知识库文件无更新/删除接口，旧版本会留在库里，需要清理时在 IMA 客户端手动删</li>' +
      '<li>所有请求 30 秒超时，不会卡死；每次同步结束有明确汇总</li>' +
      '</ul>';

    new Setting(containerEl).setName('清空同步记录').setDesc('忘记所有已同步状态，下次同步全部当作新文件（配合同名编号不会覆盖远端）').addButton(b => b
      .setButtonText('清空')
      .setWarning()
      .onClick(async () => {
        this.plugin.settings.fileStates = {};
        await this.plugin.saveSettings();
        new Notice('已清空同步记录');
      }));

    const hist = this.plugin.settings.runHistory || [];
    if (hist.length) {
      /* 只展示最近一次「触发」: 同批次的记录 (点双向同步 / 一次定时 tick 里的推+拉) 合并成一行
         东东 2026-09-10 定稿: 无序号、无次数括号、无累计行; 方向词统一写「同步」 */
      const batchKey = r => r.batch || ('at' + r.at);
      const key = batchKey(hist[0]);
      const grp = hist.filter(r => batchKey(r) === key);
      const at = Math.max.apply(null, grp.map(r => r.at));
      const agg = { total: 0, success: 0, skipped: 0, conflict: 0, failed: 0 };
      const errs = [];
      grp.forEach(r => {
        agg.total += r.total || 0;
        agg.success += r.success || 0;
        agg.skipped += r.skipped || 0;
        agg.conflict += r.conflict || 0;
        agg.failed += r.failed || 0;
        (r.errors || []).forEach(x => errs.push(x));
      });
      const box = containerEl.createEl('div');
      box.style.cssText = 'margin:10px 0;padding:8px 12px;border:1px solid var(--background-modifier-border);border-radius:6px;font-size:0.9em;line-height:1.8;';
      box.createEl('div', { text: '上次运行时间：' + new Date(at).toLocaleString() }).style.fontWeight = '700';
      box.createEl('div', { text: '运行汇总' }).style.cssText = 'font-weight:600;margin-top:6px;';
      box.createEl('div', {
        text: new Date(at).toLocaleString() +
          '　同步' +
          '：共 ' + agg.total + ' 个文件，成功 ' + (agg.success + agg.skipped) +
          '（新增 ' + agg.success + ' / 跳过 ' + agg.skipped + (agg.conflict ? '，含冲突 ' + agg.conflict : '') + '），失败 ' + agg.failed
      });
      if (errs.length)
        box.createEl('div', { text: '└ ' + errs.slice(0, 5).join('；') }).style.cssText = 'color:var(--text-error);font-size:0.85em;';
    } else if (this.plugin.settings.lastRun && this.plugin.settings.lastRun.at) {
      /* 兼容 v0.6.1 早期写下的 lastRun 单对象结构 */
      const lr = this.plugin.settings.lastRun;
      containerEl.createEl('p', { text: '上次运行时间：' + new Date(lr.at).toLocaleString() });
    } else if (this.plugin.settings.lastPushAt) {
      containerEl.createEl('p', { text: '上次运行时间：' + new Date(this.plugin.settings.lastPushAt).toLocaleString() });
    }
  }
}

module.exports = ImaPushPlugin;
