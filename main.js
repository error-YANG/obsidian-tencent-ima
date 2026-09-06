'use strict';
/*
 * IMA 知识库同步 v0.3.1 — Obsidian <-> IMA 知识库双向同步插件 (官方 OpenAPI /openapi/wiki/v1)
 *
 * 配置形式:
 *  - OB 端目录: 白名单, 一行一个文件夹名
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

const DEFAULT_SETTINGS = {
  clientId: '',
  apiKey: '',
  whitelist: '',           // OB 端目录白名单, 一行一个文件夹名
  targetKbId: '',          // 远程目录: IMA 知识库 id
  targetKbName: '',
  pullKbId: '',            // 拉取方向: 源知识库 id (IMA -> OB)
  pullKbName: '',
  pullDir: '',             // 拉取落地目录: vault 内文件夹, 留空 = 根目录
  syncStrategy: 'push_pull', // 双向同步顺序: push_pull=先上传再拉取(默认) | pull_push=先拉取再上传
  fileStates: {},          // path -> {pushHash, kbId, uploadedName, mediaId, syncedAt}
  lastPushAt: 0
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
  return text.replace(/^---\n[\s\S]*?\n---\n?/, '');
}

function parseWhitelist(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map(s => s.trim().replace(/^\/+|\/+$/g, ''))
    .filter(s => s.length > 0);
}

function withTimeout(promise, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' 超时(' + TIMEOUT_MS + 'ms)')), TIMEOUT_MS))
  ]);
}

/* 生成同名候选名: a.md -> [a.md, a(1).md, a(2).md ... a(N).md] */
function buildNameCandidates(fileName, max) {
  const m = fileName.match(/^(.*)\.md$/i);
  const base = m ? m[1] : fileName;
  const list = [fileName];
  for (let i = 1; i <= max; i++) list.push(base + '(' + i + ').md');
  return list;
}

/* ---------- COS 上传 (官方签名算法, 参照 ima 官方 skill 包 cos-upload.cjs) ---------- */

