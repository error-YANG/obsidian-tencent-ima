'use strict';
/*
 * IMA 知识库同步 v0.6.1 — Obsidian <-> IMA 知识库双向同步插件 (官方 OpenAPI /openapi/wiki/v1)
 *
 * 配置形式:
 *  - Obsidian 目录: 白名单, 一行一个文件夹名
 *  - 远程目录: 下拉菜单选择 IMA 知识库 (get_addable_knowledge_base_list)
 *
 * 行为:
 *  - 只处理白名单目录下的 .md, 正文去掉 frontmatter 再上传
 *  - 内容没变 -> skip (本地账本 hash, 且每次推送前批量核验远端同名文件仍在; 远端被删则自动重传)
 *  - 内容变了/新文件 -> 上传链路: check_repeated_names -> create_media -> COS PUT -> add_knowledge
 *  - 同名处理: 自动编号, A.md 被占用则传 A(1).md, 再占用 A(2).md ... (check_repeated_names 批量查询)
 *  - 知识库文件无更新/删除接口 (官方能力边界), 旧版本保留, 新版本带序号
 *  - 所有网络调用 30s 超时, 不存在永久卡锁
 *  - 手动触发: 右下角常驻 [↑ 推送到 IMA] 按钮 / 左侧竖栏图标 / 命令面板
 *  - 进度: 右下角面板实时显示进度条 + 百分比 + 当前文件名, 结束明确汇总
 */

const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require('obsidian');
const crypto = require('crypto');

const BASE = 'https://ima.qq.com';
const TIMEOUT_MS = 30000;
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
  return crypto.createHash('md5').update(Buffer.from(data)).digest('hex');
}

const DEFAULT_SETTINGS = {
  clientId: '',
  apiKey: '',
  whitelist: '',           // Obsidian 目录白名单, 一行一个文件夹名
  targetKbId: '',          // 远程目录: IMA 知识库 id
  targetKbName: '',
  pullKbId: '',            // 拉取方向: 源知识库 id (IMA -> OB), 兼容旧版单选
  pullKbName: '',
  pullKbList: [],          // 拉取方向: 源知识库多选列表 [{id,name}], 空时回落到 pullKbId
  enablePush: true,        // 方向开关: 上传 (关掉后 ⇅ 只拉取)
  enablePull: true,        // 方向开关: 拉取 (关掉后 ⇅ 只上传)
  pullDir: '',             // 拉取落地目录: vault 内文件夹, 留空 = 根目录
  syncStrategy: 'push_pull', // 双向同步顺序: push_pull=先上传再拉取(默认) | pull_push=先拉取再上传
  fileStates: {},          // path -> {pushHash, kbId, uploadedName, mediaId, syncedAt}
  lastPushAt: 0,
  lastRun: null,           // 兼容旧版: 单一对象, 不再写入, 读路径仍保留避免兼容性问题
  runHistory: [],          // 运行历史: 最近 10 次, 每条 {at, dir, total, success, skipped, conflict, failed, errors}

  /* ---------- 定时同步 (v0.6.0): 推送/拉取 各一套独立定时, 每天固定时刻 HH:MM ---------- */
  /* lastDate = 上次触发日期 YYYY-MM-DD, 用于"同一天只跑一次" */
  timerPush: { enabled: false, time: '09:00', lastDate: '' },
  timerPull: { enabled: false, time: '21:00', lastDate: '' },
};

/* ---------- utils ---------- */

function hashStr(l) {
  let t = 2166136261;
  for (let e = 0; e < l.length; e++) {
    t ^= l.charCodeAt(e);
    t = (t + ((t << 1) + (t << 4) + (t << 7) + (t << 8) + (t << 24))) >>> 0;
  }
  return t.toString(16).padStart(8, '0');
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

/* vault 内相对路径 -> 磁盘绝对路径 (仅桌面端 FileSystemAdapter 可用; 移动端返回 null 自动退回内存模式) */
function vaultAbsPath(app, relPath) {
  try {
    const ad = app.vault.adapter;
    if (ad && typeof ad.getFullPath === 'function') return ad.getFullPath(relPath);
    if (ad && typeof ad.getBasePath === 'function') return require('path').join(ad.getBasePath(), relPath);
  } catch (e) { /* 移动端无 node 环境, 忽略 */ }
  return null;
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时(' + TIMEOUT_MS + 'ms)')), TIMEOUT_MS))
  ]);
}

/* 自定义超时版: 大文件需要远超 30s 的窗口, 不能沿用固定 TIMEOUT_MS */
function withTimeoutMs(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时(' + ms + 'ms)')), ms))
  ]);
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
    const https = require('https');
    const fs = require('fs');
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
      let body = '';
      res.on('data', c => { if (body.length < 2000) body += c.toString('utf8'); });
      res.on('end', () => {
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
    const fail = e => { if (!settled) { settled = true; try { req.destroy(); } catch (_) {} reject(e); } };
    req.setTimeout(timeoutMs, () => fail(new Error('COS 流式上传超时(' + timeoutMs + 'ms)')));
    req.on('error', fail);
    const rs = fs.createReadStream(absPath);
    rs.on('error', fail);
    rs.pipe(req);
  });
}

