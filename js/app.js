// ============================================================
//  ⚠️ ここを自分のGoogle Cloud ConsoleのクライアントIDに変更する
// ============================================================
const CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
// ============================================================

// ===== カテゴリ定義 =====
const CATEGORIES = [
  { id: 'progress',    name: '進捗',   icon: '📈' },
  { id: 'exterior',   name: '外観',   icon: '🏢' },
  { id: 'interior',   name: '内装',   icon: '🏠' },
  { id: 'foundation', name: '基礎',   icon: '🧱' },
  { id: 'framing',    name: '躯体',   icon: '🔲' },
  { id: 'electrical', name: '電気',   icon: '⚡' },
  { id: 'plumbing',   name: '配管',   icon: '💧' },
  { id: 'finishing',  name: '仕上げ', icon: '🖌' },
  { id: 'defect',     name: '不具合', icon: '⚠️' },
  { id: 'other',      name: 'その他', icon: '⋯' },
];

// ===== 状態管理 =====
const state = {
  sites: [],
  currentSite: null,
  capturedItems: [],       // { file, blob, mimeType, previewURL, mediaType }
  selectedCategory: 'progress',
  accessToken: null,
  userName: '',
  siteFolderID: null,
  uploadedCount: 0,
};

// ===== ストレージ =====
const Storage = {
  getSites() {
    try { return JSON.parse(localStorage.getItem('sites') || 'null') || defaultSites(); }
    catch { return defaultSites(); }
  },
  saveSites(sites) { localStorage.setItem('sites', JSON.stringify(sites)); },
  getRecentPhotos(siteId) {
    try { return JSON.parse(localStorage.getItem('photos_' + siteId) || '[]'); }
    catch { return []; }
  },
  saveRecentPhotos(siteId, photos) {
    localStorage.setItem('photos_' + siteId, JSON.stringify(photos.slice(0, 12)));
  },
  getPhotographerName() { return localStorage.getItem('photographer_name') || ''; },
  savePhotographerName(name) { localStorage.setItem('photographer_name', name); },
};

function defaultSites() {
  return [
    { id: uuid(), name: '東京駅前ビル新築工事',   address: '東京都千代田区丸の内1-1',        driveFolderID: null },
    { id: uuid(), name: '横浜マンション改修工事', address: '神奈川県横浜市西区みなとみらい2-3', driveFolderID: null },
    { id: uuid(), name: '大阪オフィスビル解体工事',address: '大阪府大阪市北区梅田3-1',         driveFolderID: null },
  ];
}

// ===== Google Drive API =====
let tokenClient = null;

function initGoogleAuth() {
  if (typeof google === 'undefined') {
    setTimeout(initGoogleAuth, 300);
    return;
  }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (resp) => {
      if (resp.access_token) {
        state.accessToken = resp.access_token;
        // トークンの有効期限後にリセット
        setTimeout(() => { state.accessToken = null; updateStatusBar(); }, (resp.expires_in - 60) * 1000);
        // ユーザー情報取得
        fetchUserInfo();
        updateStatusBar();
      }
    },
  });
}

async function fetchUserInfo() {
  try {
    const res = await driveGet('https://www.googleapis.com/oauth2/v3/userinfo');
    const data = await res.json();
    state.userName = data.email || data.name || '';
    updateStatusBar();
  } catch {}
}

function driveSignIn() {
  if (!tokenClient) { alert('Google認証ライブラリを読み込み中です。少し待ってから再試行してください。'); return; }
  tokenClient.requestAccessToken({ prompt: '' });
}

function driveSignOut() {
  if (state.accessToken) {
    try { google.accounts.oauth2.revoke(state.accessToken); } catch {}
  }
  state.accessToken = null;
  state.userName = '';
  updateStatusBar();
}

async function driveGet(url) {
  return driveRequest(url, { method: 'GET' });
}

async function driveRequest(url, options = {}) {
  if (!state.accessToken) throw new Error('Googleにサインインしてください');
  const res = await fetch(url, {
    ...options,
    headers: { 'Authorization': 'Bearer ' + state.accessToken, ...(options.headers || {}) },
  });
  if (res.status === 401) {
    state.accessToken = null;
    updateStatusBar();
    throw new Error('認証が切れました。再度サインインしてください。');
  }
  if (!res.ok) throw new Error('APIエラー: ' + res.status);
  return res;
}