async function cosUpload(cred, data) {
  const host = cred.bucket_name + '.cos.' + cred.region + '.myqcloud.com';
  const pathname = '/' + cred.cos_key;
  const now = Math.floor(Date.now() / 1000);
  const keyTime = now + ';' + (now + 600);

  const headers = { 'content-length': String(data.byteLength), 'host': host };
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

  const resp = await withTimeout(requestUrl({
    url: 'https://' + host + pathname,
    method: 'PUT',
    headers: {
      'Content-Type': 'text/markdown',
      'Authorization': auth,
      'x-cos-security-token': cred.token
    },
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
        'ima-openapi-ctx': 'skill_version=ima-push/0.3.0'
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
  /* 检查同名, 返回 {name: is_repeated} 映射 */
  async checkRepeatedNames(kbId, folderId, names) {
    const d = await this.post('/openapi/wiki/v1/check_repeated_names', {
      knowledge_base_id: kbId,
      folder_id: folderId || undefined,
      params: names.map(n => ({ name: n, media_type: MEDIA_TYPE_MD }))
    });
    const map = {};
    (d.results || []).forEach(r => { map[r.name] = !!r.is_repeated; });
    return map;
  }
  createMedia(kbId, fileName, size) {
    return this.post('/openapi/wiki/v1/create_media', {
      knowledge_base_id: kbId,
      file_name: fileName,
      file_size: size,
      content_type: 'text/markdown',
      file_ext: 'md'
    });
  }
  addKnowledge(kbId, folderId, mediaId, title, fileName, size) {
    return this.post('/openapi/wiki/v1/add_knowledge', {
      knowledge_base_id: kbId,
      folder_id: folderId || undefined,
      media_type: MEDIA_TYPE_MD,
      media_id: mediaId,
      title: title,
      file_info: {
        cos_key: undefined, // 由调用方通过 file_info 传入
        file_name: fileName,
        file_size: size,
        last_modify_time: Math.floor(Date.now() / 1000)
      }
    });
  }
}

/* add_knowledge 需要 cos_key, 但它在 create_media 返回的凭证里, 单独封装完整上传链 */
async function uploadToKB(api, kbId, folderId, fileName, data, title) {
  const d = await api.createMedia(kbId, fileName, data.byteLength);
  const mediaId = d.media_id;
  const cred = d.cos_credential || d;
  if (!mediaId || !cred.cos_key) throw new Error('create_media 返回缺字段: ' + JSON.stringify(d).slice(0, 150));
  await cosUpload(cred, data);
  const r = await api.post('/openapi/wiki/v1/add_knowledge', {
    knowledge_base_id: kbId,
    folder_id: folderId || undefined,
    media_type: MEDIA_TYPE_MD,
    media_id: mediaId,
    title: title,
    file_info: {
      cos_key: cred.cos_key,
      file_name: fileName,
      file_size: data.byteLength,
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

    this.btn = this.root.createEl('button', { text: '杨宇轩 ⇅' });
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
    this.btn.setText('杨宇轩 ⇅');
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
  }

  onunload() {
    if (this.panel) this.panel.destroy();
  }

  async saveSettings() { await this.saveData(this.settings); this.api = new ImaApi(this.settings.clientId, this.settings.apiKey); }

  getWhitelist() { return parseWhitelist(this.settings.whitelist); }

  inWhitelist(path) {
    const list = this.getWhitelist();
    if (!list.length) return false;
    return list.some(dir => path === dir + '.md' || path.startsWith(dir + '/'));
  }

  async pushAll(force) {
    if (this.running) { new Notice('知识库同步：上一次推送还没结束，请等汇总提示'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('知识库同步：请先在设置里填 Client ID / API Key'); return; }
    if (!this.settings.targetKbId) { new Notice('知识库同步：请先在设置里选择远程知识库'); return; }
    const wl = this.getWhitelist();
    if (!wl.length) { new Notice('知识库同步：白名单为空，请先在设置里填写 OB 端目录'); return; }

    this.running = true;
    const stats = { total: 0, created: 0, renamed: 0, skipped: 0, failed: 0 };
    const errors = [];

    try {
      const files = this.app.vault.getMarkdownFiles().filter(f => this.inWhitelist(f.path));
      stats.total = files.length;
      if (files.length === 0) {
        new Notice('知识库同步：白名单目录下没有找到任何 .md 文件');
        return;
      }
      let done = 0;
      this.panel.start(files.length);

      /* 服务端存在性校验: 本地账本认为"没变"的文件, 批量确认远端同名文件还在;
         不在(说明被 IMA 端删除)则本次自动强制重传, 无需手动清空上传记录 */
      const forceSet = new Set();
      if (!force) {
        try {
          const unchanged = [];
          for (const f of files) {
            const raw = await this.app.vault.cachedRead(f);
            const body = stripFrontmatter(raw);
            if (!body.trim()) continue;
            const st = this.settings.fileStates[f.path];
            if (st && st.pushHash === hashStr(body) && st.kbId === this.settings.targetKbId)
              unchanged.push({ path: f.path, name: st.uploadedName });
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
      await this.saveSettings();

      const msg = '完成：新增 ' + stats.created + ' / 换名 ' + stats.renamed + ' / 跳过 ' + stats.skipped + ' / 失败 ' + stats.failed;
      this.panel.finish(msg, errors.length > 0);
      if (errors.length) console.warn('[ima-push] failures:', errors);
      console.log('[ima-push]', msg, stats);
    } catch (e) {
      this.panel.finish('推送异常中断：' + (e && e.message ? e.message : e), true);
      console.error('[ima-push]', e);
    } finally {
      this.running = false;
    }
  }

  /* ---------- 双向同步: 按传输策略顺序执行 ---------- */
  async syncAll() {
    const pushFirst = (this.settings.syncStrategy || 'push_pull') === 'push_pull';
    if (pushFirst) { await this.pushAll(false); await this.pullAll(); }
    else { await this.pullAll(); await this.pushAll(false); }
  }

  /* ---------- IMA -> OB 拉取 ---------- */
  async pullAll() {
    if (this.running) { new Notice('IMA Pull：上一次任务还没结束，请等汇总提示'); return; }
    if (!this.settings.clientId || !this.settings.apiKey) { new Notice('IMA Pull：请先在设置里填 Client ID / API Key'); return; }
    if (!this.settings.pullKbId) { new Notice('IMA Pull：请先在设置里选择源知识库'); return; }
    const dir = (this.settings.pullDir || '').trim().replace(/^\/+|\/+$/g, '');
    this.running = true;
    const stats = { total: 0, created: 0, same: 0, conflict: 0, failed: 0 };
    const errors = [];
    try {
      const entries = (await this.api.listKnowledge(this.settings.pullKbId)).filter(x => x.mediaType === 7);
      stats.total = entries.length;
      if (!entries.length) { new Notice('IMA Pull：源知识库根目录下没有 .md 笔记'); return; }
      this.panel.start(entries.length, '拉取中');
      if (dir && !this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
      let done = 0;
      for (const e of entries) {
        done++;
        try {
          this.panel.update(done - 1, entries.length, e.title);
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
          stats.created++;
          this.panel.update(done, entries.length, e.title);
        } catch (err) {
          stats.failed++;
          errors.push(e.title + ' — ' + (err && err.message ? err.message : err));
          this.panel.update(done, entries.length, e.title);
        }
      }
      const msg = '拉取完成：新增 ' + stats.created + ' / 相同 ' + stats.same + ' / 冲突 ' + stats.conflict + ' / 失败 ' + stats.failed;
      this.panel.finish(msg, errors.length > 0);
      if (errors.length) console.warn('[ima-push] pull issues:', errors);
      console.log('[ima-push]', msg, stats);
    } catch (e) {
      this.panel.finish('拉取异常中断：' + (e && e.message ? e.message : e), true);
      console.error('[ima-push] pull:', e);
    } finally {
      this.running = false;
    }
  }

  async pushFile(file, force) {
    if (!this.inWhitelist(file.path)) return { result: 'skipped' };
    const raw = await this.app.vault.cachedRead(file);
    const body = stripFrontmatter(raw);
    if (!body.trim()) return { result: 'skipped' };
    const h = hashStr(body);
    const st = this.settings.fileStates[file.path];
    const kbId = this.settings.targetKbId;

    if (!force && st && st.pushHash === h && st.kbId === kbId) return { result: 'skipped' };

    /* 1. 同名检查 + 候选名: A.md, A(1).md ... A(20).md, 批量查一次, 取第一个空闲 */
    const candidates = buildNameCandidates(file.name, 20);
    const rep = await this.api.checkRepeatedNames(kbId, null, candidates);
    let chosen = null;
    for (const name of candidates) {
      if (rep[name] === false) { chosen = name; break; }
    }
    if (!chosen) throw new Error('同名候选名全部被占用（' + candidates[0] + ' ~ ' + candidates[candidates.length - 1] + '）');

    /* 2. 上传链: create_media -> COS -> add_knowledge */
    const data = await this.app.vault.readBinary(file);
    const title = chosen.replace(/\.md$/i, '');
    const mediaId = await uploadToKB(this.api, kbId, null, chosen, data, title);

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
    if (!this.inWhitelist(file.path)) { new Notice('知识库同步：当前笔记不在白名单目录里'); return; }
    if (this.running) { new Notice('知识库同步：上一次推送还没结束'); return; }
    this.running = true;
    this.panel.start(1);
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

    new Setting(containerEl).setName('刷新知识库列表').setDesc('一键拉取当前 Key 有写入权限的全部 IMA 知识库，供上方「测试连接」及下方上传/拉取的下拉框共用；首次配置或新建知识库后点一次即可').addButton(b => b
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

    /* --- OB 端目录: 白名单 --- */
    containerEl.createEl('h3', { text: 'OB 端目录（白名单，一行一个）' });
    new Setting(containerEl).setName('目录白名单').setDesc('vault 根目录下的文件夹名，一行一个，如：【31-ZABBIX】。这些目录下的 .md 会被上传').addTextArea(t => {
      t.inputEl.style.width = '100%';
      t.inputEl.style.height = '120px';
      t.inputEl.style.fontFamily = 'monospace';
      t.setPlaceholder('【31-ZABBIX】\n【51-自动化运维】');
      t.setValue(this.plugin.settings.whitelist || '');
      t.onChange(async v => { this.plugin.settings.whitelist = v; await this.plugin.saveSettings(); });
    });

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

    containerEl.createEl('h3', { text: '远程目录IMA（拉取）' });
    new Setting(containerEl).setName('源知识库').setDesc('从这里拉取 .md 笔记到本地').addDropdown(d => {
      d.addOption('', '请先点「刷新」…');
      const kbList = this.kbList || [];
      kbList.forEach(kb => d.addOption(kb.id, kb.name + (typeof kb.count === 'number' ? '（' + kb.count + ' 条内容）' : '')));
      if (this.plugin.settings.pullKbId && !kbList.some(k => k.id === this.plugin.settings.pullKbId)) {
        d.addOption(this.plugin.settings.pullKbId, (this.plugin.settings.pullKbName || '当前知识库') + '（列表未加载）');
      }
      d.setValue(this.plugin.settings.pullKbId || '');
      d.onChange(async v => {
        this.plugin.settings.pullKbId = v;
        const kb = kbList.find(k => k.id === v);
        this.plugin.settings.pullKbName = kb ? kb.name : (this.plugin.settings.pullKbName || '');
        await this.plugin.saveSettings();
      });
    });
    new Setting(containerEl).setName('本地落地目录').setDesc('拉取的笔记放到这个 vault 文件夹（不存在会自动创建；留空 = vault 根目录）').addText(t => {
      t.setPlaceholder('如：【40-学习】');
      t.setValue(this.plugin.settings.pullDir || '');
      t.onChange(async v => { this.plugin.settings.pullDir = v; await this.plugin.saveSettings(); });
    });
    new Setting(containerEl).setName('传输策略').setDesc('双向同步（Sync）的执行顺序，默认先上传再拉取').addDropdown(d => {
      d.addOption('push_pull', '先上传再拉取');
      d.addOption('pull_push', '先拉取再上传');
      d.setValue(this.plugin.settings.syncStrategy || 'push_pull');
      d.onChange(async v => { this.plugin.settings.syncStrategy = v; await this.plugin.saveSettings(); });
    });

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
      '<li><b>手动上传</b>：底部状态栏最右侧常驻「↑ IMA」按钮，点一下即推；左侧竖栏也有上传图标，命令面板搜「Push」可调</li>' +
      '<li><b>进度</b>：上传时按钮旁显示进度条 + 百分比（如 3/12 25% · 文件名）；结束显示 ✓ 汇总（失败 ✗），6 秒后收起</li>' +
      '<li>只上传白名单目录下的 <b>.md</b>（忽略附件），正文去掉 frontmatter 后传入库根目录</li>' +
      '<li>内容没变 → 跳过；同名文件自动编号：<b>A.md</b> 被占用 → 传 <b>A(1).md</b> → 再占用 → <b>A(2).md</b></li>' +
      '<li>IMA OpenAPI 对知识库文件无更新/删除接口，旧版本会留在库里，需要清理时在 IMA 客户端手动删</li>' +
      '<li>所有请求 30 秒超时，不会卡死；每次推送结束有明确汇总</li>' +
      '<li>在 IMA 端删了文件插件不知道；想重新上传某篇 → 点下方「清空上传记录」后重推</li>' +
      '</ul>';

    new Setting(containerEl).setName('清空上传记录').setDesc('忘记所有已同步状态，下次推送全部当作新文件（配合同名编号不会覆盖远端）').addButton(b => b
      .setButtonText('清空')
      .setWarning()
      .onClick(async () => {
        this.plugin.settings.fileStates = {};
        await this.plugin.saveSettings();
        new Notice('已清空上传记录');
      }));

    if (this.plugin.settings.lastPushAt) {
      containerEl.createEl('p', { text: '上次推送：' + new Date(this.plugin.settings.lastPushAt).toLocaleString() });
    }
  }
}

module.exports = ImaPushPlugin;