/* COS 分片上传: 解决大文件(>100MB)单 PUT 被 STS policy 限制的问题.
   流程: InitMultipartUpload -> UploadPart(每片, 流式) -> CompleteMultipartUpload.
   每步单独签名(签名含 query 参数 + headers) */
async function cosUploadMultipart(cred, absPath, size, contentType, partSize, timeoutMs, diag) {
  const https = require('https');
  const fs = require('fs');
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
  const streamToBuffer = (rs, len) => new Promise((resolve, reject) => {
    const chunks = []; let got = 0;
    rs.on('data', c => { chunks.push(c); got += c.length; });
    rs.on('end', () => resolve(Buffer.concat(chunks, got)));
    rs.on('error', reject);
  });

  const doReq = async (method, queryParams, headers, bodyOrStream, bodyLen) => {
    const built = buildAuth(method, queryParams, headers);
    const allHeaders = Object.assign({}, headers, {
      'Authorization': built.auth,
      'x-cos-security-token': cred.token
    });
    let bodyBuf = null;
    if (bodyOrStream) {
      if (typeof bodyOrStream.pipe === 'function') {
        bodyBuf = await streamToBuffer(bodyOrStream, bodyLen);
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
    'Authorization': auth,
    'x-cos-security-token': cred.token
  };

  /* 大文件走 Node 读流: requestUrl 传 >100MB 级 body 会失败(内存/IPC), 这是 39/41 里那 2 个大 PDF 失败的根因 */
  if (absPath && size > STREAM_THRESHOLD) {
    /* 大文件优先走 COS 分片上传: 把 body 切成 25MB 一片, 每片单独 PUT,
       彻底绕开 STS policy 的 content-length-range 单请求上限(实测约 100MB).
       失败再退回流式/老路径兜底(理论上不再需要, 但保留以便对照诊断) */
    let realLen;
    try { realLen = require('fs').statSync(absPath).size; } catch (e) { realLen = 'stat失败:' + e.message; }
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
      /* 分片失败 -> 退回旧的流式 + requestUrl 双通道,
         目的: 万一分片不被 STS policy 允许, 仍能拿到对照数据(以及万一成功) */
      let streamErr = null;
      try {
        await cosUploadStream(host, pathname, putHeaders, absPath, size, streamTimeoutMs(size), diag);
        return;
      } catch (eStr) { streamErr = eStr; }

      let fbData = data;
      if (!fbData) {
        try {
          const buf = require('fs').readFileSync(absPath);
          fbData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        } catch (e2) {
          throw new Error('[multipart]' + (eMul.message || eMul)
            + ' || [stream]' + (streamErr.message || streamErr)
            + ' || 回退读文件失败: ' + (e2.message || e2));
        }
      }
      try {
        await withTimeoutMs(requestUrl({ url: url, method: 'PUT', headers: putHeaders, body: fbData }),
          streamTimeoutMs(size), 'COS 上传(回退)');
        return;
      } catch (e3) {
        throw new Error('[multipart]' + (eMul.message || eMul)
          + ' || [stream]' + (streamErr.message || streamErr)
          + ' || [requestUrl-fallback]' + (e3.message || e3));
      }
    }
  }
  if (!data) throw new Error('cosUpload: 小文件路径缺少 data');

  const resp = await withTimeout(requestUrl({
    url: url,
    method: 'PUT',
    headers: putHeaders,
    body: data
  }), 'COS 上传');
  if (resp.status >= 300) throw new Error('COS 上传失败 HTTP ' + resp.status);
}

/* ---------- IMA OpenAPI client ---------- */

class ImaApi {
  constructor(clientId, apiKey) {
    this.clientId = clientId;
    this.apiKey = apiKey;
  }
  async post(path, body) {
    const resp = await withTimeout(requestUrl({
      url: BASE + path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ima-openapi-clientid': this.clientId,
        'ima-openapi-apikey': this.apiKey,
        'ima-openapi-ctx': 'skill_version=tencent-ima-sync/0.6.0'
      },
      body: JSON.stringify(body || {})
    }), path);
    let j;
    try { j = JSON.parse(resp.text); }
    catch (e) { throw new Error(path + ' 返回非 JSON: ' + String(resp.text).slice(0, 120)); }
    if (typeof j.code === 'number' && j.code !== 0) throw new Error('code=' + j.code + ' ' + (j.msg || ''));
    return j.data || {};
  }
  testConnection() { return this.listAddableKBs(); }
  /* 拉取方向: 列出知识库全部条目 (游标分页, 最多 40 页 = 2000 条) */
  async listKnowledge(kbId) {
    const list = [];
    let cursor = '';
    for (let i = 0; i < 40; i++) {
      const d = await this.post('/openapi/wiki/v1/get_knowledge_list', { knowledge_base_id: kbId, cursor: cursor, limit: 50 });
      const infos = d.knowledge_list || [];
      infos.forEach(x => list.push({ mediaId: x.media_id, title: x.title, mediaType: x.media_type }));
      if (d.is_end || !d.next_cursor || infos.length === 0) break;
      cursor = d.next_cursor;
    }
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
  if (!mediaId || !cred.cos_key) throw new Error('create_media 返回缺字段: ' + JSON.stringify(d).slice(0, 150));
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
  constructor(container, onSync) {
    this.hideTimer = null;

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
    this.btn.setAttribute('aria-label', '杨宇轩：知识库同步（点击按传输策略先上传再拉取）');
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
       在控制台(Ctrl+Shift+I)看到这行即证明跑的是新代码; 每次改动递增 BUILD 号 */
    console.log('[ima-sync] loaded BUILD=2026-09-09.13 (分片query key全小写 partnumber/uploadid)');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.running = false;
    this.api = new ImaApi(this.settings.clientId, this.settings.apiKey);

    /* 状态栏(右下角)面板: [杨宇轩 ↑↓] 单按钮 + 进度条, 点击双向同步 */
    const statusItem = this.addStatusBarItem();
    statusItem.style.marginLeft = 'auto';   /* 推到状态栏右侧 */
    statusItem.style.display = 'flex';
    statusItem.style.alignItems = 'center';
    this.panel = new StatusPanel(statusItem, () => this.syncAll());

    /* 唯一竖栏图标: 同样触发双向同步, 与右下角按钮等价; 图标内容替换为「杨」字 */
    const _rib = this.addRibbonIcon('database', '杨宇轩：知识库同步', () => this.syncAll());
    _rib.empty();
    _rib.style.cssText += 'display:flex;align-items:center;justify-content:center;';
    const _ribTxt = _rib.createEl('span', { text: '杨' });
    _ribTxt.style.cssText = 'font-size:16px;font-weight:700;line-height:1;color:var(--text-normal);';

    this.addCommand({
      id: 'push-all',
      name: 'Push now（上传白名单目录到知识库）',
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
      name: 'Sync（双向同步：按传输策略执行）',
      callback: () => this.syncAll()
    });
    this.addSettingTab(new ImaPushSettingTab(this.app, this));

    /* 定时同步 (v0.6.0): 每分钟检查一次是否到达设定时刻 */
    this.setupTimers();
  }

  onunload() {
    if (this.panel) this.panel.destroy();
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

  async saveSettings() { await this.saveData(this.settings); this.api = new ImaApi(this.settings.clientId, this.settings.apiKey); }

  getWhitelist() { return parseWhitelist(this.settings.whitelist); }

  inWhitelist(path) {
    const list = this.getWhitelist();
    if (!list.length) return false;
    return list.some(dir => path === dir + '.md' || path.startsWith(dir + '/'));
  }

  async pushAll(force, batch) {
    if (this.running) { new Notice('知识库同步：上一次推送还没结束，请等汇总提示'); return; }
    if (this.settings.enablePush === false) { new Notice('知识库同步：上传方向已被开关关闭，如需上传请在设置里开启'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('知识库同步：请先在设置里填 Client ID / API Key'); return; }
    if (!this.settings.targetKbId) { new Notice('知识库同步：请先在设置里选择远程知识库'); return; }
    const wl = this.getWhitelist();
    if (!wl.length) { new Notice('知识库同步：白名单为空，请先在设置里填写 Obsidian 目录'); return; }

    this.running = true;
    const stats = { total: 0, created: 0, renamed: 0, skipped: 0, failed: 0 };
    const errors = [];

    try {
      const files = this.app.vault.getFiles().filter(f => this.inWhitelist(f.path));
      stats.total = files.length;
      if (files.length === 0) {
        new Notice('知识库同步：白名单目录下没有找到任何可上传的文件');
        await this.recordRun('push', stats, [], batch);   // 0 文件也是一次运行, 必须留痕
        return;
      }
      /* 比对阶段: 本地 hash 比对 + 服务端存在性校验, 先于上传; 状态栏显式标「比对中」 */
      const forceSet = new Set();
      if (!force) {
        this.panel.start(files.length, '比对中');
        let cmpDone = 0;
        try {
          const unchanged = [];
          for (const f of files) {
            cmpDone++;
            this.panel.update(cmpDone - 1, files.length, f.name);
            const info = fileTypeInfo(f.name);
            if (!info) { this.panel.update(cmpDone, files.length, f.name); continue; }
            let h;
            if (info.media_type === MEDIA_TYPE_MD) {
              const raw = await this.app.vault.cachedRead(f);
              const body = stripFrontmatter(raw);
              if (!body.trim()) { this.panel.update(cmpDone, files.length, f.name); continue; }
              h = hashStr(body);
            } else {
              h = hashStr(f.stat.size + '|' + f.stat.mtime);
            }
            const st = this.settings.fileStates[f.path];
            if (st && st.pushHash === h && st.kbId === this.settings.targetKbId)
              unchanged.push({ path: f.path, name: st.uploadedName });
            this.panel.update(cmpDone, files.length, f.name);
          }
          const names = [...new Set(unchanged.map(u => u.name))];
          const gone = new Set();
          for (let i = 0; i < names.length; i += 50) {
            const chunk = names.slice(i, i + 50);
            const rep = await this.api.checkRepeatedNames(this.settings.targetKbId, null, chunk);
            chunk.forEach(n => { if (rep[n] === false) gone.add(n); });
          }
          unchanged.forEach(u => { if (gone.has(u.name)) forceSet.add(u.path); });
          if (forceSet.size) console.log('[ima-push] 服务端已删除, 将自动重传:', [...forceSet]);
        } catch (e) {
          console.warn('[ima-push] 服务端存在性校验失败, 退回纯本地增量模式:', e);
        }
      }
      /* 比对结束(或强制重传跳过比对), 进入上传阶段 */
      this.panel.start(files.length, '上传中');
      let done = 0;

      for (const file of files) {
        done++;
        try {
          this.panel.update(done - 1, files.length, file.name);
          const r = await this.pushFile(file, force || forceSet.has(file.path));
          this.panel.update(done, files.length, file.name);
          if (r.result === 'skipped') stats.skipped++;
          else if (r.result === 'created') stats.created++;
          else if (r.result === 'renamed') stats.renamed++;
          else stats.failed++;
        } catch (err) {
          stats.failed++;
          errors.push(file.path + ' — ' + (err && err.message ? err.message : err));
        }
      }

      this.settings.lastPushAt = Date.now();
      /* 失败清单落盘: 只在控制台打印的话事后无从追查, 这里持久化最近 20 条 */
      this.settings.lastPushResult = {
        at: Date.now(),
        total: stats.total,
        created: stats.created,
        renamed: stats.renamed,
        skipped: stats.skipped,
        failed: stats.failed,
        errors: errors.slice(0, 20)
      };
      await this.saveSettings();
      await this.recordRun('push', stats, errors, batch);

      const msg = '完成：新增 ' + stats.created + ' / 换名 ' + stats.renamed + ' / 跳过 ' + stats.skipped + ' / 失败 ' + stats.failed;
      this.panel.finish(msg, errors.length > 0);
      if (errors.length) console.warn('[ima-push] failures:', errors);
      console.log('[ima-push]', msg, stats);
    } catch (e) {
      this.panel.finish('推送异常中断：' + (e && e.message ? e.message : e), true);
      console.error('[ima-push]', e);
      errors.push('异常中断 — ' + (e && e.message ? e.message : e));
      await this.recordRun('push', stats, errors, batch);
    } finally {
      this.running = false;
    }
  }

  /* ---------- 双向同步: 按传输策略顺序执行, 方向开关可关掉某一侧 ---------- */
  async syncAll() {
    const doPush = this.settings.enablePush !== false;
    const doPull = this.settings.enablePull !== false;
    if (!doPush && !doPull) { new Notice('知识库同步：上传和拉取开关都已关闭，请到设置里至少开启一个方向'); return; }
    const pushFirst = (this.settings.syncStrategy || 'push_pull') === 'push_pull';
    const steps = [];
    if (pushFirst) { if (doPush) steps.push('push'); if (doPull) steps.push('pull'); }
    else { if (doPull) steps.push('pull'); if (doPush) steps.push('push'); }
    const batch = this.newBatchId();   /* 一次触发共用批次号: 推+拉在汇总里合并成一行 */
    for (let i = 0; i < steps.length; i++) {
      if (i > 0 && this.running) return;   /* 防御: 上一步异常残留运行锁则不再继续 */
      if (steps[i] === 'push') await this.pushAll(false, batch);
      else await this.pullAll(batch);
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

  async pullAll(batch) {
    if (this.running) { new Notice('IMA Pull：上一次任务还没结束，请等汇总提示'); return; }
    if (this.settings.enablePull === false) { new Notice('知识库同步：拉取方向已被开关关闭，如需拉取请在设置里开启'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('IMA Pull：请先在设置里填 Client ID / API Key'); return; }
    const kbs = this.getPullKbs();
    if (!kbs.length) { new Notice('IMA Pull：请先在设置里添加拉取源知识库'); return; }
    const dir = (this.settings.pullDir || '').trim().replace(/^\/+|\/+$/g, '');
    this.running = true;
    const stats = { total: 0, created: 0, same: 0, conflict: 0, failed: 0 };
    const errors = [];
    try {
      /* 逐库拉取条目列表, 汇总后统一处理 */
      const entries = [];
      for (const kb of kbs) {
        try {
          const lst = await this.api.listKnowledge(kb.id);
          lst.forEach(x => entries.push({ mediaId: x.mediaId, title: x.title, mediaType: x.mediaType, kbName: kb.name }));
        } catch (err) {
          errors.push('[' + kb.name + '] 列表获取失败 — ' + (err && err.message ? err.message : err));
        }
      }
      const pullable = entries.filter(x => PULLABLE_TYPES.has(x.mediaType));
      stats.total = pullable.length;
      if (!pullable.length) {
        const tip = errors.length ? '（另有 ' + errors.length + ' 个库列表获取失败）' : '';
        new Notice('知识库同步：' + kbs.length + ' 个源知识库里没有可拉取的文件' + tip);
        await this.recordRun('pull', stats, errors, batch);   // 0 可拉文件也是一次运行, 必须留痕
        return;
      }
      this.panel.start(pullable.length, '拉取中');
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      let done = 0;
      for (const e of pullable) {
        done++;
        try {
          this.panel.update(done - 1, pullable.length, e.title);
          /* Windows 非法文件名字符兜底 */
          const safeName = e.title.replace(/[\\/:*?"<>|]/g, '_');
          const path = (dir ? dir + '/' : '') + safeName;
          const existing = this.app.vault.getAbstractFileByPath(path);
          /* 取原文: get_media_info -> 签名 URL + headers -> GET */
          const info = await this.api.getMediaInfo(e.mediaId);
          const ui = info.url_info;
          if (!ui || !ui.url) throw new Error('get_media_info 未返回下载链接');
          const hdrs = {};
          if (ui.headers) Object.keys(ui.headers).forEach(k => { if (ui.headers[k]) hdrs[k] = ui.headers[k]; });
          const resp = await withTimeout(requestUrl({ url: ui.url, method: 'GET', headers: hdrs }), '下载 ' + e.title);
          if (e.mediaType === MEDIA_TYPE_MD) {
            /* markdown: 文本处理, 与旧版增量逻辑兼容 */
            const remoteText = resp.text;
            if (!remoteText || !remoteText.trim()) throw new Error('下载内容为空');
            if (existing && existing.stat) {
              const localRaw = await this.app.vault.cachedRead(existing);
              if (hashStr(stripFrontmatter(localRaw)) === hashStr(stripFrontmatter(remoteText))) { stats.same++; continue; }
              stats.conflict++;
              errors.push(path + ' — 本地与远端内容不同，为保护本地修改未覆盖');
              continue;
            }
            await this.app.vault.create(path, remoteText);
          } else {
            /* 其它类型: 二进制处理 */
            const buf = resp.arrayBuffer;
            if (!buf || !buf.byteLength) throw new Error('下载内容为空');
            if (existing && existing.stat) {
              const localBuf = await this.app.vault.readBinary(existing);
              if (bufHash(localBuf) === bufHash(buf)) { stats.same++; continue; }
              stats.conflict++;
              errors.push(path + ' — 本地与远端内容不同，为保护本地修改未覆盖');
              continue;
            }
            await this.app.vault.createBinary(path, buf);
          }
          stats.created++;
          this.panel.update(done, pullable.length, e.title);
        } catch (err) {
          stats.failed++;
          errors.push('[' + (e.kbName || '源库') + '] ' + e.title + ' — ' + (err && err.message ? err.message : err));
          this.panel.update(done, pullable.length, e.title);
        }
      }
      const msg = '拉取完成：新增 ' + stats.created + ' / 相同 ' + stats.same + ' / 冲突 ' + stats.conflict + ' / 失败 ' + stats.failed;
      this.panel.finish(msg, errors.length > 0);
      if (errors.length) console.warn('[ima-push] pull issues:', errors);
      console.log('[ima-push]', msg, stats);
      await this.recordRun('pull', stats, errors, batch);
    } catch (e) {
      this.panel.finish('拉取异常中断：' + (e && e.message ? e.message : e), true);
      console.error('[ima-push] pull:', e);
      errors.push('异常中断 — ' + (e && e.message ? e.message : e));
      await this.recordRun('pull', stats, errors, batch);
    } finally {
      this.running = false;
    }
  }

  /* 开一个新批次: 同一次触发 (点双向同步 / 一次定时 tick) 里的多个动作共用, 展示时合并成一行 */
  newBatchId() { return 'b' + Date.now() + '-' + Math.random().toString(36).slice(2, 6); }

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
      errors: (errors || []).slice(0, 5)
    });
    if (h.length > 10) h.length = 10;
    /* 顺手维护 lastRun.at, 给"上次运行时间"显示用; 同时给"上方向分项"留一个聚合快照 */
    this.settings.lastRun = { at: h[0].at, push: h.find(r => r.dir === 'push'), pull: h.find(r => r.dir === 'pull') };
    await this.saveSettings();
  }

  async pushFile(file, force) {
    if (!this.inWhitelist(file.path)) return { result: 'skipped' };
    const info = fileTypeInfo(file.name);
    if (!info) return { result: 'skipped' };   // 不认识的扩展名, 跳过
    const h = info.media_type === MEDIA_TYPE_MD
      ? (await (async () => {
          const raw = await this.app.vault.cachedRead(file);
          const body = stripFrontmatter(raw);
          if (!body.trim()) return null;       // 空笔记 -> 跳过
          return hashStr(body);
        })())
      : hashStr(file.stat.size + '|' + file.stat.mtime);
    if (h === null) return { result: 'skipped' };
    if (info.media_type !== MEDIA_TYPE_MD) {
      const limit = SIZE_LIMITS[info.media_type];
      if (limit && file.stat.size > limit)
        throw new Error('超出 IMA 大小上限 ' + Math.round(limit / MB) + 'MB');
    }
    const st = this.settings.fileStates[file.path];
    const kbId = this.settings.targetKbId;

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
        const body = stripFrontmatter(await this.app.vault.cachedRead(file));
        data = new TextEncoder().encode(body).slice().buffer;
      } else {
        data = await this.app.vault.readBinary(file);
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
    await this.saveSettings();
    /* 新文件或名字带序号都归为 created; 只有内容变了但名字仍空闲时算 renamed 场景的逆: 这里统一 */
    return { result: (prevName && prevName !== chosen) ? 'renamed' : 'created', name: chosen };
  }

  async pushCurrent() {
    const file = this.app.workspace.getActiveFile();
    if (!file) { new Notice('知识库同步：当前没有打开的笔记'); return; }
    if (this.settings.enablePush === false) { new Notice('知识库同步：上传方向已被开关关闭，如需上传请在设置里开启'); return; }
    if (!this.inWhitelist(file.path)) { new Notice('知识库同步：当前笔记不在白名单目录里'); return; }
    if (this.running) { new Notice('知识库同步：上一次推送还没结束'); return; }
    this.running = true;
    this.panel.start(1, '上传中');
    try {
      this.panel.update(0, 1, file.name);
      const r = await this.pushFile(file, false);
      this.panel.update(1, 1, file.name);
      if (r.result === 'skipped') this.panel.finish('内容没变，已跳过', false);
      else this.panel.finish('已上传为「' + r.name + '」', false);
    } catch (err) {
      this.panel.finish('上传失败：' + (err.message || err), true);
      console.error('[ima-push]', err);
    } finally {
      this.running = false;
    }
  }
}

/* ---------- settings tab ---------- */

class ImaPushSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; this.kbList = null; }

  display() {
    const { containerEl } = this;
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

    new Setting(containerEl).setName('API Key').addText(t => {
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
          new Notice('连接成功，可写入 ' + this.kbList.length + ' 个知识库');
          this.display();
        } catch (e) {
          new Notice('连接失败：' + (e.message || e));
        }
        b.setDisabled(false);
      }));

    new Setting(containerEl).setName('刷新知识库列表').setDesc('一键拉取当前 Key 有写入权限的全部 IMA 知识库，供上方「测试连接」及下方两个知识库下拉框共用；首次配置或新建知识库后点一次即可').addButton(b => b
      .setButtonText('刷新')
      .onClick(async () => {
        b.setDisabled(true);
        try {
          this.kbList = await this.plugin.api.listAddableKBs();
          new Notice('拉取到 ' + this.kbList.length + ' 个知识库');
          this.display();
        } catch (e) {
          new Notice('拉取失败：' + (e.message || e));
        }
        b.setDisabled(false);
      }));

    new Setting(containerEl).setName('传输规则').setDesc('上传：内容变了才传；远端被删自动补传；远端同名占用自动编号 name(1)、name(2)。拉取：本地没有 → 新增；同名同内容 → 跳过；同名不同内容 → 冲突跳过（绝不覆盖本地修改）。触发：左侧竖栏图标 / 命令面板搜 Push、Pull、Sync');
    new Setting(containerEl).setName('传输策略').setDesc('双向同步（Sync）的执行顺序，默认先上传再拉取').addDropdown(d => {
      d.addOption('push_pull', '先上传再拉取');
      d.addOption('pull_push', '先拉取再上传');
      d.setValue(this.plugin.settings.syncStrategy || 'push_pull');
      d.onChange(async v => { this.plugin.settings.syncStrategy = v; await this.plugin.saveSettings(); });
    });

    /* --- 方向标识: 红字嵌在横线中间, 两侧线延伸 (分隔符样式) --- */
    const _flowWrap = containerEl.createEl('div');
    _flowWrap.style.cssText = 'display:flex;align-items:center;gap:12px;margin:18px 0 14px;';
    const _lineL = _flowWrap.createEl('div');
    _lineL.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';
    const _flow = _flowWrap.createEl('span', { text: '【Obsidian  ---->  IMA】' });
    _flow.setAttribute('title', '单向上传：把 Obsidian 笔记推送到 IMA 知识库');
    _flow.style.cssText = 'font-size:1.2em;font-weight:700;letter-spacing:1px;color:var(--text-normal);white-space:nowrap;';
    const _lineR = _flowWrap.createEl('div');
    _lineR.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';
    containerEl.createEl('h3', { text: '远程目录（IMA 知识库）' });
    new Setting(containerEl).setName('启用上传').setDesc('关掉后点击 ⇅ 只执行拉取，不会上传任何文件').addToggle(t => {
      t.setValue(this.plugin.settings.enablePush !== false);
      t.onChange(async v => { this.plugin.settings.enablePush = v; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName('远程知识库').setDesc('白名单里的笔记全部上传到这个知识库').addDropdown(d => {
      d.addOption('', '请先点「刷新」…');
      const kbList = this.kbList || [];
      kbList.forEach(kb => d.addOption(kb.id, kb.name + (typeof kb.count === 'number' ? '（' + kb.count + ' 条内容）' : '')));
      if (this.plugin.settings.targetKbId && !kbList.some(k => k.id === this.plugin.settings.targetKbId)) {
        d.addOption(this.plugin.settings.targetKbId, (this.plugin.settings.targetKbName || '当前知识库') + '（列表未加载）');
      }
      d.setValue(this.plugin.settings.targetKbId || '');
      d.onChange(async v => {
        this.plugin.settings.targetKbId = v;
        const kb = kbList.find(k => k.id === v);
        this.plugin.settings.targetKbName = kb ? kb.name : (this.plugin.settings.targetKbName || '');
        await this.plugin.saveSettings();
      });
    });

    /* --- Obsidian 目录: 白名单 --- */
    containerEl.createEl('h3', { text: 'Obsidian 目录（白名单，一行一个）' });
    new Setting(containerEl).setName('目录白名单').setDesc('vault 根目录下的文件夹名，一行一个，如：【01-笔记】。这些目录下的全部支持类型文件（md/pdf/word/ppt/excel/图片/txt/epub 等）都会被同步到 IMA').addTextArea(t => {
      t.inputEl.style.width = '100%';
      t.inputEl.style.height = '120px';
      t.inputEl.style.fontFamily = 'monospace';
      t.inputEl.parentElement.style.width = '50%';
      t.inputEl.parentElement.style.minWidth = '200px';
      t.setPlaceholder('【01-笔记】\n【02-资料】');
      t.setValue(this.plugin.settings.whitelist || '');
      t.onChange(async v => { this.plugin.settings.whitelist = v; await this.plugin.saveSettings(); });
    });
    /* --- 定时推送: 置于上传区底部, 紧跟目录白名单 --- */
    {
      const _tp = this.plugin.settings.timerPush || (this.plugin.settings.timerPush = { enabled: false, time: '09:00', lastDate: '' });
      new Setting(containerEl).setName('定时推送').setDesc('每天到点自动把白名单目录上传到 IMA 知识库').addToggle(t => {
        t.setValue(!!_tp.enabled);
        t.onChange(async v => { _tp.enabled = v; await this.plugin.saveSettings(); });
      });
      new Setting(containerEl).setName('定时推送时刻').setDesc('24 小时制 HH:MM，如 09:00 / 21:30').addText(t => {
        t.setPlaceholder('HH:MM');
        t.setValue(_tp.time || '');
        t.onChange(async v => { _tp.time = v; await this.plugin.saveSettings(); });
      });
    }

    /* --- 上传区收尾分隔线: 与其它分隔线同款带字 --- */
    const _endWrap = containerEl.createEl('div');
    _endWrap.style.cssText = 'display:flex;align-items:center;gap:12px;margin:18px 0;';
    const _endL = _endWrap.createEl('div');
    _endL.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';
    const _endFlow = _endWrap.createEl('span', { text: '【Obsidian  ---->  IMA】' });
    _endFlow.setAttribute('title', '上传区到此结束');
    _endFlow.style.cssText = 'font-size:1.2em;font-weight:700;letter-spacing:1px;color:var(--text-normal);white-space:nowrap;';
    const _endR = _endWrap.createEl('div');
    _endR.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';

    /* --- IMA -> OB 拉取方向 --- */
    const _pullWrap = containerEl.createEl('div');
    _pullWrap.style.cssText = 'display:flex;align-items:center;gap:12px;margin:18px 0 14px;';
    const _pullL = _pullWrap.createEl('div');
    _pullL.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';
    const _pullFlow = _pullWrap.createEl('span', { text: '【IMA  ---->  Obsidian】' });
    _pullFlow.setAttribute('title', '单向下拉：把 IMA 知识库的 .md 笔记拉回本地 vault');
    _pullFlow.style.cssText = 'font-size:1.2em;font-weight:700;letter-spacing:1px;color:var(--text-normal);white-space:nowrap;';
    const _pullR = _pullWrap.createEl('div');
    _pullR.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';

    containerEl.createEl('h3', { text: '远程目录（IMA 知识库）' });
    new Setting(containerEl).setName('启用拉取').setDesc('关掉后点击 ⇅ 只执行上传，不会从 IMA 拉取任何文件').addToggle(t => {
      t.setValue(this.plugin.settings.enablePull !== false);
      t.onChange(async v => { this.plugin.settings.enablePull = v; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName('源知识库（多选）').setDesc('方框打勾 = 加入拉取列表，可勾选多个；拉取时逐库扫描');
    {
      const kbList = this.kbList || [];
      const selected = new Map(this.plugin.getPullKbs().map(k => [k.id, k.name]));
      const wrap = containerEl.createEl('div');
      wrap.style.cssText = 'margin:-8px 0 12px;border:1px solid var(--background-modifier-border);border-radius:6px;padding:6px 12px;max-height:240px;overflow-y:auto;background:var(--background-secondary);';
      if (!kbList.length && !selected.size) {
        const tip = wrap.createEl('div', { text: '知识库列表未加载：请点上方「刷新知识库列表」后再勾选' });
        tip.style.cssText = 'font-size:0.85em;color:var(--text-faint);padding:4px 0;';
      }
      /* 合并: 列表已加载的全部展示; 已选但不在列表里的(旧配置残留)也展示并保持勾选 */
      const all = kbList.slice();
      selected.forEach((name, id) => { if (!all.some(k => k.id === id)) all.push({ id: id, name: name }); });
      all.forEach(kb => {
        const row = wrap.createEl('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:0.92em;color:var(--text-normal);';
        const cb = row.createEl('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(kb.id);
        cb.style.cssText = 'accent-color:var(--interactive-accent);margin:0;cursor:pointer;';
        row.createEl('span', { text: kb.name + (typeof kb.count === 'number' ? '（' + kb.count + '）' : '') })
          .style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        cb.onchange = async () => {
          const list = this.plugin.getPullKbs().slice();
          if (cb.checked) {
            if (!list.some(x => x.id === kb.id)) list.push({ id: kb.id, name: kb.name });
          } else {
            const i = list.findIndex(x => x.id === kb.id);
            if (i > -1) list.splice(i, 1);
          }
          this.plugin.settings.pullKbList = list;
          /* 兼容字段: 同步记录最新一个选中项 */
          this.plugin.settings.pullKbId = list.length ? list[list.length - 1].id : '';
          this.plugin.settings.pullKbName = list.length ? list[list.length - 1].name : '';
          await this.plugin.saveSettings();
        };
      });
    }
    new Setting(containerEl).setName('Obsidian 目录').setDesc('拉取的笔记放到这个 vault 文件夹（不存在会自动创建；留空 = vault 根目录）').addText(t => {
      t.setPlaceholder('如：【40-学习】');
      t.setValue(this.plugin.settings.pullDir || '');
      t.onChange(async v => { this.plugin.settings.pullDir = v; await this.plugin.saveSettings(); });
    });

    /* --- 定时同步区 (v0.6.0): 推送在上传区顶部, 拉取放这里, 各独立开关+时刻 --- */
    {
      const _tl = this.plugin.settings.timerPull || (this.plugin.settings.timerPull = { enabled: false, time: '21:00', lastDate: '' });
      new Setting(containerEl).setName('定时拉取').setDesc('每天到点自动从 IMA 知识库拉取到本地。每分钟检查是否到点，当天只跑一次；到点时若上一次任务仍在运行则跳过；已错过的时刻不补跑。').addToggle(t => {
        t.setValue(!!_tl.enabled);
        t.onChange(async v => { _tl.enabled = v; await this.plugin.saveSettings(); });
      });
      new Setting(containerEl).setName('定时拉取时刻').setDesc('24 小时制 HH:MM，如 09:00 / 21:30').addText(t => {
        t.setPlaceholder('HH:MM');
        t.setValue(_tl.time || '');
        t.onChange(async v => { _tl.time = v; await this.plugin.saveSettings(); });
      });
    }

    /* --- 第三根分隔线: 与上传方向分隔线同款, 线下进入行为说明 --- */
    const _hrWrap = containerEl.createEl('div');
    _hrWrap.style.cssText = 'display:flex;align-items:center;gap:12px;margin:18px 0 14px;';
    const _hrL = _hrWrap.createEl('div');
    _hrL.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';
    const _hrFlow = _hrWrap.createEl('span', { text: '【Obsidian  ---->  IMA】' });
    _hrFlow.setAttribute('title', '以上为双向功能区：上传与拉取的完整行为说明见下');
    _hrFlow.style.cssText = 'font-size:1.2em;font-weight:700;letter-spacing:1px;color:var(--text-normal);white-space:nowrap;';
    const _hrR = _hrWrap.createEl('div');
    _hrR.style.cssText = 'flex:1;border-top:1px solid var(--background-modifier-border);';
    containerEl.createEl('h3', { text: '行为说明' });
    const info = containerEl.createEl('div');
    info.innerHTML =
      '<ul style="font-size:0.85em; line-height:1.6;">' +
      '<li><b>双向同步</b>：左侧竖栏「杨」图标 / 右下角「杨 ⇅」按钮，点一下按传输策略先上传再拉取；命令面板搜 Push / Pull / Sync 可单方向执行</li>' +
      '<li><b>进度</b>：运行时按钮旁显示进度条 + 百分比（如 3/12 25% · 文件名）；结束显示 ✓ 汇总（失败 ✗），6 秒后收起</li>' +
      '<li>上传白名单目录下全部<b>支持类型</b>文件：md / markdown / pdf / word / ppt / excel / csv / 图片 / txt / xmind / 音频 / html / epub（md 去掉 frontmatter，其它原样直传；各类型有官方大小上限，超限自动跳过并报告）</li>' +
      '<li>内容没变 → 跳过；同名文件自动编号（保留扩展名）：<b>A.pdf</b> 被占用 → 传 <b>A(1).pdf</b> → 再占用 → <b>A(2).pdf</b></li>' +
      '<li><b>自动补传</b>：每次推送前批量核验远端同名文件是否还在，你在 IMA 端删过的文件会自动重新上传</li>' +
      '<li>拉取支持全部文件类型：md 文本比对增量，其它类型二进制 md5 比对；同名不同内容 → 冲突跳过，绝不覆盖本地修改</li>' +
      '<li>IMA OpenAPI 对知识库文件无更新/删除接口，旧版本会留在库里，需要清理时在 IMA 客户端手动删</li>' +
      '<li>所有请求 30 秒超时，不会卡死；每次推送结束有明确汇总</li>' +
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