async function createFolder(name, parentId) {
  const meta = { name, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) meta.parents = [parentId];
  const res = await driveRequest('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(meta),
  });
  return (await res.json()).id;
}

async function findFolder(name, parentId) {
  const pq = parentId ? `'${parentId}' in parents` : `'root' in parents`;
  const q = encodeURIComponent(`name='${name}' and ${pq} and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const res = await driveGet(`https://www.googleapis.com/drive/v3/files?q=${q}`);
  const data = await res.json();
  return (data.files && data.files[0]) ? data.files[0].id : null;
}

async function ensureFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  return existing || createFolder(name, parentId);
}

async function uploadFileToDrive(file, fileName, folderID, meta) {
  const boundary = 'boundary_' + Date.now();
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const catName = (CATEGORIES.find(c => c.id === meta.category) || {}).name || meta.category;
  const actualName = `${dateStr}_${catName}_${fileName}`;

  let desc = '';
  if (meta.photographer) desc += '撮影者: ' + meta.photographer + '\n';
  desc += 'カテゴリ: ' + catName + '\n';
  desc += '撮影日時: ' + now.toLocaleString('ja-JP') + '\n';
  if (meta.memo) desc += 'メモ: ' + meta.memo + '\n';

  const fileMeta = JSON.stringify({ name: actualName, parents: [folderID], description: desc });
  const mimeType = file.type || 'application/octet-stream';

  // バイナリ安全なマルチパートボディを構築
  const enc = new TextEncoder();
  const part1 = enc.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${fileMeta}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`);
  const part2 = enc.encode(`\r\n--${boundary}--`);
  const fileBuffer = await file.arrayBuffer();
  const body = new Uint8Array(part1.length + fileBuffer.byteLength + part2.length);
  body.set(part1, 0);
  body.set(new Uint8Array(fileBuffer), part1.length);
  body.set(part2, part1.length + fileBuffer.byteLength);

  const res = await driveRequest(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: body.buffer,
    }
  );
  return (await res.json()).id;
}

function folderURL(folderId) {
  return 'https://drive.google.com/drive/folders/' + folderId;
}

// ===== ステータスバー更新 =====
function updateStatusBar() {
  const connected = !!state.accessToken;
  document.getElementById('status-icon').className = 'status-dot ' + (connected ? 'connected' : 'disconnected');
  document.getElementById('status-text').className = 'status-label ' + (connected ? 'connected' : 'disconnected');
  document.getElementById('status-text').textContent = connected ? 'Google Drive 接続中' : 'Google Drive 未接続';
  document.getElementById('status-user').textContent = state.userName;
  document.getElementById('btn-signin').classList.toggle('hidden', connected);
  document.getElementById('btn-signout').classList.toggle('hidden', !connected);
}

// ===== 現場一覧ビュー =====
function renderSiteList() {
  state.sites = Storage.getSites();
  const list = document.getElementById('sites-list');
  const empty = document.getElementById('sites-empty');
  list.innerHTML = '';

  if (state.sites.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  state.sites.forEach(site => {
    const li = document.createElement('li');
    li.className = 'site-item';
    const linked = !!site.driveFolderID;
    li.innerHTML = `
      <div class="site-item-content" onclick="openSite('${site.id}')">
        <div class="site-name">${escHtml(site.name)}</div>
        ${site.address ? `<div class="site-address">📍 ${escHtml(site.address)}</div>` : ''}
        <div class="site-drive-badge ${linked ? 'linked' : ''}">
          ${linked ? '✅ Drive連携済み' : '☁ 未連携'}
        </div>
      </div>
      <div class="site-actions">
        <button class="btn-info" onclick="showSiteInfo('${site.id}')" title="情報">ℹ</button>
        <button class="btn-delete" onclick="deleteSite('${site.id}')" title="削除">🗑</button>
        <span class="site-chevron" onclick="openSite('${site.id}')">›</span>
      </div>`;
    list.appendChild(li);
  });
}

function deleteSite(siteId) {
  if (!confirm('この現場を削除しますか？')) return;
  state.sites = state.sites.filter(s => s.id !== siteId);
  Storage.saveSites(state.sites);
  renderSiteList();
}

// ===== 現場追加モーダル =====
function showAddSiteModal() {
  document.getElementById('input-site-name').value = '';
  document.getElementById('input-site-address').value = '';
  document.getElementById('btn-confirm-add').disabled = true;
  document.getElementById('modal-add-site').classList.remove('hidden');
  setTimeout(() => document.getElementById('input-site-name').focus(), 300);
}

function closeAddSiteModal() {
  document.getElementById('modal-add-site').classList.add('hidden');
}

function onSiteNameInput() {
  const val = document.getElementById('input-site-name').value.trim();
  document.getElementById('btn-confirm-add').disabled = val.length === 0;
}

function confirmAddSite() {
  const name = document.getElementById('input-site-name').value.trim();
  const address = document.getElementById('input-site-address').value.trim();
  if (!name) return;
  const site = { id: uuid(), name, address, driveFolderID: null };
  state.sites.push(site);
  Storage.saveSites(state.sites);
  closeAddSiteModal();
  renderSiteList();
}

// ===== 現場情報モーダル =====
function showSiteInfo(siteId) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;
  const body = document.getElementById('site-info-body');
  const url = site.driveFolderID ? folderURL(site.driveFolderID) : null;
  body.innerHTML = `
    <div class="site-info-header">
      <div class="site-info-icon">🏗</div>
      <div class="site-info-name">${escHtml(site.name)}</div>
      ${site.address ? `<div class="site-info-address">${escHtml(site.address)}</div>` : ''}
    </div>
    ${url ? `
    <div class="drive-info-card">
      <div class="drive-info-title">📁 Google Drive 保存先</div>
      <a href="${url}" target="_blank" class="drive-action-btn open">🔗 フォルダを開く</a>
      <button class="drive-action-btn share" onclick="shareURL('${url}', '${escHtml(site.name)}')">📤 URLを共有</button>
      <button class="drive-action-btn copy" onclick="copyText('${url}')">📋 URLをコピー</button>
    </div>` : `
    <div class="no-drive-msg">
      ☁<br>
      Google Driveのフォルダはまだ作成されていません<br>
      写真をアップロードすると自動で作成されます
    </div>`}`;
  document.getElementById('modal-site-info').classList.remove('hidden');
}

function closeSiteInfoModal() {
  document.getElementById('modal-site-info').classList.add('hidden');
}

// ===== 撮影ビューへ移動 =====
function openSite(siteId) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site) return;
  state.currentSite = site;
  state.capturedItems = [];
  state.siteFolderID = site.driveFolderID;

  // ヘッダー更新
  document.getElementById('header-title').textContent = site.name;
  document.getElementById('btn-back').classList.remove('hidden');
  document.getElementById('btn-add-site').classList.add('hidden');

  // ビュー切り替え
  document.getElementById('view-sites').classList.add('hidden');
  document.getElementById('view-capture').classList.remove('hidden');

  // 撮影者名を復元
  document.getElementById('input-photographer').value = Storage.getPhotographerName();

  // カテゴリチップ描画
  renderCategoryChips();

  // Driveフォルダカード
  updateFolderCard();

  // 撮影済みセクションをリセット
  updateCapturedSection();

  // 最近の写真を表示
  renderRecentPhotos();
}

function goBack() {
  // 状態をクリア
  state.currentSite = null;
  state.capturedItems = [];
  state.siteFolderID = null;

  // ヘッダーリセット
  document.getElementById('header-title').textContent = '現場一覧';
  document.getElementById('btn-back').classList.add('hidden');
  document.getElementById('btn-add-site').classList.remove('hidden');

  // ビュー切り替え
  document.getElementById('view-capture').classList.add('hidden');
  document.getElementById('view-sites').classList.remove('hidden');
  renderSiteList();
}

// ===== カテゴリチップ =====
function renderCategoryChips() {
  const container = document.getElementById('category-chips');
  container.innerHTML = '';
  CATEGORIES.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'chip' + (cat.id === state.selectedCategory ? ' selected' : '');
    btn.textContent = cat.icon + ' ' + cat.name;
    btn.onclick = () => {
      state.selectedCategory = cat.id;
      renderCategoryChips();
    };
    container.appendChild(btn);
  });
}

// ===== Drive フォルダカード =====
function updateFolderCard() {
  const card = document.getElementById('drive-folder-card');
  if (state.siteFolderID) {
    const url = folderURL(state.siteFolderID);
    document.getElementById('folder-url-link').href = url;
    document.getElementById('folder-url-link').textContent = url;
    card.classList.remove('hidden');
  } else {
    card.classList.add('hidden');
  }
}

// ===== 写真・動画の選択 =====
function onPhotoSelected(event) {
  const files = Array.from(event.target.files || []);
  files.forEach(file => {
    const previewURL = URL.createObjectURL(file);
    state.capturedItems.push({ file, previewURL, mediaType: 'photo' });
  });
  event.target.value = '';
  updateCapturedSection();
}

function onVideoSelected(event) {
  const file = event.target.files[0];
  if (!file) return;
  const previewURL = URL.createObjectURL(file);
  state.capturedItems.push({ file, previewURL, mediaType: 'video' });
  event.target.value = '';
  updateCapturedSection();
}

// ===== 撮影済みセクション更新 =====
function updateCapturedSection() {
  const hasItems = state.capturedItems.length > 0;
  document.getElementById('captured-section').classList.toggle('hidden', !hasItems);
  document.getElementById('metadata-section').classList.toggle('hidden', !hasItems);
  document.getElementById('btn-upload').classList.toggle('hidden', !hasItems);

  if (hasItems) {
    document.getElementById('captured-count-label').textContent = `撮影済み (${state.capturedItems.length}件)`;
    document.getElementById('upload-btn-text').textContent = `${state.capturedItems.length}件をGoogle Driveにアップロード`;
    renderThumbnails();
  }
}

function renderThumbnails() {
  const container = document.getElementById('captured-thumbnails');
  container.innerHTML = '';

  state.capturedItems.forEach((item, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'thumb-wrap';
    if (item.mediaType === 'photo') {
      const img = document.createElement('img');
      img.src = item.previewURL;
      wrap.appendChild(img);
    } else {
      const v = document.createElement('video');
      v.src = item.previewURL;
      v.muted = true;
      v.style.cssText = 'width:100%;height:100%;object-fit:cover;';
      wrap.appendChild(v);
      const badge = document.createElement('span');
      badge.className = 'thumb-video-badge';
      badge.textContent = '🎥 動画';
      wrap.appendChild(badge);
    }
    const removeBtn = document.createElement('button');
    removeBtn.className = 'thumb-remove';
    removeBtn.textContent = '×';
    removeBtn.onclick = () => removeCapturedItem(i);
    wrap.appendChild(removeBtn);
    container.appendChild(wrap);
  });

  // 追加ボタン
  const addBtn = document.createElement('label');
  addBtn.className = 'thumb-add';
  addBtn.innerHTML = '<span>＋</span><span class="thumb-add-label">追加</span>';
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*'; inp.capture = 'environment'; inp.multiple = true;
  inp.style.display = 'none';
  inp.onchange = onPhotoSelected;
  addBtn.appendChild(inp);
  container.appendChild(addBtn);
}

function removeCapturedItem(index) {
  const item = state.capturedItems[index];
  if (item) URL.revokeObjectURL(item.previewURL);
  state.capturedItems.splice(index, 1);
  updateCapturedSection();
}

function clearAllCaptures() {
  state.capturedItems.forEach(i => URL.revokeObjectURL(i.previewURL));
  state.capturedItems = [];
  updateCapturedSection();
}

// ===== アップロード =====
async function uploadAll() {
  if (!state.accessToken) {
    alert('先にGoogle Driveにサインインしてください。');
    driveSignIn();
    return;
  }
  if (state.capturedItems.length === 0) return;

  const photographer = document.getElementById('input-photographer').value.trim();
  const memo = document.getElementById('input-memo').value.trim();

  if (!photographer) {
    alert('撮影者名を入力してください。');
    document.getElementById('input-photographer').focus();
    return;
  }

  const total = state.capturedItems.length;
  state.uploadedCount = 0;

  showUploadingOverlay(0, total);

  try {
    // ルートフォルダ確保
    document.getElementById('upload-progress-text').textContent = 'フォルダを準備中...';
    const rootId = await ensureFolder('現場写真管理', null);
    const folderId = await ensureFolder(state.currentSite.name, rootId);
    state.siteFolderID = folderId;

    // 現場データにフォルダIDを保存
    const siteIdx = state.sites.findIndex(s => s.id === state.currentSite.id);
    if (siteIdx >= 0) {
      state.sites[siteIdx].driveFolderID = folderId;
      state.currentSite.driveFolderID = folderId;
      Storage.saveSites(state.sites);
    }

    // ファイルを順番にアップロード
    const recentPhotos = Storage.getRecentPhotos(state.currentSite.id);

    for (let i = 0; i < state.capturedItems.length; i++) {
      const item = state.capturedItems[i];
      document.getElementById('upload-progress-text').textContent = `${i+1}/${total} をアップロード中...`;
      updateUploadProgress(i, total);

      const ext = item.mediaType === 'video' ? '.mov' : '.jpg';
      const fname = uuid() + ext;

      await uploadFileToDrive(item.file, fname, folderId, {
        category: state.selectedCategory,
        photographer,
        memo,
      });

      recentPhotos.unshift({
        id: uuid(),
        mediaType: item.mediaType,
        category: state.selectedCategory,
        photographer,
        memo,
        uploadedAt: new Date().toISOString(),
        uploadStatus: 'completed',
      });

      state.uploadedCount = i + 1;
      updateUploadProgress(i + 1, total);
    }

    Storage.saveRecentPhotos(state.currentSite.id, recentPhotos);
    Storage.savePhotographerName(photographer);

    // 後片付け
    clearAllCaptures();
    document.getElementById('input-memo').value = '';
    updateFolderCard();
    renderRecentPhotos();

    hideUploadingOverlay();
    showSuccessOverlay(total);

    // バイブレーション (Android / 対応機種)
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);

  } catch (err) {
    hideUploadingOverlay();
    alert('アップロードに失敗しました:\n' + err.message);
  }
}

// ===== アップロードオーバーレイ =====
function showUploadingOverlay(done, total) {
  document.getElementById('overlay-uploading').classList.remove('hidden');
  document.getElementById('upload-count-text').textContent = `${done} / ${total}`;
  updateUploadProgress(done, total);
}

function updateUploadProgress(done, total) {
  document.getElementById('upload-count-text').textContent = `${done} / ${total}`;
  const pct = total > 0 ? (done / total * 100) : 0;
  document.getElementById('upload-progress-fill').style.width = pct + '%';
}

function hideUploadingOverlay() {
  document.getElementById('overlay-uploading').classList.add('hidden');
}

// ===== 完了オーバーレイ =====
function showSuccessOverlay(count) {
  document.getElementById('success-count-text').textContent = `${count}件のファイルを保存しました`;
  document.getElementById('overlay-success').classList.remove('hidden');
}

function closeSuccess() {
  document.getElementById('overlay-success').classList.add('hidden');
}

// ===== 最近の写真 =====
function renderRecentPhotos() {
  if (!state.currentSite) return;
  const photos = Storage.getRecentPhotos(state.currentSite.id);
  const section = document.getElementById('recent-section');
  const grid = document.getElementById('recent-grid');
  if (photos.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  grid.innerHTML = '';
  photos.slice(0, 9).forEach(p => {
    const div = document.createElement('div');
    div.className = 'recent-thumb';
    const cat = CATEGORIES.find(c => c.id === p.category) || CATEGORIES[0];
    div.innerHTML = `
      <div class="recent-thumb-icon">${p.mediaType === 'video' ? '🎥' : cat.icon}</div>
      <div class="recent-status-badge">${p.uploadStatus === 'completed' ? '✅' : '🕐'}</div>`;
    grid.appendChild(div);
  });
}

// ===== Drive URL 操作 =====
function shareFolder() {
  if (!state.siteFolderID) return;
  const url = folderURL(state.siteFolderID);
  shareURL(url, state.currentSite ? state.currentSite.name : '');
}

function shareURL(url, title) {
  if (navigator.share) {
    navigator.share({ title: title + ' - 現場写真フォルダ', url })
      .catch(() => {});
  } else {
    copyText(url);
    alert('URLをクリップボードにコピーしました');
  }
}

function copyFolderURL() {
  if (!state.siteFolderID) return;
  copyText(folderURL(state.siteFolderID));
  alert('URLをクリップボードにコピーしました');
}

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  el.style.position = 'fixed';
  el.style.opacity = '0';
  document.body.appendChild(el);
  el.select();
  document.execCommand('copy');
  document.body.removeChild(el);
}

// ===== ユーティリティ =====
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ===== 初期化 =====
function init() {
  // Service Worker 登録
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Google Auth 初期化
  initGoogleAuth();
  updateStatusBar();

  // 現場一覧を表示
  renderSiteList();
}

// DOMが準備できたら初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
