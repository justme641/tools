/* app.js — 資料層與畫面
 * 版本 0.1.0（第一階段）
 */
(function () {
  'use strict';
  const VERSION = '0.3.0';
  const CHANGELOG = [
    ['0.3.0', '2026-11-13', '商品編輯頁浮動查價鈕（長按換賣場）；賣場連結收合；編輯／刪除鈕移到頁首；單價改上下兩行；N件$X 單件價可留空；新增「其他賣場」與實際購買處'],
    ['0.2.0', '2026-11-12', '第二階段：特價規則與結帳引擎（含混搭）、特價頁；首頁分類篩選；商品頁區塊可調順序、左右滑動、浮動購物車鈕；歷史價格編輯多選刪除與單價；價格紀錄支援買N件優惠'],
    ['0.1.0', '2026-11-11', '第一階段：掃碼、商品庫、價格紀錄、賣場連結、BigGo 參考、購物車、購物紀錄、JSON 匯出入']
  ];
  const SETTING_KEYS = ['categories', 'backupDays', 'bigGoTemplate', 'theme', 'itemOrder'];
  const UNITS = ['ml', 'l', 'g', 'kg', '片', '個', '入', '包', '抽', '瓶', '罐'];
  const PAYS = ['現金', '信用卡', '行動支付', '其他'];

  /* ---------- 小工具 ---------- */
  const $ = s => document.querySelector(s);
  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmt = Core.fmtMoney;
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  const safeImg = s => (typeof s === 'string' && s.startsWith('data:image/')) ? s : '';

  /* ---------- IndexedDB ---------- */
  const TABLES = Core.TABLES;
  let idb;
  function openDB() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('shopping-db', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        TABLES.concat(['settings']).forEach(t => {
          if (!d.objectStoreNames.contains(t)) d.createObjectStore(t, { keyPath: t === 'settings' ? 'key' : 'id' });
        });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  function tx(t, mode, fn) {
    return new Promise((res, rej) => {
      const x = idb.transaction(t, mode);
      const rq = fn(x.objectStore(t));
      x.oncomplete = () => res(rq && rq.result);
      x.onerror = () => rej(x.error);
      x.onabort = () => rej(x.error);
    });
  }
  const idbAll = t => tx(t, 'readonly', s => s.getAll());
  const idbPut = (t, o) => tx(t, 'readwrite', s => s.put(o));
  const idbDel = (t, id) => tx(t, 'readwrite', s => s.delete(id));
  const idbClear = t => tx(t, 'readwrite', s => s.clear());

  /* ---------- 記憶體資料（寫入時同步寫 IndexedDB） ---------- */
  const S = { settings: {} };
  TABLES.forEach(t => { S[t] = []; });

  async function loadAll() {
    for (const t of TABLES) S[t] = await idbAll(t);
    const rows = await idbAll('settings');
    S.settings = {};
    rows.forEach(r => { S.settings[r.key] = r.value; });
  }
  async function save(table, obj) {
    const i = S[table].findIndex(x => x.id === obj.id);
    if (i >= 0) S[table][i] = obj; else S[table].push(obj);
    await idbPut(table, obj);
    return obj;
  }
  async function remove(table, id) {
    S[table] = S[table].filter(x => x.id !== id);
    await idbDel(table, id);
  }
  async function setSetting(key, value) {
    S.settings[key] = value;
    await idbPut('settings', { key, value });
  }
  async function seed() {
    if (!S.stores.length) {
      for (const d of Core.DEFAULT_STORES) await save('stores', { id: Core.uid(), ...d });
    }
    if (!S.settings.otherSeeded) {
      if (!S.stores.some(x => x.id === OTHER_ID)) await save('stores', { id: OTHER_ID, name: '其他賣場', kind: 'physical', template: '', rounding: 'line-round' });
      await setSetting('otherSeeded', true);
    }
    if (!S.settings.categories) await setSetting('categories', Core.DEFAULT_CATEGORIES.slice());
    if (!S.settings.backupDays) await setSetting('backupDays', 14);
    if (!S.settings.bigGoTemplate) await setSetting('bigGoTemplate', Core.BIGGO_TEMPLATE);
    if (!S.settings.cart) await setSetting('cart', { storeId: '', lines: [] });
    if (!S.settings.installedAt) await setSetting('installedAt', Date.now());
  }

  /* ---------- 查詢輔助 ---------- */
  const itemById = id => S.items.find(i => i.id === id);
  const storeById = id => S.stores.find(s => s.id === id);
  const storeName = id => (storeById(id) || { name: '（已刪除賣場）' }).name;
  const OTHER_ID = 'store-other'; // 「其他賣場」：購買處不在清單時使用，可另填實際購買處
  const placeName = p => storeName(p.storeId) + (p.place ? '（' + p.place + '）' : '');
  const recStore = r => (r.storeName || storeName(r.storeId)) + (r.place ? '（' + r.place + '）' : '');
  // 單價：上排單位量（100g）、下排金額（$65）
  const unitCell = u => u ? '<div class="ucell"><span>' + esc(u.per) + '</span><b>' + fmt(u.value) + '</b></div>' : '-';
  const pricesOf = itemId => S.prices.filter(p => p.itemId === itemId);
  const byDateDesc = (a, b) => (b.date + (b.createdAt || 0)).localeCompare(a.date + (a.createdAt || 0));
  const readOnly = () => !!S.settings.readOnly;
  function specText(i) {
    if (!(Number(i.size) > 0)) return '';
    return i.size + (i.unit || '') + (Number(i.packQty) > 1 ? ' × ' + i.packQty : '');
  }
  function latestPrice(itemId, storeId) {
    const ps = pricesOf(itemId).filter(p => p.storeId === storeId).sort(byDateDesc);
    return ps[0] || null;
  }
  function cart() { return S.settings.cart || { storeId: '', lines: [] }; }
  function cartStore() { return storeById(cart().storeId); }
  function roundingMode() { const s = cartStore(); return s && s.rounding ? s.rounding : 'line-round'; }

  /* ---------- 路由 ---------- */
  function route() {
    const h = location.hash.replace(/^#/, '') || '/';
    const [path, query] = h.split('?');
    const parts = path.split('/').filter(Boolean);
    const params = new URLSearchParams(query || '');
    return { parts, params };
  }
  let lastHash = null;
  function render() {
    const { parts, params } = route();
    const v = parts[0] || 'home';
    if (v === 'item') { if (parts[1] !== lastItemId) { historyEdit = false; historySel.clear(); lastItemId = parts[1]; } } else lastItemId = null;
    let html = '', nav = v;
    try {
      if (v === 'home') html = viewHome(params);
      else if (v === 'item') html = viewItem(parts[1]);
      else if (v === 'edit') { html = viewEdit(parts[1], params); nav = 'home'; }
      else if (v === 'cart') html = viewCart();
      else if (v === 'promos') html = viewPromos();
      else if (v === 'rule') { html = viewRule(parts[1], params); nav = 'promos'; }
      else if (v === 'campaign') { html = viewCampaign(parts[1]); nav = 'promos'; }
      else if (v === 'records') html = viewRecords();
      else if (v === 'record') { html = viewRecord(parts[1]); nav = 'records'; }
      else if (v === 'settings') html = viewSettings();
      else html = viewHome(params);
    } catch (e) {
      html = '<div class="card">畫面發生錯誤：' + esc(e.message) + '</div>';
      console.error(e);
    }
    $('#view').innerHTML = html;
    document.querySelectorAll('#nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === nav));
    const n = cart().lines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
    $('#cartBadge').textContent = n ? ' (' + n + ')' : '';
    if (location.hash !== lastHash) { window.scrollTo(0, 0); lastHash = location.hash; }
  }
  function go(hash) { if (location.hash === hash) render(); else location.hash = hash; }

  /* ---------- 首頁 ---------- */
  function itemRow(i) {
    const ps = pricesOf(i.id).sort(byDateDesc);
    const last = ps[0];
    const photo = safeImg(i.photo);
    return '<a class="row" href="#/item/' + esc(i.id) + '">' +
      '<div class="thumb">' + (photo ? '<img src="' + photo + '" alt="">' : '📦') + '</div>' +
      '<div class="grow"><b>' + esc(i.name) + '</b><div class="sub">' +
      esc([i.brand, specText(i), i.category].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="right">' + (last ? '<b>' + fmt(last.price) + '</b><div class="sub">' + esc(storeName(last.storeId)) + '</div>'
        : '<span class="sub">尚無價格</span>') + '</div></a>';
  }
  let homeQuery = '', homeCat = '';
  let navList = []; // 商品頁左右滑動的順序（取自首頁目前的列表）
  function homeList() {
    const q = homeQuery.trim().toLowerCase();
    let list = S.items.slice();
    if (homeCat === '__none') list = list.filter(i => !i.category);
    else if (homeCat) list = list.filter(i => i.category === homeCat);
    if (q) list = list.filter(i => [i.name, i.brand, i.barcode, i.category].some(x => String(x || '').toLowerCase().includes(q)));
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function categoryChips() {
    const counts = {};
    let none = 0;
    S.items.forEach(i => { if (i.category) counts[i.category] = (counts[i.category] || 0) + 1; else none++; });
    const cats = (S.settings.categories || []).slice();
    Object.keys(counts).forEach(c => { if (!cats.includes(c)) cats.push(c); });
    const chip = (v, label, n) => '<button class="chipbtn' + (homeCat === v ? ' on' : '') + '" data-act="cat" data-v="' + esc(v) + '">' + esc(label) + ' ' + n + '</button>';
    let h = '<div class="chips">' + chip('', '全部', S.items.length);
    cats.forEach(c => { if (counts[c] || homeCat === c) h += chip(c, c, counts[c] || 0); });
    if (none || homeCat === '__none') h += chip('__none', '未分類', none);
    return h + '</div>';
  }
  function viewHome() {
    const list = homeList();
    navList = list.map(i => i.id);
    const q = homeQuery.trim();
    const days = Number(S.settings.backupDays) || 14;
    const last = S.settings.lastExport;
    let banner = '';
    if (S.items.length && (!last || (Date.now() - last) / 86400000 >= days)) {
      banner = '<div class="banner warn">' + (last ? '已超過 ' + days + ' 天未備份' : '尚未備份過') +
        '，資料只存在這支手機的瀏覽器裡，建議到「設定」匯出備份。</div>';
    }
    return '<h1>商品查價</h1>' + banner +
      (readOnly() ? '' : '<div class="btns"><button class="primary" data-act="scan">📷 掃描條碼</button></div>') +
      '<form data-form="barcode" class="grid2" style="grid-template-columns:1fr auto">' +
      '<input name="code" inputmode="numeric" placeholder="手動輸入條碼" autocomplete="off"><button class="primary">查詢</button></form>' +
      '<label>搜尋商品（名稱、品牌、條碼、分類）</label>' +
      '<input id="homeSearch" type="search" value="' + esc(homeQuery) + '" placeholder="例如：洗髮精" autocomplete="off">' +
      '<label>分類</label>' + categoryChips() +
      '<h2>' + (q || homeCat ? '符合的商品（' + list.length + '）' : '最近的商品') + '</h2>' +
      (list.length ? list.slice(0, 100).map(itemRow).join('') + (list.length > 100 ? '<div class="hint">只顯示前 100 筆，請用搜尋或分類縮小範圍。</div>' : '') :
        '<div class="card sub">' + (S.items.length ? '沒有符合的商品。' : '還沒有商品，掃描條碼或按下方新增。') + '</div>') +
      (readOnly() ? '' : '<div class="btns"><a class="btn" href="#/edit/new">＋ 手動新增商品</a></div>');
  }

  /* ---------- 商品頁 ---------- */
  function linkUrl(item, store) {
    const l = S.storeLinks.find(x => x.itemId === item.id && x.storeId === store.id);
    if (l && Core.isHttpUrl(l.url)) return { url: l.url, bound: true };
    const u = Core.searchUrl(store.template, item.name);
    return { url: Core.isHttpUrl(u) ? u : '', bound: false };
  }
  const SECTIONS = {
    price: '各賣場最新價', promos: '有效特價', add: '記錄價格',
    links: '到賣場查價', biggo: 'BigGo 歷史價（參考）', history: '我的價格歷史'
  };
  const DEFAULT_ORDER = ['price', 'promos', 'add', 'links', 'biggo', 'history'];
  let reorderMode = false, historyEdit = false, lastItemId = null, linksOpen = false;
  const historySel = new Set();
  function sectionOrder() {
    const out = (S.settings.itemOrder || []).filter(k => SECTIONS[k]);
    DEFAULT_ORDER.forEach(k => { if (!out.includes(k)) out.push(k); });
    return out;
  }
  function itemOrderIds(id) {
    if (navList.includes(id)) return navList;
    return S.items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(i => i.id);
  }
  function stepItem(d) {
    const id = route().parts[1];
    if (!id) return;
    const ids = itemOrderIds(id).filter(x => itemById(x));
    const j = ids.indexOf(id) + d;
    if (j < 0) { toast('已是第一筆'); return; }
    if (j >= ids.length) { toast('已是最後一筆'); return; }
    location.replace(location.pathname + location.search + '#/item/' + ids[j]);
  }
  function dealText(p) { return p && p.deal ? Core.describePromo(p.deal.kind, p.deal) : ''; }

  function dealFieldsHtml() {
    return '<label>優惠方式（選填，例如買 2 件比較便宜）</label><select name="dealKind" data-dealsel>' +
      '<option value="">無（只記單件價格）</option>' +
      '<option value="bundle">N 件 $X（例如 2 件 $90）</option>' +
      '<option value="buyget">買 N 送 M</option>' +
      '<option value="nth">第 N 件 X 折</option></select>' +
      ['bundle', 'buyget', 'nth'].map(t => '<div data-deal="' + t + '" hidden>' + paramFieldsHtml(t, {}) + '</div>').join('') +
      '<div data-dealsync hidden><label class="check"><input type="checkbox" name="syncRule" checked> 同時建立特價規則（購物車自動計算）</label>' +
      '<label>特價到期日（選填）</label><input name="dealEnd" type="date"></div>';
  }

  function viewItem(id) {
    const it = itemById(id);
    if (!it) return '<div class="card">找不到這個商品。<div class="btns"><a class="btn" href="#/">回首頁</a></div></div>';
    const ro = readOnly();
    const ps = pricesOf(id).sort(byDateDesc);
    const latest = Core.latestByStore(ps);
    const low = Core.lowestPrice(ps);
    const photo = safeImg(it.photo);
    const ids = itemOrderIds(id).filter(x => itemById(x));
    const pos = ids.indexOf(id);
    const today = Core.todayStr();
    const inCart = cart().lines.filter(l => l.itemId === id).reduce((s, l) => s + Number(l.qty), 0);

    // ---- 上方：可左右滑動的商品資訊 ----
    let h = '<div id="swipeZone" class="hero">' +
      '<button class="nav-arrow" data-act="stepItem" data-d="-1" aria-label="上一筆"' + (pos <= 0 ? ' disabled' : '') + '>‹</button>' +
      '<div class="hero-main">' + (photo ? '<img class="big-photo" src="' + photo + '" alt="">' : '') +
      '<h1>' + esc(it.name) + '</h1>' +
      '<div class="sub">' + esc([it.brand, it.category, specText(it)].filter(Boolean).join(' · ')) + '</div>' +
      '<div class="sub">條碼：' + esc(it.barcode || '無') + '</div>' +
      (it.note ? '<div style="margin-top:6px">' + esc(it.note) + '</div>' : '') +
      (ids.length > 1 ? '<div class="sub" style="margin-top:6px">' + (pos + 1) + ' / ' + ids.length + ' · 左右滑動切換商品</div>' : '') +
      '</div>' +
      '<button class="nav-arrow" data-act="stepItem" data-d="1" aria-label="下一筆"' + (pos >= ids.length - 1 ? ' disabled' : '') + '>›</button></div>' +
      '<div class="btns"><button class="small" data-act="reorder">' + (reorderMode ? '✔ 完成調整' : '↕ 調整區塊順序') + '</button></div>' +
      (ro ? '' : '<div class="btns"><a class="btn small" href="#/edit/' + esc(id) + '">✎ 編輯商品</a><button class="small danger" data-act="delItem" data-id="' + esc(id) + '">🗑 刪除商品</button></div>');

    // ---- 各區塊內容 ----
    const body = {};

    // 各賣場最新價
    const storeIds = Object.keys(latest);
    if (!storeIds.length) body.price = '<div class="card sub">尚無價格紀錄。</div>';
    else {
      let b = '<div class="card"><table class="tbl"><tr><th>賣場</th><th class="r">每件價</th><th class="r">單價</th></tr>';
      storeIds.sort((a, c) => Core.effectivePrice(latest[a]) - Core.effectivePrice(latest[c])).forEach(sid => {
        const p = latest[sid], ep = Core.effectivePrice(p), u = Core.unitPrice(ep, it);
        b += '<tr><td>' + esc(placeName(p)) + (p.onSale ? '<span class="chip warn">特價</span>' : '') +
          '<div class="sub">' + esc(p.date) + '</div></td><td class="r"><b>' + fmt(ep) + '</b>' +
          (p.deal ? '<div class="sub">' + esc(dealText(p)) + (p.noSingle ? '' : '（單件 ' + fmt(p.price) + '）') + '</div>' : '') + '</td>' +
          '<td class="r sub">' + unitCell(u) + '</td></tr>';
      });
      b += '</table>' + (low ? '<div class="sub" style="margin-top:6px">歷史最低價：' + fmt(Core.effectivePrice(low)) + '（' +
        esc(placeName(low)) + '，' + esc(low.date) + (low.deal ? '，' + esc(dealText(low)) : '') + '）</div>' : '') + '</div>';
      body.price = b;
    }

    // 有效特價
    const rl = S.promoRules.filter(r => S.promoItems.some(x => x.ruleId === r.id && x.itemId === id))
      .map(r => ({ r, c: S.promoCampaigns.find(c => c.id === r.campaignId) })).filter(x => x.c);
    const live = rl.filter(x => Core.campaignStatus(x.c, today) !== 'expired')
      .sort((a, b) => STATUS_ORDER[Core.campaignStatus(a.c, today)] - STATUS_ORDER[Core.campaignStatus(b.c, today)]);
    const expired = rl.length - live.length;
    let pb = '<div class="card">';
    if (!live.length) pb += '<div class="sub">目前沒有進行中的特價。</div>';
    live.forEach(x => {
      pb += '<div class="row" style="margin:6px 0"><div class="grow"><b>' + esc(ruleDesc(x.r)) + '</b>' + statusChip(Core.campaignStatus(x.c, today)) +
        '<div class="sub">' + esc(storeName(x.c.storeId)) + ' · ' + esc(x.c.name) + ' · ' + esc(periodText(x.c)) + '</div></div>' +
        (ro ? '' : '<a class="btn small" href="#/rule/' + esc(x.r.id) + '">編輯</a>') + '</div>';
    });
    if (expired) pb += '<div class="hint">另有 ' + expired + ' 條已過期的特價，可在「特價」頁查看。</div>';
    if (!ro) pb += '<div class="btns"><a class="btn" href="#/rule/new?item=' + esc(id) + '">＋ 新增這個商品的特價</a></div>';
    body.promos = pb + '</div>';

    // 記錄價格
    if (!ro) {
      const lastStore = S.settings.lastStore || (S.stores[0] && S.stores[0].id);
      body.add = '<form class="card" data-form="price" data-id="' + esc(id) + '">' +
        '<div class="grid2"><div><label>賣場</label><select name="storeId">' +
        S.stores.map(s => '<option value="' + esc(s.id) + '"' + (s.id === lastStore ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') +
        '</select></div><div><label>單件價格（元）<span class="sub" data-pricehint></span></label><input name="price" type="number" inputmode="decimal" step="any" min="0" required></div></div>' +
        '<div data-otherwrap' + (lastStore === OTHER_ID ? '' : ' hidden') + '><label>實際購買處（備註，選填）</label><input name="place" placeholder="例如：某某超市、網拍名稱"></div>' +
        '<div class="grid2"><div><label>日期</label><input name="date" type="date" value="' + today + '" required></div>' +
        '<div><label>備註</label><input name="note" placeholder="例如：會員價"></div></div>' +
        '<label class="check"><input type="checkbox" name="onSale"> 這是特價價格</label>' + dealFieldsHtml() +
        '<div class="btns"><button class="primary">儲存價格</button></div></form>';
    }

    // 到賣場查價
    let lb = '<details class="card" data-det="links"' + (linksOpen ? ' open' : '') + '><summary>展開賣場連結（' + S.stores.filter(x => x.id !== OTHER_ID).length + ' 家）</summary><div class="hint">開啟賣場商品頁（已綁定網址）或用商品名稱搜尋，看完價格再回來記錄。</div>';
    S.stores.forEach(s => {
      if (s.id === OTHER_ID) return;
      const l = linkUrl(it, s);
      lb += '<div class="row" style="margin:6px 0"><div class="grow"><b>' + esc(s.name) + '</b><div class="sub">' +
        (l.bound ? '已綁定商品頁' : '名稱搜尋') + '</div></div>' +
        (l.url ? '<a class="btn small" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">開啟</a>' : '<span class="sub">無網址範本</span>') +
        (ro ? '' : '<button class="small" data-act="bind" data-id="' + esc(it.id) + '" data-store="' + esc(s.id) + '">' + (l.bound ? '改網址' : '綁定') + '</button>') +
        '</div>';
    });
    body.links = lb + '</details>';

    // BigGo 參考
    const refs = S.refPrices.filter(r => r.itemId === id).sort((a, b) => b.date.localeCompare(a.date));
    const bigUrl = Core.searchUrl(S.settings.bigGoTemplate || Core.BIGGO_TEMPLATE, it.name);
    let bb = '<div class="card"><div class="hint">僅供比較，不計入你的價格紀錄與結帳。</div>' +
      '<div class="btns"><a class="btn" href="' + esc(bigUrl) + '" target="_blank" rel="noopener noreferrer">開啟 BigGo</a></div>';
    refs.forEach(r => {
      bb += '<div class="row" style="margin:6px 0"><div class="grow">' + fmt(r.price) + '<span class="chip">參考</span><div class="sub">' +
        esc(r.date) + (r.note ? ' · ' + esc(r.note) : '') + '</div></div>' +
        (ro ? '' : '<button class="small danger" data-act="delRef" data-id="' + esc(r.id) + '">刪除</button>') + '</div>';
    });
    if (!ro) {
      bb += '<form data-form="ref" data-id="' + esc(id) + '"><div class="grid2"><div><label>參考價（元）</label>' +
        '<input name="price" type="number" inputmode="decimal" step="any" min="0" required></div>' +
        '<div><label>日期</label><input name="date" type="date" value="' + today + '" required></div></div>' +
        '<label>備註</label><input name="note" placeholder="例如：近一年低點">' +
        '<div class="btns"><button>記下參考價</button></div></form>';
    }
    body.biggo = bb + '</div>';

    // 我的價格歷史（編輯模式可勾選多筆刪除）
    if (!ps.length) body.history = '<div class="card sub">尚無價格紀錄。</div>';
    else {
      let hb = '<div class="card">';
      if (historyEdit) {
        hb += '<div class="btns" style="margin-top:0"><button class="small" data-act="histAll">全選／取消全選</button>' +
          '<button class="small danger" data-act="histDel"' + (historySel.size ? '' : ' disabled') + '>刪除所選（' + historySel.size + '）</button></div>';
      }
      hb += '<table class="tbl"><tr>' + (historyEdit ? '<th></th>' : '') + '<th>日期</th><th>賣場</th><th class="r">價格</th><th class="r">單價</th></tr>';
      ps.slice(0, 100).forEach(p => {
        const ep = Core.effectivePrice(p), u = Core.unitPrice(ep, it);
        hb += '<tr>' + (historyEdit ? '<td><input type="checkbox" data-hsel="' + esc(p.id) + '"' + (historySel.has(p.id) ? ' checked' : '') + '></td>' : '') +
          '<td>' + esc(p.date) + '</td><td>' + esc(placeName(p)) + (p.onSale ? '<span class="chip warn">特價</span>' : '') +
          (p.deal ? '<div class="sub">' + esc(dealText(p)) + '</div>' : '') + (p.note ? '<div class="sub">' + esc(p.note) + '</div>' : '') + '</td>' +
          '<td class="r">' + (p.noSingle ? '—' : fmt(p.price)) + (p.deal ? '<div class="sub">均 ' + fmt(ep) + '</div>' : '') + '</td>' +
          '<td class="r sub">' + unitCell(u) + '</td></tr>';
      });
      body.history = hb + '</table>' + (ps.length > 100 ? '<div class="hint">只顯示最近 100 筆。</div>' : '') + '</div>';
    }

    // ---- 依使用者排序組裝 ----
    const order = sectionOrder().filter(k => body[k] !== undefined);
    order.forEach((k, idx) => {
      let ctl = '';
      if (reorderMode) {
        ctl = '<button class="small" data-act="secMove" data-k="' + k + '" data-d="-1"' + (idx === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button class="small" data-act="secMove" data-k="' + k + '" data-d="1"' + (idx === order.length - 1 ? ' disabled' : '') + '>▼</button>';
      } else if (k === 'history' && ps.length && !ro) {
        ctl = '<button class="small" data-act="histEdit">' + (historyEdit ? '完成' : '編輯') + '</button>';
      }
      h += '<section class="sec"><div class="sec-h"><h2>' + SECTIONS[k] + '</h2><span class="sec-ctl">' + ctl + '</span></div>' + body[k] + '</section>';
    });

    h += '<div style="height:72px"></div>';
    if (!ro) {
      h += '<button class="fab" data-act="addCart" data-id="' + esc(id) + '" aria-label="加入購物車">🛒<span class="fab-plus">＋</span>' +
        (inCart ? '<span class="fab-badge">' + inCart + '</span>' : '') + '</button>';
    }
    return h;
  }

  /* ---------- 新增／編輯商品 ---------- */
  function viewEdit(id, params) {
    if (readOnly()) return '<div class="card">目前是唯讀模式，無法編輯。</div>';
    const isNew = id === 'new';
    const it = isNew ? { barcode: params.get('barcode') || '', unit: 'ml', packQty: 1 } : itemById(id);
    if (!it) return '<div class="card">找不到這個商品。</div>';
    const cats = S.settings.categories || Core.DEFAULT_CATEGORIES;
    const photo = safeImg(it.photo);
    return '<h1>' + (isNew ? '新增商品' : '編輯商品') + '</h1>' +
      '<form class="card" data-form="item" data-id="' + esc(isNew ? '' : it.id) + '">' +
      '<label>條碼（無條碼的商品可留空）</label><input name="barcode" inputmode="numeric" value="' + esc(it.barcode) + '" autocomplete="off">' +
      '<label>名稱 *</label><input name="name" required value="' + esc(it.name) + '">' +
      '<div class="grid2"><div><label>品牌</label><input name="brand" value="' + esc(it.brand) + '"></div>' +
      '<div><label>分類</label><select name="category"><option value="">（未分類）</option>' +
      cats.map(c => '<option' + (c === it.category ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div></div>' +
      '<div class="grid2"><div><label>容量／數量</label><input name="size" type="number" inputmode="decimal" step="any" min="0" value="' + esc(it.size) + '"></div>' +
      '<div><label>單位</label><select name="unit">' +
      UNITS.map(u => '<option' + (u === it.unit ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select></div></div>' +
      '<label>每組入數（例如 6 入組填 6）</label><input name="packQty" type="number" inputmode="numeric" min="1" step="1" value="' + esc(it.packQty || 1) + '">' +
      '<label>照片</label>' + (photo ? '<img class="big-photo" id="photoPrev" src="' + photo + '" alt="">' : '<img class="big-photo" id="photoPrev" style="display:none" alt="">') +
      '<input id="photoFile" type="file" accept="image/*">' +
      (photo ? '<label class="check"><input type="checkbox" name="rmPhoto"> 移除照片</label>' : '') +
      '<label>備註</label><textarea name="note">' + esc(it.note) + '</textarea>' +
      '<div class="btns"><button class="primary">儲存</button><a class="btn" href="' + (isNew ? '#/' : '#/item/' + esc(it.id)) + '">取消</a></div></form>' + searchFabHtml();
  }
  let pendingPhoto = null;
  function resizeImage(file) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onerror = () => rej(fr.error);
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => rej(new Error('無法讀取這張圖片'));
        img.onload = () => {
          const max = 640, r = Math.min(1, max / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * r); c.height = Math.round(img.height * r);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          res(c.toDataURL('image/jpeg', 0.7));
        };
        img.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  /* ---------- 購物車 ---------- */
  // 取出某賣場、某日有效的特價規則（含適用商品）
  function activeRulesFor(storeId, date) {
    if (!storeId) return [];
    const camps = S.promoCampaigns.filter(c => c.storeId === storeId && Core.campaignStatus(c, date) === 'active');
    const byId = {};
    camps.forEach(c => { byId[c.id] = c; });
    return S.promoRules.filter(r => byId[r.campaignId]).map(r => ({
      id: r.id, type: r.type, params: r.params || {}, limit: r.limit,
      campaignName: byId[r.campaignId].name,
      itemIds: S.promoItems.filter(x => x.ruleId === r.id).map(x => x.itemId)
    }));
  }
  function cartCompute() {
    const c = cart();
    const all = activeRulesFor(c.storeId, Core.todayStr());
    const disabled = c.disabled || [];
    const rules = all.filter(r => !disabled.includes(r.id));
    const res = Core.computePromos(c.lines.map(l => ({ itemId: l.itemId, qty: l.qty, price: l.price })), rules, roundingMode());
    return { c, all, rules, res, disabled };
  }
  function ruleLabel(r) {
    return Core.describePromo(r.type, r.params) + (Number(r.limit) > 0 && r.type !== 'threshold' ? '・每單限 ' + r.limit + ' 組' : '');
  }

  function viewCart() {
    if (readOnly()) return '<div class="card">目前是唯讀模式，購物車停用。</div>';
    const { c, all, res, disabled } = cartCompute();
    const mode = roundingMode();
    const missing = c.lines.filter(l => l.price === null || l.price === undefined || l.price === '' || !(Number(l.price) >= 0)).length;
    let h = '<h1>購物車</h1><label>結帳賣場</label><select id="cartStore"><option value="">請選擇賣場</option>' +
      S.stores.map(s => '<option value="' + esc(s.id) + '"' + (s.id === c.storeId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>' +
      (c.storeId === OTHER_ID ? '<label>實際購買處（備註，選填）</label><input id="cartPlace" value="' + esc(c.place || '') + '" placeholder="例如：某某超市">' : '');
    if (!c.lines.length) return h + '<div class="card sub" style="margin-top:12px">購物車是空的。到商品頁按右下角的購物車鈕加入。</div>';

    h += '<div style="margin-top:8px">';
    c.lines.forEach((l, idx) => {
      const it = itemById(l.itemId), L = res.lines[idx];
      const saved = L.raw - L.sub;
      h += '<div class="card"><div class="row" style="border:0;padding:0;margin:0"><div class="grow"><b>' + esc(it ? it.name : '（已刪除商品）') + '</b>' +
        '<div class="sub">' + esc(it ? specText(it) : '') + '</div></div>' +
        '<button class="small danger" data-act="cartDel" data-i="' + idx + '">移除</button></div>' +
        '<div class="grid2" style="align-items:end"><div><label>單價（元）</label><input type="number" inputmode="decimal" step="any" min="0" data-cartprice="' + idx + '" value="' +
        (l.price === null || l.price === undefined ? '' : esc(l.price)) + '" placeholder="輸入價格"></div>' +
        '<div class="qty"><button data-act="cartQty" data-i="' + idx + '" data-d="-1">−</button><span>' + esc(l.qty) +
        '</span><button data-act="cartQty" data-i="' + idx + '" data-d="1">＋</button></div></div>';
      L.promos.forEach(p => {
        const r = all.find(x => x.id === p.ruleId);
        h += '<div class="sub promo-line">🏷 ' + esc(r ? ruleLabel(r) : '特價') + ' −' + fmt(p.amount) + '</div>';
      });
      h += '<div class="right sub" style="margin-top:6px">' + (saved > 0.005 ? '<s>' + fmt(L.raw) + '</s> ' : '') + '小計 <b>' + fmt(L.sub) + '</b></div></div>';
    });
    h += '</div>';

    // 本店與購物車有關的特價（可逐條關閉，以收銀實際為準）
    const relevant = all.filter(r => r.type === 'threshold' || r.itemIds.some(id => c.lines.some(l => l.itemId === id)));
    if (c.storeId && relevant.length) {
      h += '<div class="card"><b>本店進行中的特價</b><div class="hint">與實際收銀不符時，可取消勾選該條規則。</div>';
      relevant.forEach(r => {
        const on = !disabled.includes(r.id), used = res.applied.includes(r.id);
        h += '<label class="check" style="margin:8px 0"><input type="checkbox" data-ruletoggle="' + esc(r.id) + '"' + (on ? ' checked' : '') + '> <span>' +
          esc(ruleLabel(r)) + '<span class="sub"> · ' + esc(r.campaignName) + '</span>' +
          (on ? (used ? '<span class="chip">已套用</span>' : '<span class="chip warn">未達條件</span>') : '<span class="chip warn">已停用</span>') + '</span></label>';
      });
      h += '</div>';
    } else if (!c.storeId) {
      h += '<div class="hint">選擇結帳賣場後，會自動套用該店進行中的特價。</div>';
    }

    h += '<div class="card"><div class="sub">共 ' + c.lines.length + ' 項、' + res.qtyCount + ' 件 · ' + esc(Core.ROUNDING_MODES[mode]) + '</div>' +
      '<table class="tbl"><tr><td>原價合計</td><td class="r">' + fmt(res.rawSum) + '</td></tr>' +
      (res.promoDiscount > 0.005 ? '<tr><td>特價折扣</td><td class="r">−' + fmt(res.promoDiscount) + '</td></tr>' : '') +
      (res.threshold ? '<tr><td>滿額折抵</td><td class="r">−' + fmt(res.threshold.amount) + '</td></tr>' : '') + '</table>' +
      '<div class="total">' + fmt(res.total) + '</div>' +
      (res.savings > 0.005 ? '<div class="sub">本次省下約 ' + fmt(res.savings) + '</div>' : '') +
      (missing ? '<div class="banner warn">有 ' + missing + ' 項尚未輸入價格</div>' : '') +
      '<label>付款方式</label><select id="payMethod">' + PAYS.map(p => '<option>' + esc(p) + '</option>').join('') + '</select>' +
      '<label class="check"><input type="checkbox" id="recPrice" checked> 把這次輸入的新價格記入價格紀錄</label>' +
      '<div class="btns"><button class="primary" data-act="checkout">結帳完成</button><button class="danger" data-act="cartClear">清空</button></div></div>';
    return h;
  }
  async function addToCart(itemId) {
    const c = cart();
    const found = c.lines.find(l => l.itemId === itemId);
    if (found) found.qty = Number(found.qty) + 1;
    else {
      const p = c.storeId ? latestPrice(itemId, c.storeId) : null;
      c.lines.push({ itemId, qty: 1, price: p ? p.price : null, manual: false });
    }
    await setSetting('cart', c);
    const n = c.lines.find(l => l.itemId === itemId).qty;
    toast('已加入購物車（這個商品共 ' + n + ' 件）');
    render();
  }
  async function checkout() {
    const { c, all, res } = cartCompute();
    const store = cartStore();
    if (!store) { toast('請先選擇結帳賣場'); return; }
    if (c.lines.some(l => l.price === null || l.price === undefined || l.price === '' || !(Number(l.price) >= 0))) { toast('還有商品沒有輸入價格'); return; }
    const mode = roundingMode();
    const now = new Date(), date = Core.todayStr(now);
    const label = id => { const r = all.find(x => x.id === id); return r ? ruleLabel(r) : '特價'; };
    const rec = {
      id: Core.uid(), date, time: now.toISOString(), storeId: store.id, storeName: store.name,
      payMethod: $('#payMethod').value, rounding: mode, total: res.total, qtyCount: res.qtyCount,
      rawTotal: res.rawSum, savings: res.savings, place: store.id === OTHER_ID ? (c.place || '') : '',
      threshold: res.threshold ? { label: label(res.threshold.ruleId), amount: res.threshold.amount } : null,
      lines: c.lines.map((l, i) => {
        const it = itemById(l.itemId) || {};
        const L = res.lines[i];
        return {
          itemId: l.itemId, name: it.name || '', qty: Number(l.qty), price: Number(l.price), sub: L.sub,
          disc: Math.max(0, L.raw - L.net), promos: L.promos.map(p => label(p.ruleId))
        };
      })
    };
    await save('records', rec);
    if ($('#recPrice').checked) {
      for (const l of c.lines) {
        const last = latestPrice(l.itemId, store.id);
        if (!last || Number(last.price) !== Number(l.price)) {
          await save('prices', { id: Core.uid(), itemId: l.itemId, storeId: store.id, price: Number(l.price), date, onSale: false, note: '購物車結帳', createdAt: Date.now(), ...(store.id === OTHER_ID && c.place ? { place: c.place } : {}) });
        }
      }
    }
    await setSetting('cart', { storeId: store.id, lines: [], disabled: [] });
    toast('已儲存購物紀錄');
    go('#/record/' + rec.id);
  }

  /* ---------- 購物紀錄 ---------- */
  function viewRecords() {
    const list = S.records.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
    let h = '<h1>購物紀錄</h1>';
    if (!list.length) return h + '<div class="card sub">還沒有購物紀錄。</div>';
    list.forEach(r => {
      h += '<a class="row" href="#/record/' + esc(r.id) + '"><div class="grow"><b>' + esc(r.date) + ' · ' + esc(recStore(r)) +
        '</b><div class="sub">' + (r.lines || []).length + ' 項 · ' + esc(r.payMethod || '') + '</div></div><div class="right"><b>' + fmt(r.total) + '</b></div></a>';
    });
    return h;
  }
  function viewRecord(id) {
    const r = S.records.find(x => x.id === id);
    if (!r) return '<div class="card">找不到這筆紀錄。<div class="btns"><a class="btn" href="#/records">回紀錄</a></div></div>';
    let h = '<h1>' + esc(r.date) + ' · ' + esc(recStore(r)) + '</h1><div class="card">' +
      '<table class="tbl"><tr><th>商品</th><th class="r">數量</th><th class="r">單價</th><th class="r">小計</th></tr>';
    (r.lines || []).forEach(l => {
      const exists = itemById(l.itemId);
      h += '<tr><td>' + (exists ? '<a href="#/item/' + esc(l.itemId) + '">' + esc(l.name) + '</a>' : esc(l.name)) +
        (l.disc > 0.005 ? '<div class="sub">🏷 ' + esc((l.promos || []).join('、') || '特價') + ' −' + fmt(l.disc) + '</div>' : '') +
        '</td><td class="r">' + esc(l.qty) + '</td><td class="r">' + fmt(l.price) + '</td><td class="r">' + fmt(l.sub) + '</td></tr>';
    });
    h += '</table>';
    if (r.savings > 0.005 || r.threshold) {
      h += '<table class="tbl" style="margin-top:6px"><tr><td>原價合計</td><td class="r">' + fmt(r.rawTotal) + '</td></tr>' +
        (r.threshold ? '<tr><td>滿額折抵（' + esc(r.threshold.label) + '）</td><td class="r">−' + fmt(r.threshold.amount) + '</td></tr>' : '') + '</table>';
    }
    h += '<div class="total" style="margin-top:8px">' + fmt(r.total) + '</div>' +
      (r.savings > 0.005 ? '<div class="sub">本次省下約 ' + fmt(r.savings) + '</div>' : '') +
      '<div class="sub">' + esc(r.payMethod || '') + ' · ' + esc(Core.ROUNDING_MODES[r.rounding] || '') + ' · 紀錄編號 ' + esc(r.id) + '</div></div>' +
      '<div class="btns"><button data-act="copyLink" data-id="' + esc(r.id) + '">複製這筆明細的連結</button>' +
      (readOnly() ? '' : '<button class="danger" data-act="delRecord" data-id="' + esc(r.id) + '">刪除紀錄</button>') + '</div>' +
      '<div class="hint">連結可貼到個人記事本，之後點開就能回到這筆明細。</div>';
    return h;
  }

  /* ---------- 特價 ---------- */
  let promoView = 'store', promoQuery = '';
  const STATUS_TEXT = { active: '進行中', upcoming: '未開始', expired: '已過期' };
  const STATUS_ORDER = { active: 0, upcoming: 1, expired: 2 };
  const RULE_TYPE_ORDER = ['bundle', 'buyget', 'nth', 'unitoff', 'threshold'];
  function ruleDesc(r) { return ruleLabel(r); }
  function periodText(c) { return (c.start || '不限') + ' ~ ' + (c.end || '不限'); }
  function statusChip(st) { return '<span class="chip' + (st === 'active' ? '' : ' warn') + '">' + STATUS_TEXT[st] + '</span>'; }
  function ruleItems(rid) { return S.promoItems.filter(x => x.ruleId === rid).map(x => itemById(x.itemId)).filter(Boolean); }
  function itemNamesText(list) {
    if (!list.length) return '';
    const names = list.slice(0, 3).map(i => i.name).join('、');
    return names + (list.length > 3 ? ' 等 ' + list.length + ' 項' : '');
  }

  function viewPromos() {
    const ro = readOnly(), today = Core.todayStr();
    const st = c => Core.campaignStatus(c, today);
    let h = '<h1>特價</h1><div class="btns">' +
      '<button class="' + (promoView === 'store' ? 'primary' : '') + '" data-act="promoView" data-v="store">依賣場檔期</button>' +
      '<button class="' + (promoView === 'item' ? 'primary' : '') + '" data-act="promoView" data-v="item">依商品</button></div>';
    if (!ro) h += '<div class="btns"><a class="btn" href="#/campaign/new">＋ 新增檔期</a><a class="btn" href="#/rule/new">＋ 新增特價規則</a></div>';

    if (promoView === 'store') {
      const camps = S.promoCampaigns.slice().sort((a, b) =>
        STATUS_ORDER[st(a)] - STATUS_ORDER[st(b)] || storeName(a.storeId).localeCompare(storeName(b.storeId)) || (b.start || '').localeCompare(a.start || ''));
      if (!camps.length) return h + '<div class="card sub">還沒有特價檔期。先「新增檔期」（例如：全聯 11 月第二週），再加入規則與適用商品。</div>';
      camps.forEach(c => {
        const rules = S.promoRules.filter(r => r.campaignId === c.id);
        h += '<div class="card"><div class="row" style="border:0;padding:0;margin:0"><div class="grow"><b>' + esc(c.name) + '</b>' + statusChip(st(c)) +
          '<div class="sub">' + esc(storeName(c.storeId)) + ' · ' + esc(periodText(c)) + '</div>' + (c.note ? '<div class="sub">' + esc(c.note) + '</div>' : '') + '</div>' +
          (ro ? '' : '<a class="btn small" href="#/campaign/' + esc(c.id) + '">編輯檔期</a>') + '</div>';
        if (!rules.length) h += '<div class="sub" style="margin-top:8px">尚無規則。</div>';
        rules.forEach(r => {
          const items = ruleItems(r.id);
          h += '<div class="row" style="margin:8px 0 0"><div class="grow"><b>' + esc(ruleDesc(r)) + '</b><div class="sub">' +
            (r.type === 'threshold' ? '整張購物車' : esc(itemNamesText(items)) || '（沒有適用商品）') + '</div></div>' +
            (ro ? '' : '<a class="btn small" href="#/rule/' + esc(r.id) + '">編輯</a>') + '</div>';
        });
        if (!ro) h += '<div class="btns"><a class="btn small" href="#/rule/new?campaign=' + esc(c.id) + '">＋ 新增規則</a></div>';
        h += '</div>';
      });
      return h;
    }

    // 依商品
    h += '<input id="promoSearch" type="search" placeholder="搜尋有特價的商品" value="' + esc(promoQuery) + '" autocomplete="off">';
    const q = promoQuery.trim().toLowerCase();
    const rows = [];
    S.items.forEach(it => {
      if (q && !String(it.name + ' ' + (it.brand || '')).toLowerCase().includes(q)) return;
      const rs = S.promoRules.filter(r => S.promoItems.some(x => x.ruleId === r.id && x.itemId === it.id))
        .map(r => ({ r, c: S.promoCampaigns.find(c => c.id === r.campaignId) })).filter(x => x.c);
      if (rs.length) rows.push({ it, rs });
    });
    if (!rows.length) return h + '<div class="card sub" style="margin-top:10px">沒有符合的商品特價。</div>';
    rows.sort((a, b) => a.it.name.localeCompare(b.it.name));
    rows.forEach(x => {
      h += '<div class="card"><a href="#/item/' + esc(x.it.id) + '"><b>' + esc(x.it.name) + '</b></a><span class="sub"> ' + esc(specText(x.it)) + '</span>';
      x.rs.sort((a, b) => STATUS_ORDER[st(a.c)] - STATUS_ORDER[st(b.c)]).forEach(y => {
        h += '<div class="row" style="margin:8px 0 0"><div class="grow"><b>' + esc(ruleDesc(y.r)) + '</b>' + statusChip(st(y.c)) +
          '<div class="sub">' + esc(storeName(y.c.storeId)) + ' · ' + esc(y.c.name) + ' · ' + esc(periodText(y.c)) + '</div></div>' +
          (ro ? '' : '<a class="btn small" href="#/rule/' + esc(y.r.id) + '">編輯</a>') + '</div>';
      });
      h += '</div>';
    });
    return h;
  }

  /* 規則參數欄位 */
  function numField(name, label, val, min, step) {
    const v = (val === undefined || val === null || (typeof val === 'number' && isNaN(val))) ? '' : val;
    return '<div><label>' + label + '</label><input name="' + name + '" type="number" inputmode="decimal" step="' + (step || 'any') + '"' +
      (min !== undefined ? ' min="' + min + '"' : '') + ' value="' + esc(v) + '"></div>';
  }
  function paramFieldsHtml(type, p) {
    p = p || {};
    if (type === 'buyget') return '<div class="grid2">' + numField('buyget_n', '買 N 件', p.n || 1, 1, 1) + numField('buyget_m', '送 M 件', p.m || 1, 1, 1) + '</div>';
    if (type === 'nth') return '<div class="grid2">' + numField('nth_n', '第幾件', p.n || 2, 2, 1) + numField('nth_zhe', '折數（5＝5折、85＝85折）', p.zhe, 0) + '</div>';
    if (type === 'bundle') return '<div class="grid2">' + numField('bundle_n', '件數', p.n || 2, 2, 1) + numField('bundle_total', '組合價（元）', p.total, 0) + '</div>';
    if (type === 'unitoff') return '<div class="grid2"><div><label>折扣方式</label><select name="unitoff_mode"><option value="amount"' + (p.mode !== 'zhe' ? ' selected' : '') +
      '>每件折 $</option><option value="zhe"' + (p.mode === 'zhe' ? ' selected' : '') + '>每件打折</option></select></div>' + numField('unitoff_value', '折扣值（折 $ 或折數）', p.value, 0) + '</div>';
    if (type === 'threshold') return '<div class="grid2">' + numField('threshold_threshold', '滿額門檻（元）', p.threshold, 0) + numField('threshold_amount', '折抵金額（元）', p.amount, 0) +
      '</div><label class="check"><input type="checkbox" name="threshold_repeat"' + (p.repeat ? ' checked' : '') + '> 每滿門檻就累計折抵</label>';
    return '';
  }
  function readParams(type, fd) {
    const g = k => fd.get(type + '_' + k);
    const num = v => (v === null || String(v).trim() === '' ? NaN : Number(v));
    if (type === 'buyget') return { n: num(g('n')), m: num(g('m')) };
    if (type === 'nth') return { n: num(g('n')), zhe: num(g('zhe')) };
    if (type === 'bundle') return { n: num(g('n')), total: num(g('total')) };
    if (type === 'unitoff') return { mode: g('mode') === 'zhe' ? 'zhe' : 'amount', value: num(g('value')) };
    if (type === 'threshold') return { threshold: num(g('threshold')), amount: num(g('amount')), repeat: !!g('repeat') };
    return {};
  }
  function validateParams(type, p) {
    const int = x => Number.isInteger(x);
    if (type === 'buyget') return int(p.n) && p.n >= 1 && int(p.m) && p.m >= 1 ? '' : '買 N 送 M 的數量要是 1 以上的整數';
    if (type === 'nth') return int(p.n) && p.n >= 2 && Number.isFinite(p.zhe) && p.zhe >= 0 ? '' : '第 N 件要 2 以上，且要填折數';
    if (type === 'bundle') return int(p.n) && p.n >= 2 && Number.isFinite(p.total) && p.total >= 0 ? '' : '件數要 2 以上，且要填組合價';
    if (type === 'unitoff') return Number.isFinite(p.value) && p.value > 0 ? '' : '請填折扣值';
    if (type === 'threshold') return p.threshold > 0 && p.amount > 0 ? '' : '請填滿額門檻與折抵金額';
    return '請選擇特價型態';
  }

  function viewRule(id, params) {
    if (readOnly()) return '<div class="card">目前是唯讀模式，無法編輯。</div>';
    const isNew = id === 'new';
    const r = isNew ? { type: 'bundle', params: {}, limit: '' } : S.promoRules.find(x => x.id === id);
    if (!r) return '<div class="card">找不到這條規則。<div class="btns"><a class="btn" href="#/promos">回特價</a></div></div>';
    const preItem = isNew ? params.get('item') : '';
    const preItemObj = preItem ? itemById(preItem) : null;
    const selected = new Set(isNew ? (preItem ? [preItem] : []) : S.promoItems.filter(x => x.ruleId === r.id).map(x => x.itemId));
    const campId = isNew ? (params.get('campaign') || '') : r.campaignId;
    const camps = S.promoCampaigns.slice().sort((a, b) => (b.start || '').localeCompare(a.start || ''));
    const useNew = !campId;
    const lastStore = S.settings.lastStore || (S.stores[0] && S.stores[0].id) || '';
    const today = Core.todayStr();
    const ret = isNew && preItem ? '#/item/' + preItem : '#/promos';
    const grouped = !['unitoff', 'threshold'].includes(r.type);

    let h = '<h1>' + (isNew ? '新增特價規則' : '編輯特價規則') + '</h1><form class="card" data-form="rule" data-id="' + esc(isNew ? '' : r.id) + '">' +
      '<input type="hidden" name="ret" value="' + esc(ret) + '">' +
      '<label>所屬檔期</label><select name="campaignId" data-campsel>' +
      camps.map(c => '<option value="' + esc(c.id) + '"' + (c.id === campId ? ' selected' : '') + '>' + esc(storeName(c.storeId) + ' · ' + c.name + '（' + periodText(c) + '）') + '</option>').join('') +
      '<option value="__new"' + (useNew ? ' selected' : '') + '>＋ 新增檔期…</option></select>' +
      '<div data-newcamp' + (useNew ? '' : ' hidden') + ' class="subcard"><div class="grid2"><div><label>賣場</label><select name="c_store">' +
      S.stores.map(s => '<option value="' + esc(s.id) + '"' + (s.id === lastStore ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select></div>' +
      '<div><label>檔期名稱</label><input name="c_name" value="' + esc(preItemObj ? preItemObj.name + ' 特價' : '') + '" placeholder="例如：11 月第二週"></div></div>' +
      '<div class="grid2"><div><label>開始日</label><input name="c_start" type="date" value="' + today + '"></div><div><label>結束日（選填）</label><input name="c_end" type="date"></div></div></div>' +
      '<label>特價型態</label><select name="type" data-typesel>' +
      RULE_TYPE_ORDER.map(t => '<option value="' + t + '"' + (t === r.type ? ' selected' : '') + '>' + esc(Core.PROMO_TYPES[t]) + '</option>').join('') + '</select>' +
      RULE_TYPE_ORDER.map(t => '<div data-ptype="' + t + '"' + (t === r.type ? '' : ' hidden') + '>' + paramFieldsHtml(t, t === r.type ? r.params : {}) + '</div>').join('') +
      '<div data-limitwrap' + (grouped ? '' : ' hidden') + '><label>每單最多套用幾組（選填）</label><input name="limit" type="number" inputmode="numeric" min="1" step="1" value="' + esc(r.limit || '') + '"></div>' +
      '<div data-itempick' + (r.type === 'threshold' ? ' hidden' : '') + '><label>適用商品（可多選；混搭時用平均單價計算）</label>' +
      '<input type="search" data-filter="itemPick" placeholder="篩選商品名稱" autocomplete="off"><div class="pick">' +
      (S.items.length ? S.items.slice().sort((a, b) => a.name.localeCompare(b.name)).map(i =>
        '<label class="check" data-name="' + esc((i.name + ' ' + (i.brand || '') + ' ' + (i.barcode || '')).toLowerCase()) + '"><input type="checkbox" name="item" value="' + esc(i.id) + '"' +
        (selected.has(i.id) ? ' checked' : '') + '> <span>' + esc(i.name) + '<span class="sub"> ' + esc(specText(i)) + '</span></span></label>').join('') :
        '<div class="sub">商品庫還沒有商品。</div>') + '</div></div>' +
      '<div class="btns"><button class="primary">儲存</button><a class="btn" href="' + esc(isNew ? ret : '#/promos') + '">取消</a>' +
      (isNew ? '' : '<button type="button" class="danger" data-act="delRule" data-id="' + esc(r.id) + '">刪除規則</button>') + '</div></form>';
    return h;
  }

  function viewCampaign(id) {
    if (readOnly()) return '<div class="card">目前是唯讀模式，無法編輯。</div>';
    const isNew = id === 'new';
    const c = isNew ? { storeId: S.settings.lastStore || (S.stores[0] && S.stores[0].id) || '', start: Core.todayStr(), end: '', name: '', note: '' } : S.promoCampaigns.find(x => x.id === id);
    if (!c) return '<div class="card">找不到這個檔期。<div class="btns"><a class="btn" href="#/promos">回特價</a></div></div>';
    return '<h1>' + (isNew ? '新增檔期' : '編輯檔期') + '</h1><form class="card" data-form="campaign" data-id="' + esc(isNew ? '' : c.id) + '">' +
      '<label>賣場</label><select name="storeId">' + S.stores.map(s => '<option value="' + esc(s.id) + '"' + (s.id === c.storeId ? ' selected' : '') + '>' + esc(s.name) + '</option>').join('') + '</select>' +
      '<label>檔期名稱 *</label><input name="name" required value="' + esc(c.name) + '" placeholder="例如：全聯 11 月第二週">' +
      '<div class="grid2"><div><label>開始日</label><input name="start" type="date" value="' + esc(c.start) + '"></div><div><label>結束日（選填）</label><input name="end" type="date" value="' + esc(c.end) + '"></div></div>' +
      '<label>備註</label><input name="note" value="' + esc(c.note) + '">' +
      '<div class="hint">過了結束日，這個檔期的規則會自動停用（購物車不再套用）。</div>' +
      '<div class="btns"><button class="primary">' + (isNew ? '儲存並新增規則' : '儲存') + '</button><a class="btn" href="#/promos">取消</a>' +
      (isNew ? '' : '<button type="button" class="danger" data-act="delCampaign" data-id="' + esc(c.id) + '">刪除檔期</button>') + '</div></form>';
  }

  // 價格紀錄上「買 N 件較便宜」同時建立特價規則（避免重複建立）
  async function createDealRule(it, storeId, deal, date, endDate) {
    const params = Object.assign({}, deal); delete params.kind;
    const dup = S.promoRules.find(r => r.type === deal.kind && JSON.stringify(r.params) === JSON.stringify(params) &&
      S.promoItems.some(x => x.ruleId === r.id && x.itemId === it.id) &&
      S.promoCampaigns.some(c => c.id === r.campaignId && c.storeId === storeId && Core.campaignStatus(c, Core.todayStr()) !== 'expired'));
    if (dup) return false;
    const camp = { id: Core.uid(), storeId, name: it.name + ' ' + Core.describePromo(deal.kind, params), start: date, end: endDate || '', note: '由價格紀錄建立' };
    const rule = { id: Core.uid(), campaignId: camp.id, type: deal.kind, params, limit: '' };
    await save('promoCampaigns', camp);
    await save('promoRules', rule);
    await save('promoItems', { id: rule.id + '|' + it.id, ruleId: rule.id, itemId: it.id });
    return true;
  }

  /* ---------- 設定 ---------- */
  function viewSettings() {
    const ro = readOnly();
    let h = '<h1>設定</h1>';
    h += '<h2>外觀與模式</h2><div class="card"><label>主題</label><select id="theme">' +
      [['auto', '跟隨系統'], ['light', '淺色'], ['dark', '深色']].map(o => '<option value="' + o[0] + '"' + ((S.settings.theme || 'auto') === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>' +
      '<div class="btns"><button class="small" data-act="resetOrder">還原商品頁區塊預設順序</button></div>' +
      '<label class="check"><input type="checkbox" id="readOnly"' + (ro ? ' checked' : '') + '> 唯讀模式（桌機查帳用，停用新增、修改、購物車）</label></div>';

    h += '<h2>備份與還原</h2><div class="card">' +
      '<div class="sub">上次匯出：' + (S.settings.lastExport ? esc(new Date(S.settings.lastExport).toLocaleString('zh-TW')) : '尚未匯出') + '</div>' +
      '<div class="btns"><button class="primary" data-act="export" data-photos="0">匯出（不含照片）</button>' +
      '<button data-act="export" data-photos="1">匯出（含照片）</button></div>' +
      '<div class="hint">備份檔可用 LINE 或 Email 傳給自己；經這些服務傳送時，檔案會經過該服務。</div>' +
      '<label>匯入備份檔</label><input id="importFile" type="file" accept=".json,application/json">' +
      '<label>匯入方式</label><select id="importMode"><option value="merge">合併（以條碼與編號去重）</option><option value="replace">取代（清除目前資料）</option></select>' +
      '<div class="hint">匯入前會先自動下載一份目前資料的備份。</div>' +
      '<label>備份提醒（天數）</label><input id="backupDays" type="number" min="1" step="1" value="' + esc(S.settings.backupDays || 14) + '"></div>';

    h += '<h2>賣場</h2>';
    S.stores.forEach(s => {
      h += '<form class="card" data-form="store" data-id="' + esc(s.id) + '"><label>名稱</label><input name="name" required value="' + esc(s.name) + '">' +
        '<div class="grid2"><div><label>類型</label><select name="kind"><option value="physical"' + (s.kind === 'physical' ? ' selected' : '') + '>實體</option><option value="online"' + (s.kind === 'online' ? ' selected' : '') + '>網路</option></select></div>' +
        '<div><label>進位模式</label><select name="rounding">' +
        Object.keys(Core.ROUNDING_MODES).map(k => '<option value="' + k + '"' + ((s.rounding || 'line-round') === k ? ' selected' : '') + '>' + esc(Core.ROUNDING_MODES[k]) + '</option>').join('') + '</select></div></div>' +
        '<label>搜尋網址範本（用 {q} 代入商品名稱）</label><input name="template" value="' + esc(s.template) + '">' +
        '<div class="btns"><button class="primary">儲存</button><button type="button" class="danger" data-act="delStore" data-id="' + esc(s.id) + '">刪除</button></div></form>';
    });
    h += '<form class="card" data-form="store" data-id=""><b>新增賣場</b><label>名稱</label><input name="name" required>' +
      '<div class="grid2"><div><label>類型</label><select name="kind"><option value="physical">實體</option><option value="online">網路</option></select></div>' +
      '<div><label>進位模式</label><select name="rounding">' +
      Object.keys(Core.ROUNDING_MODES).map(k => '<option value="' + k + '">' + esc(Core.ROUNDING_MODES[k]) + '</option>').join('') + '</select></div></div>' +
      '<label>搜尋網址範本</label><input name="template" placeholder="https://…?q={q}"><div class="btns"><button class="primary">新增</button></div></form>';

    h += '<h2>分類與 BigGo</h2><form class="card" data-form="misc"><label>商品分類（一行一個）</label><textarea name="cats">' +
      esc((S.settings.categories || []).join('\n')) + '</textarea><label>BigGo 搜尋網址範本</label><input name="bigGo" value="' + esc(S.settings.bigGoTemplate || '') + '">' +
      '<div class="btns"><button class="primary">儲存</button></div></form>';

    h += '<h2>關於</h2><div class="card"><div>版本 ' + VERSION + '</div><div class="sub">資料版本 ' + Core.DATA_VERSION + ' · 商品 ' + S.items.length + ' 筆 · 價格 ' + S.prices.length + ' 筆</div>' +
      '<div class="hint">各賣場的搜尋網址範本是預設值，請在手機實測，網站改版時在這裡修改即可。</div>' +
      '<table class="tbl" style="margin-top:8px">' + CHANGELOG.map(c => '<tr><td>' + esc(c[0]) + '</td><td>' + esc(c[1]) + '</td><td>' + esc(c[2]) + '</td></tr>').join('') + '</table></div>';
    return h;
  }

  /* ---------- 匯出入 ---------- */
  function download(name, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return blob.size;
  }
  function currentDump(photos) {
    const settings = {};
    SETTING_KEYS.forEach(k => { if (S.settings[k] !== undefined) settings[k] = S.settings[k]; });
    const db = { settings };
    TABLES.forEach(t => { db[t] = S[t]; });
    return Core.buildExport(db, { photos });
  }
  async function doExport(photos) {
    const text = JSON.stringify(currentDump(photos));
    const size = download('shopping_' + Core.stamp() + '.json', text);
    await setSetting('lastExport', Date.now());
    toast('已匯出（' + (size / 1024 < 1024 ? Math.round(size / 1024) + ' KB' : (size / 1048576).toFixed(1) + ' MB') + '）');
    render();
  }
  async function doImport(file, mode) {
    let data;
    try { data = Core.migrate(JSON.parse(await file.text())); }
    catch (e) { toast('匯入失敗：' + e.message); return; }
    if (mode === 'replace' && !confirm('取代會清除目前所有資料，確定嗎？')) return;
    download('shopping_before_import_' + Core.stamp() + '.json', JSON.stringify(currentDump(true)));
    if (mode === 'replace') {
      for (const t of TABLES) {
        await idbClear(t);
        S[t] = [];
        for (const row of data[t]) await save(t, row);
      }
      for (const k of SETTING_KEYS) if (data.settings[k] !== undefined) await setSetting(k, data.settings[k]);
      await setSetting('cart', { storeId: '', lines: [], disabled: [] });
      toast('已取代為備份內容');
    } else {
      const cur = {}; TABLES.forEach(t => { cur[t] = S[t]; });
      const { data: merged, stat } = Core.mergeData(cur, data);
      for (const t of TABLES) for (const row of merged[t]) if (!S[t].some(x => x === row)) await save(t, row);
      toast('合併完成：新增 ' + stat.added + ' 筆，略過 ' + stat.skipped + ' 筆重複');
    }
    applyTheme();
    render();
  }

  /* ---------- 掃碼 ---------- */
  let scanStream = null, scanTimer = null;
  async function startScan() {
    if (!('BarcodeDetector' in window)) { toast('這個瀏覽器不支援相機掃碼，請手動輸入條碼'); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('無法使用相機（需要 HTTPS 網址）'); return; }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    } catch (e) { toast('無法開啟相機，請確認已允許相機權限'); return; }
    const v = $('#scanVideo'); v.srcObject = scanStream; await v.play().catch(() => {});
    $('#scan').classList.add('on');
    let formats = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'qr_code'];
    try { const sup = await BarcodeDetector.getSupportedFormats(); formats = formats.filter(f => sup.includes(f)); } catch (e) { /* 使用預設 */ }
    const det = new BarcodeDetector({ formats });
    let busy = false;
    scanTimer = setInterval(async () => {
      if (busy) return; busy = true;
      try {
        const codes = await det.detect(v);
        if (codes.length && codes[0].rawValue) { const code = codes[0].rawValue; stopScan(); if (navigator.vibrate) navigator.vibrate(60); handleCode(code); }
      } catch (e) { /* 單次失敗忽略 */ }
      busy = false;
    }, 250);
  }
  function stopScan() {
    clearInterval(scanTimer); scanTimer = null;
    if (scanStream) { scanStream.getTracks().forEach(t => t.stop()); scanStream = null; }
    $('#scan').classList.remove('on');
  }
  function handleCode(code) {
    code = String(code).trim();
    if (!code) return;
    const it = S.items.find(i => i.barcode === code);
    if (it) go('#/item/' + it.id);
    else { toast('資料庫沒有這個條碼，請新增商品'); go('#/edit/new?barcode=' + encodeURIComponent(code)); }
  }

  /* ---------- 主題 ---------- */
  function applyTheme() {
    const t = S.settings.theme || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', async e => {
    if (e.target.id === 'sheet') { closeSheet(); return; }
    if (e.target.closest('[data-fabsearch]')) { if (fabLong) { fabLong = false; return; } openSearch(defaultSearchStore()); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    try {
      if (act === 'scan') startScan();
      else if (act === 'addCart') await addToCart(id);
      else if (act === 'delItem') {
        if (confirm('刪除這個商品與它的價格紀錄？')) {
          await remove('items', id);
          for (const p of S.prices.filter(x => x.itemId === id)) await remove('prices', p.id);
          for (const p of S.refPrices.filter(x => x.itemId === id)) await remove('refPrices', p.id);
          for (const p of S.storeLinks.filter(x => x.itemId === id)) await remove('storeLinks', p.id);
          for (const p of S.promoItems.filter(x => x.itemId === id)) await remove('promoItems', p.id);
          const c = cart(); c.lines = c.lines.filter(l => l.itemId !== id); await setSetting('cart', c);
          toast('已刪除'); go('#/');
        }
      }
      else if (act === 'delPrice') { if (confirm('刪除這筆價格？')) { await remove('prices', id); render(); } }
      else if (act === 'delRef') { await remove('refPrices', id); render(); }
      else if (act === 'bind') {
        const sid = el.dataset.store, lid = id + '|' + sid;
        const cur = S.storeLinks.find(x => x.id === lid);
        const url = prompt('貼上 ' + storeName(sid) + ' 的商品頁網址（留空可解除綁定）', cur ? cur.url : '');
        if (url === null) return;
        if (!url.trim()) { if (cur) await remove('storeLinks', lid); }
        else if (!Core.isHttpUrl(url.trim())) { toast('網址必須以 http 或 https 開頭'); return; }
        else await save('storeLinks', { id: lid, itemId: id, storeId: sid, url: url.trim() });
        render();
      }
      else if (act === 'cartQty') {
        const c = cart(), l = c.lines[Number(el.dataset.i)];
        l.qty = Math.max(1, Number(l.qty) + Number(el.dataset.d));
        await setSetting('cart', c); render();
      }
      else if (act === 'cartDel') { const c = cart(); c.lines.splice(Number(el.dataset.i), 1); await setSetting('cart', c); render(); }
      else if (act === 'cartClear') { if (confirm('清空購物車？')) { const c = cart(); c.lines = []; await setSetting('cart', c); render(); } }
      else if (act === 'checkout') await checkout();
      else if (act === 'copyLink') {
        const link = location.origin + location.pathname + '#/record/' + id;
        try { await navigator.clipboard.writeText(link); toast('已複製連結'); } catch (err) { prompt('複製這個連結', link); }
      }
      else if (act === 'delRecord') { if (confirm('刪除這筆購物紀錄？')) { await remove('records', id); go('#/records'); } }
      else if (act === 'openSearch') { openSearch(storeById(el.dataset.store)); closeSheet(); }
      else if (act === 'closeSheet') closeSheet();
      else if (act === 'cat') { homeCat = el.dataset.v || ''; render(); }
      else if (act === 'stepItem') stepItem(Number(el.dataset.d));
      else if (act === 'reorder') { reorderMode = !reorderMode; render(); }
      else if (act === 'secMove') {
        const order = sectionOrder(), k = el.dataset.k, i = order.indexOf(k), j = i + Number(el.dataset.d);
        if (i >= 0 && j >= 0 && j < order.length) {
          order.splice(i, 1); order.splice(j, 0, k);
          await setSetting('itemOrder', order); render();
        }
      }
      else if (act === 'resetOrder') { await setSetting('itemOrder', DEFAULT_ORDER.slice()); toast('已還原商品頁區塊順序'); render(); }
      else if (act === 'histEdit') { historyEdit = !historyEdit; historySel.clear(); render(); }
      else if (act === 'histAll') {
        const ids = pricesOf(route().parts[1]).sort(byDateDesc).slice(0, 100).map(p => p.id);
        if (ids.every(x => historySel.has(x))) historySel.clear(); else ids.forEach(x => historySel.add(x));
        render();
      }
      else if (act === 'histDel') {
        if (historySel.size && confirm('刪除所選的 ' + historySel.size + ' 筆價格紀錄？')) {
          for (const pid of Array.from(historySel)) await remove('prices', pid);
          historySel.clear(); historyEdit = false; toast('已刪除'); render();
        }
      }
      else if (act === 'promoView') { promoView = el.dataset.v; render(); }
      else if (act === 'delRule') {
        if (confirm('刪除這條特價規則？')) {
          await remove('promoRules', id);
          for (const x of S.promoItems.filter(x => x.ruleId === id)) await remove('promoItems', x.id);
          toast('已刪除'); go('#/promos');
        }
      }
      else if (act === 'delCampaign') {
        if (confirm('刪除這個檔期與底下所有規則？')) {
          for (const r of S.promoRules.filter(r => r.campaignId === id)) {
            for (const x of S.promoItems.filter(x => x.ruleId === r.id)) await remove('promoItems', x.id);
            await remove('promoRules', r.id);
          }
          await remove('promoCampaigns', id);
          toast('已刪除'); go('#/promos');
        }
      }
      else if (act === 'export') await doExport(el.dataset.photos === '1');
      else if (act === 'delStore') {
        const used = S.prices.some(p => p.storeId === id) || S.records.some(r => r.storeId === id);
        if (confirm(used ? '這個賣場已有價格或購物紀錄，刪除後紀錄會顯示為「已刪除賣場」。確定刪除？' : '刪除這個賣場？')) { await remove('stores', id); render(); }
      }
    } catch (err) { console.error(err); toast('發生錯誤：' + err.message); }
  });

  document.addEventListener('submit', async e => {
    const f = e.target.closest('form[data-form]');
    if (!f) return;
    e.preventDefault();
    const kind = f.dataset.form, id = f.dataset.id, fd = new FormData(f);
    try {
      if (kind === 'barcode') { handleCode(fd.get('code')); }
      else if (kind === 'price') {
        const dk = fd.get('dealKind');
        let deal = null;
        if (dk) {
          const params = readParams(dk, fd);
          const err = validateParams(dk, params);
          if (err) { toast(err); return; }
          deal = Object.assign({ kind: dk }, params);
        }
        const blank = String(fd.get('price') || '').trim() === '';
        // 「N 件 $X」不一定知道單件價，單件價可留空，以組合價 ÷ 件數當每件價
        if (blank && !(deal && dk === 'bundle')) { toast('請輸入單件價格（選「N 件 $X」時可留空）'); return; }
        if (!blank && !(Number(fd.get('price')) >= 0)) { toast('請輸入正確的價格'); return; }
        const price = blank ? deal.total / deal.n : Number(fd.get('price'));
        const rec = { id: Core.uid(), itemId: id, storeId: fd.get('storeId'), price, date: fd.get('date'), onSale: !!fd.get('onSale') || !!deal, note: String(fd.get('note') || '').trim(), createdAt: Date.now() };
        if (deal) rec.deal = deal;
        if (blank) rec.noSingle = true;
        const place = String(fd.get('place') || '').trim();
        if (rec.storeId === OTHER_ID && place) rec.place = place;
        await save('prices', rec);
        await setSetting('lastStore', fd.get('storeId'));
        const it = itemById(id); if (it) { it.updatedAt = Date.now(); await save('items', it); }
        let extra = '';
        if (deal && fd.get('syncRule') && it) {
          const made = await createDealRule(it, rec.storeId, deal, rec.date, fd.get('dealEnd') || '');
          extra = made ? '，並建立特價規則' : '（已有相同的特價規則）';
        }
        toast('已記錄價格' + extra); render();
      }
      else if (kind === 'ref') {
        const price = Number(fd.get('price'));
        if (!(price >= 0)) { toast('請輸入價格'); return; }
        await save('refPrices', { id: Core.uid(), itemId: id, source: 'BigGo', price, date: fd.get('date'), note: String(fd.get('note') || '').trim() });
        toast('已記下參考價'); render();
      }
      else if (kind === 'item') {
        const barcode = String(fd.get('barcode') || '').trim();
        const name = String(fd.get('name') || '').trim();
        if (!name) { toast('請輸入名稱'); return; }
        if (barcode && S.items.some(i => i.barcode === barcode && i.id !== id)) { toast('這個條碼已經有商品了'); return; }
        const old = id ? itemById(id) : null;
        const it = Object.assign({}, old || { id: Core.uid(), createdAt: Date.now() }, {
          barcode, name, brand: String(fd.get('brand') || '').trim(), category: fd.get('category') || '',
          size: fd.get('size') === '' ? '' : Number(fd.get('size')), unit: fd.get('unit'),
          packQty: Math.max(1, Number(fd.get('packQty')) || 1), note: String(fd.get('note') || '').trim(), updatedAt: Date.now()
        });
        if (pendingPhoto) it.photo = pendingPhoto; else if (fd.get('rmPhoto')) delete it.photo;
        pendingPhoto = null;
        await save('items', it);
        toast('已儲存'); go('#/item/' + it.id);
      }
      else if (kind === 'store') {
        const name = String(fd.get('name') || '').trim();
        if (!name) { toast('請輸入賣場名稱'); return; }
        const tpl = String(fd.get('template') || '').trim();
        if (tpl && !Core.isHttpUrl(tpl.split('{q}').join('x'))) { toast('網址範本必須以 http 或 https 開頭'); return; }
        const old = id ? storeById(id) : null;
        await save('stores', Object.assign({}, old || { id: Core.uid() }, { name, kind: fd.get('kind'), rounding: fd.get('rounding'), template: tpl }));
        toast(id ? '已儲存' : '已新增賣場'); render();
      }
      else if (kind === 'rule') {
        const type = fd.get('type');
        const params = readParams(type, fd);
        const err = validateParams(type, params);
        if (err) { toast(err); return; }
        const itemIds = fd.getAll('item');
        if (type !== 'threshold' && !itemIds.length) { toast('請至少勾選一項適用商品'); return; }
        let cid = fd.get('campaignId');
        if (cid === '__new') {
          const name = String(fd.get('c_name') || '').trim();
          if (!name) { toast('請輸入檔期名稱'); return; }
          const start = fd.get('c_start') || '', end = fd.get('c_end') || '';
          if (start && end && end < start) { toast('結束日不能早於開始日'); return; }
          const camp = { id: Core.uid(), storeId: fd.get('c_store'), name, start, end, note: '' };
          await save('promoCampaigns', camp);
          await setSetting('lastStore', camp.storeId);
          cid = camp.id;
        }
        if (!cid) { toast('請選擇檔期'); return; }
        const lim = Number(fd.get('limit'));
        const rule = { id: id || Core.uid(), campaignId: cid, type, params, limit: ['unitoff', 'threshold'].includes(type) ? '' : (lim > 0 ? Math.floor(lim) : '') };
        await save('promoRules', rule);
        for (const x of S.promoItems.filter(x => x.ruleId === rule.id)) await remove('promoItems', x.id);
        if (type !== 'threshold') for (const iid of itemIds) await save('promoItems', { id: rule.id + '|' + iid, ruleId: rule.id, itemId: iid });
        toast('已儲存特價規則');
        go(fd.get('ret') || '#/promos');
      }
      else if (kind === 'campaign') {
        const name = String(fd.get('name') || '').trim();
        if (!name) { toast('請輸入檔期名稱'); return; }
        const start = fd.get('start') || '', end = fd.get('end') || '';
        if (start && end && end < start) { toast('結束日不能早於開始日'); return; }
        const old = id ? S.promoCampaigns.find(x => x.id === id) : null;
        const camp = Object.assign({}, old || { id: Core.uid() }, { storeId: fd.get('storeId'), name, start, end, note: String(fd.get('note') || '').trim() });
        await save('promoCampaigns', camp);
        toast('已儲存檔期');
        go(old ? '#/promos' : '#/rule/new?campaign=' + camp.id);
      }
      else if (kind === 'misc') {
        const cats = String(fd.get('cats') || '').split('\n').map(s => s.trim()).filter(Boolean);
        const big = String(fd.get('bigGo') || '').trim();
        if (big && !Core.isHttpUrl(big.split('{q}').join('x'))) { toast('BigGo 網址範本必須以 http 或 https 開頭'); return; }
        await setSetting('categories', cats.length ? cats : Core.DEFAULT_CATEGORIES.slice());
        await setSetting('bigGoTemplate', big || Core.BIGGO_TEMPLATE);
        toast('已儲存'); render();
      }
    } catch (err) { console.error(err); toast('發生錯誤：' + err.message); }
  });

  function onSearchInput(e) {
    if (e.target.id === 'homeSearch') {
      if (e.isComposing) return; // 注音輸入選字中先不重繪，避免打斷輸入
      homeQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = $('#homeSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }
  }
  document.addEventListener('input', onSearchInput);
  document.addEventListener('compositionend', onSearchInput);

  document.addEventListener('change', async e => {
    const t = e.target;
    try {
      if (t.id === 'cartStore') {
        const c = cart(); c.storeId = t.value;
        c.lines.forEach(l => { if (!l.manual) { const p = c.storeId ? latestPrice(l.itemId, c.storeId) : null; l.price = p ? p.price : null; } });
        await setSetting('cart', c); render();
      }
      else if (t.dataset && t.dataset.cartprice !== undefined) {
        const c = cart(), l = c.lines[Number(t.dataset.cartprice)];
        l.price = t.value === '' ? null : Number(t.value); l.manual = true;
        await setSetting('cart', c); render();
      }
      else if (t.dataset && t.dataset.hsel !== undefined) {
        if (t.checked) historySel.add(t.dataset.hsel); else historySel.delete(t.dataset.hsel);
        render();
      }
      else if (t.dataset && t.dataset.ruletoggle !== undefined) {
        const c = cart(), d = c.disabled || [], rid = t.dataset.ruletoggle;
        c.disabled = t.checked ? d.filter(x => x !== rid) : d.concat([rid]);
        await setSetting('cart', c); render();
      }
      else if (t.matches && t.matches('[data-dealsel]')) {
        const f = t.closest('form');
        f.querySelectorAll('[data-deal]').forEach(e => { e.hidden = e.dataset.deal !== t.value; });
        f.querySelector('[data-dealsync]').hidden = !t.value;
        const pi = f.querySelector('input[name=price]'); if (pi) pi.required = t.value !== 'bundle';
        const ph = f.querySelector('[data-pricehint]'); if (ph) ph.textContent = t.value === 'bundle' ? '（不確定可留空）' : '';
      }
      else if (t.matches && t.matches('form[data-form=price] select[name=storeId]')) {
        const w = t.closest('form').querySelector('[data-otherwrap]'); if (w) w.hidden = t.value !== OTHER_ID;
      }
      else if (t.id === 'cartPlace') { const c = cart(); c.place = t.value; await setSetting('cart', c); }
      else if (t.matches && t.matches('[data-campsel]')) {
        t.closest('form').querySelector('[data-newcamp]').hidden = t.value !== '__new';
      }
      else if (t.matches && t.matches('[data-typesel]')) {
        const f = t.closest('form');
        f.querySelectorAll('[data-ptype]').forEach(e => { e.hidden = e.dataset.ptype !== t.value; });
        f.querySelector('[data-limitwrap]').hidden = ['unitoff', 'threshold'].includes(t.value);
        f.querySelector('[data-itempick]').hidden = t.value === 'threshold';
      }
      else if (t.id === 'theme') { await setSetting('theme', t.value); applyTheme(); }
      else if (t.id === 'readOnly') { await setSetting('readOnly', t.checked); toast(t.checked ? '已啟用唯讀模式' : '已關閉唯讀模式'); render(); }
      else if (t.id === 'backupDays') { await setSetting('backupDays', Math.max(1, Number(t.value) || 14)); toast('已儲存'); }
      else if (t.id === 'importFile' && t.files[0]) { await doImport(t.files[0], $('#importMode').value); t.value = ''; }
      else if (t.id === 'photoFile' && t.files[0]) {
        try {
          pendingPhoto = await resizeImage(t.files[0]);
          const p = $('#photoPrev'); p.src = pendingPhoto; p.style.display = 'block';
        } catch (err) { toast(err.message); }
      }
    } catch (err) { console.error(err); toast('發生錯誤：' + err.message); }
  });

  // 商品篩選（特價規則表單、特價頁搜尋）
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset && t.dataset.filter === 'itemPick') {
      const q = t.value.trim().toLowerCase();
      t.closest('[data-itempick]').querySelectorAll('label[data-name]').forEach(l => { l.hidden = !!q && !l.dataset.name.includes(q); });
    } else if (t.id === 'promoSearch') {
      if (e.isComposing) return;
      promoQuery = t.value;
      const pos = t.selectionStart;
      render();
      const el = $('#promoSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }
  });
  document.addEventListener('compositionend', e => {
    if (e.target.id === 'promoSearch') {
      promoQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = $('#promoSearch'); if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }
  });

  // 商品頁左右滑動切換上一筆／下一筆
  let sx = null, sy = null;
  document.addEventListener('touchstart', e => {
    const z = e.target.closest && e.target.closest('#swipeZone');
    if (!z || e.touches.length !== 1) { sx = null; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (sx === null) return;
    const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50 && Math.abs(dx) > Math.abs(dy) * 1.5) stepItem(dx < 0 ? 1 : -1);
  }, { passive: true });

  /* ---------- 商品編輯頁：浮動查價鈕（點一下查預設賣場，長按選其他賣場） ---------- */
  function searchStores() { return S.stores.filter(s => s.id !== OTHER_ID && s.template); }
  function defaultSearchStore() {
    const l = searchStores();
    return l.find(s => s.name === '全聯') || l[0] || null;
  }
  function searchFabHtml() {
    const s = defaultSearchStore();
    if (!s) return '';
    return '<div class="hint">右下角的查價鈕會用上面輸入的名稱（沒填名稱就用條碼）搜尋賣場；長按可換其他賣場。</div><div style="height:72px"></div>' +
      '<button type="button" class="fab fab-pill" data-fabsearch aria-label="查價">🔍 ' + esc(s.name) + '<span class="fab-sub">長按換賣場</span></button>';
  }
  function openSearch(store) {
    if (!store) return;
    const nameEl = document.querySelector('form[data-form=item] [name=name]');
    const bcEl = document.querySelector('form[data-form=item] [name=barcode]');
    const kw = (nameEl && nameEl.value.trim()) || (bcEl && bcEl.value.trim()) || '';
    if (!kw) { toast('請先輸入商品名稱或條碼，再查價'); return; }
    const url = Core.searchUrl(store.template, kw);
    if (!Core.isHttpUrl(url)) { toast(store.name + ' 的搜尋網址範本有誤，請到設定修改'); return; }
    window.open(url, '_blank', 'noopener');
  }
  function showSearchSheet() {
    const sh = $('#sheet');
    sh.innerHTML = '<div class="sheet-card"><b>到哪個賣場查價？</b>' +
      searchStores().map(s => '<button type="button" data-act="openSearch" data-store="' + esc(s.id) + '">' + esc(s.name) + '</button>').join('') +
      '<button type="button" data-act="closeSheet">取消</button></div>';
    sh.hidden = false;
  }
  function closeSheet() { const sh = $('#sheet'); if (sh) { sh.hidden = true; sh.innerHTML = ''; } }
  let fabTimer = null, fabLong = false;
  document.addEventListener('pointerdown', e => {
    fabLong = false;
    const b = e.target.closest && e.target.closest('[data-fabsearch]');
    if (!b) return;
    clearTimeout(fabTimer);
    fabTimer = setTimeout(() => { fabLong = true; showSearchSheet(); if (navigator.vibrate) navigator.vibrate(30); }, 550);
  });
  ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => clearTimeout(fabTimer)));
  document.addEventListener('contextmenu', e => { if (e.target.closest && e.target.closest('[data-fabsearch]')) e.preventDefault(); });
  // 內容改變（換頁）時一併關閉選單
  window.addEventListener('hashchange', closeSheet);
  // 賣場連結收合區：記住展開狀態，重繪時不會自己收起來
  document.addEventListener('toggle', e => {
    if (e.target.dataset && e.target.dataset.det === 'links') linksOpen = e.target.open;
  }, true);

  $('#scanClose').addEventListener('click', stopScan);
  window.addEventListener('hashchange', () => { stopScan(); render(); });

  /* ---------- 啟動 ---------- */
  (async function init() {
    try {
      if (!window.indexedDB) throw new Error('此瀏覽器不支援本機資料庫');
      idb = await openDB();
      await loadAll();
      await seed();
      applyTheme();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
      render();
    } catch (e) {
      $('#view').innerHTML = '<div class="card">啟動失敗：' + esc(e.message) + '<div class="hint">私密瀏覽模式下可能無法使用本機資料庫。</div></div>';
      console.error(e);
    }
  })();
})();
