// FreeBuddy 注入面板。运行在 WorkBuddy 渲染进程里，UI 全部挂在 Shadow DOM 内。
// 顶部由注入器注入的变量：FB_CONFIG（本机 API 地址/令牌/档案）、FB_CSS（样式文本）。
var CFG = FB_CONFIG;
var S = {
  open: false,
  tab: 'accounts',
  status: null,
  accounts: [],
  checkin: {},
  busy: {},
  lastError: '',
  livePort: CFG.uiPort,
  models: null,
  sessions: null,
  tasks: null,
  runs: [],
  templates: [],
  sessQuery: '',
  sessWs: '',
  sessOnlyCurrent: false,
};

var host = null;
var shadow = null;
var fabEl = null;
var panelEl = null;
var bodyEl = null;
var footEl = null;
var toastEl = null;
var modalEl = null;
var timers = [];
var listeners = [];
var dragState = null;

/* ───────── 基础工具 ───────── */

function h(tag, attrs, children) {
  var el = document.createElement(tag);
  if (attrs) {
    for (var k in attrs) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') {
        for (var d in v) el.dataset[d] = v[d];
      } else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  if (children === null || children === undefined || children === false) return;
  if (Array.isArray(children)) {
    for (var i = 0; i < children.length; i++) append(el, children[i]);
    return;
  }
  el.appendChild(children instanceof Node ? children : document.createTextNode(String(children)));
}

function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

function svg(paths, size) {
  var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  if (size) {
    el.setAttribute('width', size);
    el.setAttribute('height', size);
  }
  var parts = Array.isArray(paths) ? paths : [paths];
  for (var i = 0; i < parts.length; i++) {
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', parts[i]);
    el.appendChild(p);
  }
  return el;
}

var ICONS = {
  accounts: ['M16 20v-1.5A3.5 3.5 0 0 0 12.5 15h-5A3.5 3.5 0 0 0 4 18.5V20', 'M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z', 'M19 20v-1.5a3.5 3.5 0 0 0-2.6-3.4', 'M15.5 4.2a3.5 3.5 0 0 1 0 6.6'],
  usage: ['M4 19h16', 'M7 19V9', 'M12 19V4', 'M17 19v-7'],
  theme: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z'],
  enhance: ['M12 3v4', 'M12 17v4', 'M3 12h4', 'M17 12h4', 'M6.3 6.3l2.8 2.8', 'M14.9 14.9l2.8 2.8', 'M17.7 6.3l-2.8 2.8', 'M9.1 14.9l-2.8 2.8'],
  power: ['M12 3v9', 'M6.8 6.8a7.5 7.5 0 1 0 10.4 0'],
  about: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', 'M12 11v5', 'M12 7.6h.01'],
  switch: ['M7 4h7l-2.5-2.5', 'M17 20h-7l2.5 2.5', 'M4 11h16', 'M20 13H4'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  star: ['M12 3.6l2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9L4.5 9.8l5.9-.8Z'],
  edit: ['M4 20h16', 'M14.5 4.5l3 3L9 16H6v-3l8.5-8.5Z'],
  check: ['M4.5 12.5l5 5 10-11'],
  plus: ['M12 5v14', 'M5 12h14'],
  refresh: ['M20 11a8 8 0 1 0-.9 4.6', 'M20 5v6h-6'],
  export: ['M12 15V4', 'M8 8l4-4 4 4', 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15'],
  import: ['M12 4v11', 'M8 11l4 4 4-4', 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  folder: ['M4 7.5A1.5 1.5 0 0 1 5.5 6h3.2l1.6 2H18.5A1.5 1.5 0 0 1 20 9.5v7A1.5 1.5 0 0 1 18.5 18h-13A1.5 1.5 0 0 1 4 16.5Z'],
  warn: ['M12 4l8.5 15h-17Z', 'M12 10v4', 'M12 16.5h.01'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z'],
  paw: [
    'M8.4 13.4c-1.9 1-3.9 1.5-5.3 1-1-.3-1.5-1.2-1.3-2.2.3-1.4 2-2.5 3.9-3',
    'M15.6 13.4c1.9 1 3.9 1.5 5.3 1 1-.3 1.5-1.2 1.3-2.2-.3-1.4-2-2.5-3.9-3',
    'M12 8.4c2.5 0 4.5 1.9 5 4.3.5 2-.3 3.9-2.2 4.7-1.1.5-1.7.7-2.8.7s-1.7-.2-2.8-.7C7.3 16.6 6.5 14.7 7 12.7 7.5 10.3 9.5 8.4 12 8.4Z',
  ],
  spark: ['M12 3.2l1.9 5.4 5.4 1.9-5.4 1.9L12 17.8l-1.9-5.4L4.7 10.5l5.4-1.9Z'],
  gear: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2a2 2 0 1 1 0-4h.2A1.7 1.7 0 0 0 3.7 9a1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1.1Z'],
  models: ['M12 3.2 20 7.6v8.8L12 20.8 4 16.4V7.6Z', 'M12 12l8-4.4', 'M12 12v8.8', 'M12 12 4 7.6'],
  sessions: ['M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7A2.5 2.5 0 0 1 17.5 16H9l-5 4Z'],
  tasks: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 7.5V12l3 2'],
  fork: ['M7 5v9a3 3 0 0 0 3 3h4', 'M17 14v3h3', 'M14 3.5v4h4', 'M6 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z', 'M18 12.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z'],
  bolt: ['M13 3 5 14h5l-1 7 8-11h-5Z'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 7.5V12l3 2'],
  play: ['M8 5.5v13l11-6.5Z'],
  pause: ['M9 5.5v13', 'M15 5.5v13'],
  eye: ['M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z', 'M12 14.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2Z'],
};

/* ───────── API ───────── */

function api(path, opts) {
  opts = opts || {};
  var init = { method: opts.method || 'GET', headers: {} };
  init.headers['X-FreeBuddy-Token'] = CFG.apiToken;
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  return fetch(CFG.apiBase + path, init).then(function (res) {
    return res
      .json()
      .catch(function () {
        return { ok: false, error: 'HTTP ' + res.status };
      })
      .then(function (data) {
        if (!data.ok && data.error) S.lastError = data.error;
        return data;
      });
  });
}

/* ───────── Toast ───────── */

function toast(msg, level) {
  if (!toastEl) return;
  var el = h('div', { class: 'fb-toast is-' + (level || 'info') }, [
    h('span', { class: 'fb-t-dot' }),
    h('span', { text: msg }),
  ]);
  toastEl.appendChild(el);
  setTimeout(function () {
    el.classList.add('is-out');
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }, level === 'error' ? 5200 : 3000);
}

/* ───────── 模态 ───────── */

function closeModal() {
  if (modalEl && modalEl.parentNode) modalEl.parentNode.removeChild(modalEl);
  modalEl = null;
}

function modal(spec) {
  closeModal();
  var mask = h('div', {
    class: 'fb-mask',
    onclick: function (e) {
      if (e.target === mask && spec.dismissible !== false) closeModal();
    },
  });
  var dialog = h('div', { class: 'fb-modal', role: 'dialog' });
  append(dialog, [h('div', { class: 'fb-modal-head', text: spec.title || '' })]);
  var body = h('div', { class: 'fb-modal-body' });
  append(body, typeof spec.body === 'function' ? spec.body() : spec.body || '');
  append(dialog, [body]);
  if (spec.actions) {
    var acts = h('div', { class: 'fb-modal-actions' });
    for (var i = 0; i < spec.actions.length; i++) {
      (function (a) {
        acts.appendChild(
          h('button', {
            class: 'fb-btn' + (a.primary ? ' is-primary' : '') + (a.danger ? ' is-danger' : ''),
            disabled: a.disabled ? true : null,
            text: a.label,
            onclick: function () {
              if (a.onClick) a.onClick();
              if (a.keepOpen !== true) closeModal();
            },
          }),
        );
      })(spec.actions[i]);
    }
    append(dialog, [acts]);
  }
  append(mask, [dialog]);
  shadow.appendChild(mask);
  modalEl = mask;
  var focusable = dialog.querySelector('.fb-input, .fb-btn.is-primary');
  if (focusable) setTimeout(function () { focusable.focus(); }, 30);
  return dialog;
}

function confirmDialog(title, text, okLabel, onOk, danger) {
  modal({
    title: title,
    body: h('div', { text: text }),
    actions: [
      { label: '取消' },
      { label: okLabel || '确定', primary: !danger, danger: !!danger, onClick: onOk },
    ],
  });
}

/* ───────── 视图：账号 ───────── */

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  if (n >= 100000) return Math.round(n / 1000) + 'k';
  if (n >= 10000) return (n / 1000).toFixed(1) + 'k';
  if (n % 1 !== 0) return String(Math.round(n * 10) / 10);
  return String(Math.round(n));
}

function isPaidEdition(edition) {
  if (!edition) return false;
  var e = String(edition).toLowerCase();
  return e !== 'personal' && e !== 'free' && e !== 'trial';
}

function daysLeft(expiresAt) {
  if (!expiresAt) return null;
  return Math.floor((expiresAt - Date.now()) / 86400000);
}

// 资源包分段条：一段代表一个包，宽度按总量占比，颜色按剩余比例
function segmentBar(segs) {
  var bar = h('div', { class: 'fb-segbar' });
  var total = segs.reduce(function (a, s) { return a + (s.size || 0); }, 0);
  for (var i = 0; i < segs.length; i++) {
    (function (s) {
      var w = total ? Math.max(1.4, ((s.size || 1) / total) * 100) : 100 / segs.length;
      var r = s.size ? Math.max(0, Math.min(1, s.remain / s.size)) : 0;
      var color = r <= 0 ? 'var(--fb-line-strong)' : 'color-mix(in srgb, var(--fb-accent) ' + Math.round(30 + r * 70) + '%, var(--fb-line-strong))';
      bar.appendChild(
        h('i', {
          style: 'flex:0 0 ' + w.toFixed(2) + '%;background:' + color,
          title: (s.name || '资源包') + ' · 剩余 ' + fmtNum(s.remain) + '/' + fmtNum(s.size) + (s.expiresAt ? ' · 到期 ' + String(s.expiresAt).slice(0, 10) : ''),
        }),
      );
    })(segs[i]);
  }
  return bar;
}

function fmtDateTime(ms) {
  if (!ms) return null;
  var d = new Date(ms);
  var p2 = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function accountRow(acc) {
  var isCurrent = acc.uid === (S.status && S.status.current);
  var ops = h('div', { class: 'fb-row-ops' });

  if (!isCurrent) {
    ops.appendChild(
      h('button', { class: 'fb-icon-btn', title: '切换到此账号', onclick: function () { doSwitch(acc); } }, [svg(ICONS.switch)]),
    );
    ops.appendChild(
      h('button', {
        class: 'fb-icon-btn',
        title: '设为主账号',
        onclick: function () {
          api('/api/accounts/primary', { method: 'POST', body: { uid: acc.uid } }).then(function (r) {
            if (r.ok) { toast('已设为主账号', 'ok'); refresh(); } else toast(r.error || '设置失败', 'error');
          });
        },
      }, [svg(ICONS.star)]),
    );
  }
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '备注', onclick: function () { editNote(acc); } }, [svg(ICONS.edit)]));
  if (!isCurrent) {
    ops.appendChild(
      h('button', {
        class: 'fb-icon-btn is-danger',
        title: '删除备份',
        onclick: function () {
          confirmDialog(
            '删除账号备份',
            '将删除「' + (acc.note || acc.nickname || acc.uid) + '」在本机的登录备份。官方客户端的登录态不受影响，但之后需要重新扫码登录。',
            '删除',
            function () {
              api('/api/accounts/delete', { method: 'POST', body: { uid: acc.uid } }).then(function (r) {
                if (r.ok) { toast('已删除', 'ok'); refresh(); } else toast(r.error || '删除失败', 'error');
              });
            },
            true,
          );
        },
      }, [svg(ICONS.trash)]),
    );
  }

  // 第一行：名字 + 状态徽标（当前 / 主账号 / 今日签到）
  var top = h('div', { class: 'fb-acct-top' });
  top.appendChild(h('b', { class: 'fb-acct-name', text: acc.note || acc.nickname || ('账号 ' + String(acc.uid).slice(0, 8)) }));
  if (isCurrent) top.appendChild(h('span', { class: 'fb-badge is-accent', text: '当前' }));
  if (acc.isPrimary) top.appendChild(h('span', { class: 'fb-badge', text: '主账号' }));
  if (isPaidEdition(acc.edition)) top.appendChild(h('span', { class: 'fb-badge is-warn', text: acc.edition }));
  if (acc.checkedInToday === true) {
    top.appendChild(h('span', { class: 'fb-badge is-ok', text: '今日已签到' }));
  } else if (acc.checkedInToday === false) {
    top.appendChild(h('button', { class: 'fb-badge is-warn is-btn', text: '去签到', onclick: function () { doCheckin(acc); } }));
  }
  if (acc.authValid === false) top.appendChild(h('span', { class: 'fb-badge is-danger', text: '登录态失效' }));
  top.appendChild(h('div', { class: 'fb-grow' }));
  append(top, ops);

  // 第二行：手机 + 有效期至
  var mid = h('div', { class: 'fb-acct-mid' });
  if (acc.phone) mid.appendChild(h('span', {}, ['手机 ', h('b', { class: 'fb-mono', text: String(acc.phone) })]));
  mid.appendChild(h('div', { class: 'fb-grow' }));
  var exp = fmtDateTime(acc.tokenExpiresAt);
  var dl = daysLeft(acc.tokenExpiresAt);
  if (exp) {
    mid.appendChild(
      h('span', { class: dl != null && dl < 7 ? 'fb-warn-text' : null }, [
        dl != null && dl < 0 ? '登录态已过期 · ' : '有效期至 ',
        h('b', { class: 'fb-mono', text: exp }),
      ]),
    );
  }

  var parts = [top, mid];

  // 第三行：剩余积分（没有数据时也占位，说明原因）
  var creditRow = h('div', { class: 'fb-acct-credit' }, [h('span', { text: '剩余' }), svg(ICONS.spark)]);
  if (acc.credit != null) {
    creditRow.appendChild(
      h('b', { text: Number(acc.credit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }),
    );
    if (acc.refreshed) creditRow.appendChild(h('span', { class: 'fb-badge is-ok', text: '已续期' }));
  } else {
    creditRow.appendChild(h('b', { class: 'is-empty', text: '—' }));
    creditRow.appendChild(
      h('span', { class: 'fb-credit-hint', title: acc.dataError || '', text: acc.dataLocked ? '点切换同步一次' : '暂时取不到' }),
    );
  }
  parts.push(creditRow);

  // 第四行：资源包分段条
  if (acc.creditSegments && acc.creditSegments.length) parts.push(segmentBar(acc.creditSegments));

  return h('div', { class: 'fb-row is-acct' + (isCurrent ? ' is-current' : '') }, parts);
}
function editNote(acc) {
  var input = h('input', { class: 'fb-input', value: acc.note || '', placeholder: '给这个账号起个名字' });
  modal({
    title: '账号备注',
    body: h('div', {}, [h('div', { style: 'margin-bottom:8px;color:var(--fb-ink-3)', text: '备注只保存在本机。' }), input]),
    actions: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        onClick: function () {
          api('/api/accounts/note', { method: 'POST', body: { uid: acc.uid, note: input.value.trim() } }).then(function (r) {
            if (r.ok) { toast('已保存', 'ok'); refresh(); }
            else toast(r.error || '保存失败', 'error');
          });
        },
      },
    ],
  });
}

function doSwitch(acc) {
  if (S.busy.switch) return;
  S.busy.switch = true;
  var name = acc.note || acc.nickname || acc.uid;
  toast('正在切换到 ' + name + '…', 'info');
  render();
  // 客户端需要重启才能真的换账号，所以这里轮询到「当前账号确实变成目标」为止
  var waited = 0;
  var poll = setInterval(function () {
    waited += 3;
    api('/api/status').then(function (st) {
      if (st && st.ok && st.current === acc.uid && (!st.currentAccount || !st.currentAccount.rendererUid || st.currentAccount.rendererUid === acc.uid)) {
        clearInterval(poll);
        S.busy.switch = false;
        toast('已切换到 ' + name, 'ok');
        refresh(true);
      } else if (waited > 150) {
        clearInterval(poll);
        S.busy.switch = false;
        toast('切换耗时过长，请稍后手动刷新看看', 'warn');
        refresh(true);
      }
    });
  }, 3000);
  api('/api/switch', { method: 'POST', body: { uid: acc.uid, reload: true } }).then(function (r) {
    if (!r || !r.ok) {
      clearInterval(poll);
      S.busy.switch = false;
      toast((r && r.error) || '切换失败', 'error');
      refresh(true);
    }
  });
}

function viewAccounts() {
  var list = S.accounts || [];
  var live = null;
  for (var i = 0; i < list.length; i++) if (list[i].isLive) live = list[i];
  var checked = list.filter(function (x) { return x.checkedInToday === true; }).length;

  var head = h('div', { class: 'fb-view-head' }, [
    h('h2', { text: '账号' }),
    h('span', { class: 'fb-sub', text: list.length ? list.length + ' 个本机备份' : '' }),
    h('div', { class: 'fb-grow' }),
    h('button', { class: 'fb-btn is-sm', onclick: doExport, title: '加密导出全部账号' }, [svg(ICONS.export), '导出']),
    h('button', { class: 'fb-btn is-sm', onclick: doImport, title: '从加密文件导入账号' }, [svg(ICONS.import), '导入']),
    h('button', { class: 'fb-btn is-sm', onclick: function () { refresh(true); } }, [svg(ICONS.refresh)]),
  ]);

  var stats = h('dl', { class: 'fb-stats' }, [
    stat('账号', String(list.length) + ' 个'),
    stat('总积分', S.status && S.status.totalCredit != null ? fmtNum(S.status.totalCredit) : '—'),
    stat('今日签到', checked + '/' + list.length),
  ]);

  var parts = [head, stats];

  if (!S.status || !S.status.cdpConnected) {
    parts.push(
      h('div', { class: 'fb-note is-warn' }, [
        svg(ICONS.warn),
        '还没连上 WorkBuddy 的调试端口。用启动器打开一次 WorkBuddy（FreeBuddy 会让它带上调试端口），或点右上角刷新。',
      ]),
    );
  } else if (S.status.officialError) {
    parts.push(h('div', { class: 'fb-note is-warn' }, [svg(ICONS.warn), '官方数据暂时取不到：' + S.status.officialError]));
  }

  if (!list.length) {
    parts.push(h('div', { class: 'fb-empty', text: '还没有账号备份。保持 WorkBuddy 登录态，点下面的「备份当前账号」。' }));
  } else {
    var l = h('div', { class: 'fb-list' });
    for (var k = 0; k < list.length; k++) l.appendChild(accountRow(list[k]));
    parts.push(h('div', {}, [secHead('账号列表', list.length + ' 个'), l]));
  }

  // 底部操作条：常驻吸底，滚动时始终可点
  parts.push(
    h('div', { class: 'fb-actions' }, [
      h('button', { class: 'fb-btn is-primary fb-actions-main', onclick: doSeamlessLogin }, [
        svg(ICONS.import),
        '登录新账号',
      ]),
    ]),
  );

  return h('div', { class: 'fb-view' }, parts);
}
function secHead(title, count) {
  return h('div', { class: 'fb-sec' }, [
    h('h3', { text: title }),
    h('div', { class: 'fb-sec-line' }),
    count ? h('span', { class: 'fb-count', text: count }) : null,
  ]);
}

// 签到与成长：连续天数 / 下一个档位的进度 / 待领奖励 / 补签卡

/* ───────── 免打扰：自动点掉阻塞式权限弹窗 ───────── */

var ndState = { observer: null, timer: null, seen: new WeakSet(), lastToast: 0 };

var ALLOW_RE = /^(允许|同意|批准|继续|确认|好的|Allow|Approve|Accept|Agree|Continue|Yes|OK)$/i;
var DENY_RE = /(不允许|拒绝|取消|稍后|不再|Deny|Reject|Cancel|Later|No)/i;

function ndCandidates() {
  var sels = [
    '[role="dialog"]',
    '[class*="permission" i]',
    '[class*="Permission" i]',
    '[class*="dialog" i]',
    '[class*="modal" i]',
    '[class*="confirm" i]',
  ];
  var out = [];
  for (var i = 0; i < sels.length; i++) {
    var list = document.querySelectorAll(sels[i]);
    for (var j = 0; j < list.length; j++) out.push(list[j]);
  }
  return out;
}

function ndVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  var r = el.getBoundingClientRect();
  if (r.width < 40 || r.height < 24) return false;
  var cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0.2;
}

function ndScan() {
  if (!(S.settings && S.settings.noDisturb)) return;
  var hosts = ndCandidates();
  for (var i = 0; i < hosts.length; i++) {
    var host = hosts[i];
    // 不碰自家面板
    if (host.id === 'freebuddy-host' || host.closest('#freebuddy-host')) continue;
    if (!ndVisible(host)) continue;
    var btns = host.querySelectorAll('button, [role="button"], a');
    for (var j = 0; j < btns.length; j++) {
      var b = btns[j];
      var txt = (b.textContent || '').trim();
      if (!txt || txt.length > 12) continue;
      if (!ALLOW_RE.test(txt) || DENY_RE.test(txt)) continue;
      if (ndState.seen.has(b)) continue;
      if (!ndVisible(b) || b.disabled) continue;
      ndState.seen.add(b);
      try {
        b.click();
      } catch (e) {
        continue;
      }
      var now = Date.now();
      if (now - ndState.lastToast > 2500) {
        ndState.lastToast = now;
        toast('已自动允许权限弹窗' + (txt ? '（' + txt + '）' : ''), 'ok');
      }
      return;
    }
  }
}

function ndSchedule() {
  if (ndState.timer) return;
  ndState.timer = setTimeout(function () {
    ndState.timer = null;
    try {
      ndScan();
    } catch (e) {
      /* 忽略扫描异常，别影响页面 */
    }
  }, 400);
}

function setupNoDisturb() {
  var want = !!(S.settings && S.settings.noDisturb);
  if (!want) {
    if (ndState.observer) {
      ndState.observer.disconnect();
      ndState.observer = null;
    }
    if (ndState.timer) {
      clearTimeout(ndState.timer);
      ndState.timer = null;
    }
    return;
  }
  if (ndState.observer) return;
  // 只观察直接子节点变化太窄（弹窗常挂在深层容器里），用节流把开销压住
  ndState.observer = new MutationObserver(ndSchedule);
  ndState.observer.observe(document.body, { childList: true, subtree: true });
  listeners.push(function () {
    if (ndState.observer) ndState.observer.disconnect();
    ndState.observer = null;
    if (ndState.timer) clearTimeout(ndState.timer);
    ndState.timer = null;
  });
  ndScan();
}

function doCheckin(acc) {
  toast('正在为 ' + (acc.note || acc.nickname || '该账号') + ' 签到…', 'info');
  api('/api/checkin', { method: 'POST', body: { uid: acc.uid } }).then(function (r) {
    if (!r.ok) {
      toast(r.error || '签到失败', 'error');
      return;
    }
    toast(r.message || '签到完成', 'ok');
    setTimeout(function () { refresh(true); }, 1200);
  });
}


/* ───────── 登录新账号：无感登录 ───────── */

function doSeamlessLogin() {
  api('/api/login/seamless/start', { method: 'POST' }).then(function (r) {
    if (!r.ok) { toast(r.error || '发起授权失败', 'error'); return; }
    var tip = h('div', { class: 'fb-wait' }, [
      h('span', { class: 'fb-spin' }),
      h('span', { text: '已在系统浏览器打开授权页，请完成扫码登录。窗口会在授权成功后自动加入账号列表。' }),
    ]);
    modal({
      title: '无感登录',
      dismissible: false,
      body: tip,
      actions: [{ label: '后台等待', onClick: function () {} }],
    });
    var told = 0;
    var t = setInterval(function () {
      told++;
      api('/api/login/seamless/poll?loginId=' + encodeURIComponent(r.loginId)).then(function (res) {
        if (!res.ok) return;
        if (res.done) {
          clearInterval(t);
          closeModal();
          if (res.result) {
            toast('已加入账号：' + (res.result.nickname || res.result.uid.slice(0, 8)), 'ok');
            refresh(true);
          } else {
            toast(res.error || '授权未完成', 'error');
          }
        } else if (told > 120) {
          clearInterval(t);
          closeModal();
          toast('授权等待超时，请重新发起', 'warn');
        }
      });
    }, 3000);
  });
}

function stat(label, value) {
  return h('div', { class: 'fb-stat' }, [
    h('dt', { text: label }),
    h('dd', { text: value }),
  ]);
}

function doExport() {
  var input = h('input', { class: 'fb-input', type: 'password', placeholder: '设置一个导出密码' });
  modal({
    title: '导出账号备份',
    body: h('div', {}, [
      h('div', { style: 'margin-bottom:8px;line-height:1.7', text: '导出文件用你输入的密码做 AES-256-GCM 加密，内含可恢复登录态的凭据，请像密码一样保管。' }),
      input,
    ]),
    actions: [
      { label: '取消' },
      {
        label: '导出',
        primary: true,
        onClick: function () {
          var pwd = input.value;
          if (!pwd) { toast('请输入密码', 'error'); return; }
          api('/api/accounts/export', { method: 'POST', body: { password: pwd } }).then(function (r) {
            if (!r.ok) { toast(r.error || '导出失败', 'error'); return; }
            var blob = new Blob([JSON.stringify(r.content)], { type: 'application/json' });
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = r.filename || 'freebuddy-accounts.json';
            a.click();
            setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
            toast('已导出 ' + r.count + ' 个账号', 'ok');
          });
        },
      },
    ],
  });
}

function doImport() {
  var file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  var pwd = h('input', { class: 'fb-input', type: 'password', placeholder: '导出时设置的密码' });
  file.addEventListener('change', function () {
    if (!file.files || !file.files[0]) return;
    var reader = new FileReader();
    reader.onload = function () {
      var content;
      try {
        content = JSON.parse(String(reader.result));
      } catch (e) {
        toast('文件不是合法 JSON', 'error');
        return;
      }
      api('/api/accounts/import', { method: 'POST', body: { content: content, password: pwd.value } }).then(function (r) {
        if (!r.ok) { toast(r.error || '导入失败', 'error'); return; }
        closeModal();
        if (r.count > 0) {
          toast('已导入 ' + r.count + ' 个账号' + (r.skipped ? '，另有 ' + r.skipped + ' 个本机已存在已跳过' : ''), 'ok');
        } else if (r.skipped > 0) {
          toast('这 ' + r.skipped + ' 个账号本机都已经有了，没有需要导入的', 'warn');
        } else {
          toast('这个文件里没有账号', 'warn');
        }
        refresh(true);
      });
    };
    reader.readAsText(file.files[0]);
  });
  modal({
    title: '导入账号备份',
    body: h('div', {}, [
      h('div', { style: 'margin-bottom:8px;line-height:1.7', text: '选择之前导出的加密文件，并输入当时的密码。导入不会覆盖已存在的同名账号。' }),
      pwd,
      h('div', { style: 'margin-top:9px' }, [
        h('button', { class: 'fb-btn', text: '选择文件…', onclick: function () { file.click(); } }),
      ]),
    ]),
    actions: [{ label: '取消' }],
  });
}

/* ───────── 视图：用量 ───────── */

/* ───────── 视图：用量（Token 活动热力图） ───────── */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayKeyOf(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function fmtTokens(n) {
  if (n == null || isNaN(n)) return '—';
  if (n >= 1e8) return (n / 1e8).toFixed(1) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + ' 万';
  return String(Math.round(n));
}

// 把每日用量按当前口径换算成「每个格子的值」
function buildCells(stats, mode) {
  var daily = (stats && stats.daily) || [];
  var byDate = {};
  for (var i = 0; i < daily.length; i++) byDate[daily[i].date] = daily[i].total;
  var out = {};
  var running = 0;
  var sorted = daily.slice().sort(function (a, b) { return a.date.localeCompare(b.date); });
  var cum = {};
  for (var k = 0; k < sorted.length; k++) {
    running += sorted[k].total;
    cum[sorted[k].date] = running;
  }
  var keys = Object.keys(byDate);
  if (mode === 'cumulative') {
    // 累计口径：每格显示到该日为止的累计值
    var last = 0;
    for (var j = 0; j < keys.length; j++) { /* keys 无序，改用有序遍历 */ }
    var dates = sorted.map(function (d) { return d.date; });
    return { cum: cum, dates: dates };
  }
  if (mode === 'weekly') {
    var weekly = {};
    for (var m = 0; m < sorted.length; m++) {
      var d0 = new Date(sorted[m].date + 'T00:00:00');
      var sun = new Date(d0);
      sun.setDate(sun.getDate() - sun.getDay());
      var wk = dayKeyOf(sun);
      weekly[wk] = (weekly[wk] || 0) + sorted[m].total;
    }
    return { weekly: weekly, dates: keys };
  }
  return { daily: byDate, dates: keys };
}

function heatmapEl(stats, mode) {
  var WEEK_MS = 86400000;
  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var end = new Date(today);
  end.setDate(end.getDate() + (6 - end.getDay())); // 补到本周周六
  var WEEKS = 53;
  var start = new Date(end.getTime() - (WEEKS * 7 - 1) * WEEK_MS);

  var wrapped = buildCells(stats, mode);
  var dates = wrapped.dates || [];
  var cumMap = wrapped.cum || null;
  var weeklyMap = wrapped.weekly || null;
  var dailyMap = wrapped.daily || null;

  // 计算每天的显示值
  var values = [];
  var cellDates = [];
  for (var w = 0; w < WEEKS; w++) {
    cellDates.push([]);
    for (var r = 0; r < 7; r++) {
      var d = new Date(start.getTime() + (w * 7 + r) * WEEK_MS);
      var key = dayKeyOf(d);
      var v = 0;
      if (mode === 'cumulative') {
        // 累计：找当天最后一个不超过它的累计值
        var best = 0;
        for (var i = 0; i < dates.length; i++) {
          if (dates[i] <= key) best = cumMap[dates[i]];
          else break;
        }
        v = best;
      } else if (mode === 'weekly') {
        var sun = new Date(d);
        sun.setDate(sun.getDate() - sun.getDay());
        v = weeklyMap[dayKeyOf(sun)] || 0;
      } else {
        v = dailyMap[key] || 0;
      }
      cellDates[w].push({ key: key, value: v, future: d > today });
      if (v > 0 && d <= today) values.push(v);
    }
  }
  values.sort(function (a, b) { return a - b; });
  function level(v) {
    if (!v) return 0;
    if (!values.length) return 0;
    var q = function (f) { return values[Math.min(values.length - 1, Math.floor(values.length * f))]; };
    if (v >= q(0.92)) return 4;
    if (v >= q(0.72)) return 3;
    if (v >= q(0.42)) return 2;
    return 1;
  }

  var wrap = h('div', { class: 'fb-heat' });
  var grid = h('div', { class: 'fb-heat-grid', style: 'grid-template-columns: repeat(' + WEEKS + ', 11px)' });
  for (var w2 = 0; w2 < WEEKS; w2++) {
    for (var r2 = 0; r2 < 7; r2++) {
      var cell = cellDates[w2][r2];
      grid.appendChild(
        h('i', {
          class: 'fb-heat-cell lv' + level(cell.value) + (cell.future ? ' is-future' : ''),
          title: cell.key + ' · ' + (cell.value ? fmtTokens(cell.value) + ' tokens' : '无记录'),
        }),
      );
    }
  }

  // 月份标签：每周一列，遇到换月就在那一列写一次
  var labels = h('div', { class: 'fb-heat-labels', style: 'grid-template-columns: repeat(' + WEEKS + ', 11px)' });
  var lastMonth = -1;
  for (var w3 = 0; w3 < WEEKS; w3++) {
    var colDate = new Date(start.getTime() + w3 * 7 * WEEK_MS);
    var lbl = '';
    if (colDate.getMonth() !== lastMonth) {
      lbl = (colDate.getMonth() + 1) + '月';
      lastMonth = colDate.getMonth();
    }
    labels.appendChild(h('span', { text: lbl }));
  }

  append(wrap, [grid, labels]);
  append(wrap, [
    h('div', { class: 'fb-heat-legend' }, [
      h('span', { text: '少' }),
      h('i', { class: 'fb-heat-cell lv0' }),
      h('i', { class: 'fb-heat-cell lv1' }),
      h('i', { class: 'fb-heat-cell lv2' }),
      h('i', { class: 'fb-heat-cell lv3' }),
      h('i', { class: 'fb-heat-cell lv4' }),
      h('span', { text: '多' }),
      h('div', { class: 'fb-grow' }),
      h('span', { class: 'fb-mono', text: dates.length ? dates[0] + ' 起' : '' }),
    ]),
  ]);
  return wrap;
}

var USAGE_MODE = 'daily';

function viewUsage() {
  var st = S.tokens || null;
  var head = h('div', { class: 'fb-view-head' }, [
    h('h2', { text: '用量' }),
    h('span', { class: 'fb-sub', text: st ? st.fileCount + ' 个会话文件 · ' + st.recordCount + ' 条记录' : '本机记录' }),
    h('div', { class: 'fb-grow' }),
    h('button', {
      class: 'fb-btn is-sm',
      onclick: function () {
        api('/api/token-stats?force=1').then(function (r) {
          if (r.ok) { S.tokens = r.stats; render(); toast('已重新统计', 'ok'); }
          else toast(r.error || '统计失败', 'error');
        });
      },
    }, [svg(ICONS.refresh), '重新统计']),
  ]);

  if (!st) {
    return h('div', { class: 'fb-view' }, [head, h('div', { class: 'fb-empty', text: '正在统计本机 Token 用量…' })]);
  }

  var stats = h('dl', { class: 'fb-stats' }, [
    stat('累计 Token', fmtTokens(st.totals.total)),
    stat('峰值 / 日', st.peak ? fmtTokens(st.peak.total) : '—'),
    stat('当前连续', st.currentStreak + ' 天'),
    stat('最长连续', st.longestStreak + ' 天'),
  ]);

  var seg = h('div', { class: 'fb-seg' });
  var modes = [
    ['daily', '每日'],
    ['weekly', '每周'],
    ['cumulative', '累计'],
  ];
  for (var i = 0; i < modes.length; i++) {
    (function (m) {
      var b = h('button', { class: USAGE_MODE === m[0] ? 'is-on' : '', text: m[1] });
      b.addEventListener('click', function () {
        USAGE_MODE = m[0];
        render();
      });
      seg.appendChild(b);
    })(modes[i]);
  }

  var heatCard = h('div', { class: 'fb-card' }, [
    h('div', { class: 'fb-card-head' }, [h('h3', { text: 'Token 活动' }), h('div', { class: 'fb-grow' }), seg]),
    heatmapEl(st, USAGE_MODE),
  ]);

  var parts = [head, stats, heatCard];

  // 输入 / 输出 / 缓存构成
  if (st.totals.total) {
    var t = st.totals;
    var rows = h('div', { class: 'fb-list' }, [
      h('div', { class: 'fb-row' }, [
        h('div', { class: 'fb-row-main' }, [h('div', { class: 'fb-row-title' }, [h('b', { text: '输入 Token' })]), h('div', { class: 'fb-row-meta' }, [h('span', { text: '发送给模型的上下文' })])]),
        h('b', { class: 'fb-mono', style: 'font-size:12.5px', text: t.input.toLocaleString() }),
      ]),
      h('div', { class: 'fb-row' }, [
        h('div', { class: 'fb-row-main' }, [h('div', { class: 'fb-row-title' }, [h('b', { text: '输出 Token' })]), h('div', { class: 'fb-row-meta' }, [h('span', { text: '模型生成的内容' })])]),
        h('b', { class: 'fb-mono', style: 'font-size:12.5px', text: t.output.toLocaleString() }),
      ]),
      h('div', { class: 'fb-row' }, [
        h('div', { class: 'fb-row-main' }, [h('div', { class: 'fb-row-title' }, [h('b', { text: '缓存命中' })]), h('div', { class: 'fb-row-meta' }, [h('span', { text: '命中缓存的输入，不计入累计' })])]),
        h('b', { class: 'fb-mono', style: 'font-size:12.5px', text: t.cacheRead.toLocaleString() }),
      ]),
    ]);
    parts.push(h('div', {}, [secHead('Token 构成'), rows]));
  }

  if (st.models && st.models.length) {
    var mrows = h('div', { class: 'fb-list' });
    for (var k = 0; k < st.models.length; k++) {
      (function (m) {
        mrows.appendChild(
          h('div', { class: 'fb-row' }, [
            h('div', { class: 'fb-row-main' }, [h('div', { class: 'fb-row-title' }, [h('b', { text: m.model })])]),
            h('b', { class: 'fb-mono', style: 'font-size:12.5px', text: fmtTokens(m.total) }),
          ]),
        );
      })(st.models[k]);
    }
    parts.push(h('div', {}, [secHead('模型分布', st.models.length + ' 个'), mrows]));
  }

  parts.push(
    h('div', { class: 'fb-note' }, [
      svg(ICONS.about),
      '统计口径：只读本机 WorkBuddy 的会话记录（projects 目录下的 jsonl），不联网、不上传；客户端自己的「使用统计」是账号维度的全量数据，两者口径不同。',
    ]),
  );

  return h('div', { class: 'fb-view' }, parts);
}
function optionRow(title, desc, control) {
  return h('div', { class: 'fb-opt' }, [
    h('div', { class: 'fb-opt-txt' }, [h('b', { text: title }), desc ? h('small', { text: desc }) : null]),
    control,
  ]);
}

function switchEl(on, onToggle) {
  var el = h('button', { class: 'fb-switch' + (on ? ' is-on' : ''), role: 'switch', 'aria-checked': String(!!on) });
  el.addEventListener('click', function () {
    var next = !el.classList.contains('is-on');
    el.classList.toggle('is-on', next);
    onToggle(next, function (revert) {
      if (revert) el.classList.toggle('is-on', !next);
    });
  });
  return el;
}

function soonSwitch() {
  var el = h('button', { class: 'fb-switch is-disabled', role: 'switch', 'aria-checked': 'false', title: '后续版本支持' });
  return h('div', { class: 'fb-soon' }, [el, h('span', { class: 'fb-badge', text: 'v0.2' })]);
}

function viewEnhance() {
  var set = S.settings || {};
  var head = h('div', { class: 'fb-view-head' }, [h('h2', { text: '增强' }), h('div', { class: 'fb-grow' })]);

  function setOpt(name, on, cb) {
    api('/api/settings/set', { method: 'POST', body: { name: name, enabled: on } }).then(function (r) {
      if (r.ok) { toast('已保存', 'ok'); S.settings = r.settings || set; }
      else { toast(r.error || '保存失败', 'error'); cb(true); }
    });
  }

  var nd = h('div', { class: 'fb-list' }, [
    h('div', { class: 'fb-opt', style: 'background:var(--fb-bg-sunken)' }, [
      h('div', { class: 'fb-opt-txt' }, [h('b', { text: '权限弹窗免打扰' }), h('small', { text: 'WorkBuddy 弹出确认框时自动点「允许」，让它能整夜无人值守跑任务。' })]),
      switchEl(!!set.noDisturb, function (on, revert) { setOpt('noDisturb', on, revert); }),
    ]),
  ]);

  var ac = h('div', { class: 'fb-list' }, [
    optionRow('异常中断自动续接', 'AI 回复因网络波动中断时，自动让它继续。', soonSwitch()),
    optionRow('暂存提示词按钮', '在输入框操作栏加一个按钮，把当前草稿（含图片文件）推进待发送队列。', soonSwitch()),
    optionRow('快捷短语按钮', '输入框操作栏一键发送常用语。', soonSwitch()),
  ]);

  return h('div', { class: 'fb-view' }, [
    head,
    h('div', {}, [h('div', { class: 'fb-sec' }, [h('h3', { text: '免打扰' }), h('div', { class: 'fb-sec-line' })]), nd]),
    h('div', {}, [h('div', { class: 'fb-sec' }, [h('h3', { text: '会话与输入框' }), h('div', { class: 'fb-sec-line' })]), ac]),
  ]);
}

/* ───────── 视图：电脑 ───────── */

function viewPower() {
  var set = S.settings || {};
  var head = h('div', { class: 'fb-view-head' }, [h('h2', { text: '电脑' }), h('div', { class: 'fb-grow' })]);

  var seg = h('div', { class: 'fb-seg' });
  var modes = [
    ['allow', '允许休眠'],
    ['keep', '禁止休眠'],
    ['until-done', '跑完再休眠'],
  ];
  for (var i = 0; i < modes.length; i++) {
    (function (m) {
      var b = h('button', { class: set.sleepMode === m[0] ? 'is-on' : '', text: m[1] });
      b.addEventListener('click', function () {
        api('/api/power/sleep-mode', { method: 'POST', body: { mode: m[0] } }).then(function (r) {
          if (r.ok) {
            S.settings = r.settings || set;
            toast('已切换为「' + m[1] + '」', 'ok');
            render();
          } else toast(r.error || '设置失败', 'error');
        });
      });
      seg.appendChild(b);
    })(modes[i]);
  }

  return h('div', { class: 'fb-view' }, [
    head,
    h('div', {}, [
      h('div', { class: 'fb-sec' }, [h('h3', { text: '休眠策略' }), h('div', { class: 'fb-sec-line' })]),
      h('div', { class: 'fb-list' }, [
        optionRow('系统休眠', '「跑完再休眠」会在所有 AI 任务结束后自动放开休眠。', seg),
        optionRow('显示器休眠', '只影响屏幕，不影响任务。', switchEl(!!set.displaySleep, function (on, revert) {
          api('/api/power/display-sleep', { method: 'POST', body: { enabled: on } }).then(function (r) {
            if (r.ok) { toast('已保存', 'ok'); S.settings = r.settings || set; }
            else { toast(r.error || '保存失败', 'error'); revert(true); }
          });
        })),
      ]),
    ]),
    h('div', { class: 'fb-note' }, [svg(ICONS.about), '用一个常驻的唤醒锁进程实现：不修改系统电源计划，切回「允许休眠」时立刻释放。']),
  ]);
}

/* ───────── 视图：关于 ───────── */

function viewAbout() {
  var st = S.status || {};
  var head = h('div', { class: 'fb-view-head' }, [h('h2', { text: '关于' }), h('div', { class: 'fb-grow' })]);

  var info = h('div', { class: 'fb-list' }, [
    optionRow('版本', '面板 ' + CFG.version + ' · daemon ' + (st.version || '—') + ' · 构建 ' + (st.buildId || '—'), null),
    optionRow('客户端', CFG.appName + ' · ' + (st.appVersion || '—') + '（' + CFG.profileId + '）', null),
    optionRow('调试端口', st.cdpConnected ? '已连接 127.0.0.1:' + st.cdpPort : '未连接', null),
    optionRow('数据目录', st.dataDir || '—', h('button', { class: 'fb-btn is-sm', text: '打开', onclick: function () { api('/api/open-dir', { method: 'POST' }); } })),
  ]);

  var actions = h('div', { class: 'fb-list' }, [
    optionRow('重新注入面板', '页面变化导致面板不见了时，重新挂载一次。', h('button', { class: 'fb-btn is-sm', text: '重新注入', onclick: function () { api('/api/inject', { method: 'POST' }).then(function (r) { toast(r.ok ? '已重新注入' : (r.error || '注入失败'), r.ok ? 'ok' : 'error'); }); } })),
    optionRow('断开并移除面板', '从当前页面彻底移除，不影响官方客户端。', h('button', { class: 'fb-btn is-sm is-danger', text: '移除', onclick: function () { api('/api/eject', { method: 'POST' }); } })),
  ]);

  var principle = h('div', { class: 'fb-note' }, [
    svg(ICONS.about),
    'FreeBuddy 只通过本机回环的调试协议与 WorkBuddy 通信，不改官方安装包、不改签名；账号备份与全部配置只留在本机。',
  ]);

  return h('div', { class: 'fb-view' }, [
    head,
    h('div', {}, [h('div', { class: 'fb-sec' }, [h('h3', { text: '运行信息' }), h('div', { class: 'fb-sec-line' })]), info]),
    h('div', {}, [h('div', { class: 'fb-sec' }, [h('h3', { text: '维护' }), h('div', { class: 'fb-sec-line' })]), actions]),
    principle,
  ]);
}

/* ───────── 视图：模型管理 ───────── */

function loadModels(force) {
  return api('/api/models').then(function (r) {
    if (r.ok) { S.models = r; render(); }
    else { S.models = { ok: false, error: r.error, models: [] }; render(); }
    return r;
  }).catch(function () {});
}

function modelCaps(m) {
  var caps = [];
  if (m.supportsToolCall) caps.push('工具');
  if (m.supportsImages) caps.push('识图');
  if (m.supportsReasoning) caps.push('推理');
  return caps;
}

function modelRow(m) {
  var ops = h('div', { class: 'fb-row-ops' });
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '探活（只回 HTTP 结论）', onclick: function () { probeModel(m); } }, [svg(ICONS.bolt)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '显示 API Key', onclick: function () { revealModel(m); } }, [svg(ICONS.eye || ICONS.about)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '编辑', onclick: function () { editModel(m); } }, [svg(ICONS.edit)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '复制一个', onclick: function () {
    api('/api/models/duplicate', { method: 'POST', body: { index: m.index } }).then(function (r) {
      if (r.ok) { toast('已复制为 ' + r.model.id, 'ok'); loadModels(true); } else toast(r.error || '复制失败', 'error');
    });
  } }, [svg(ICONS.plus)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn is-danger', title: '删除', onclick: function () {
    confirmDialog('删除模型', '将从 models.json 里删掉「' + (m.name || m.id) + '」。写前会自动备份原件。', '删除', function () {
      api('/api/models/delete', { method: 'POST', body: { index: m.index } }).then(function (r) {
        if (r.ok) { toast('已删除', 'ok'); loadModels(true); } else toast(r.error || '删除失败', 'error');
      });
    }, true);
  } }, [svg(ICONS.trash)]));

  var top = h('div', { class: 'fb-acct-top' });
  top.appendChild(h('b', { class: 'fb-acct-name', text: m.name || m.id }));
  top.appendChild(h('span', { class: 'fb-badge', text: m.vendor || 'Custom' }));
  if (m.isCustom) top.appendChild(h('span', { class: 'fb-badge is-accent', text: '自定义' }));
  var caps = modelCaps(m);
  for (var i = 0; i < caps.length; i++) top.appendChild(h('span', { class: 'fb-badge is-ok', text: caps[i] }));
  if (m.extraFields && m.extraFields.length) top.appendChild(h('span', { class: 'fb-badge is-warn', text: '+' + m.extraFields.length + ' 字段' }));
  top.appendChild(h('div', { class: 'fb-grow' }));
  append(top, ops);

  var mid = h('div', { class: 'fb-acct-mid' });
  mid.appendChild(h('span', { class: 'fb-mono', text: m.id }));
  mid.appendChild(h('div', { class: 'fb-grow' }));
  mid.appendChild(h('span', { class: 'fb-mono', text: m.keyMasked || '无密钥' }));

  var url = h('div', { class: 'fb-acct-mid' });
  url.appendChild(h('span', { class: 'fb-mono', style: 'font-size:10.5px;color:var(--fb-ink-3)', text: m.url || '（未填接口地址）' }));

  return h('div', { class: 'fb-row is-acct' }, [top, mid, url]);
}

function probeModel(m) {
  toast('正在探测 ' + (m.name || m.id) + '…', 'info');
  api('/api/models/probe', { method: 'POST', body: { index: m.index } }).then(function (r) {
    if (r.ok) toast((r.authorized ? '✓ ' : '· ') + (r.message || '') + (r.status ? '（HTTP ' + r.status + '）' : ''), r.authorized ? 'ok' : 'warn');
    else toast(r.error || '探测失败', 'error');
  });
}

function revealModel(m) {
  api('/api/models/reveal', { method: 'POST', body: { index: m.index } }).then(function (r) {
    if (!r.ok) { toast(r.error || '取不到密钥', 'error'); return; }
    var box = h('div', { class: 'fb-input fb-mono', style: 'word-break:break-all;user-select:all;padding:8px', text: r.apiKey || '（空）' });
    modal({
      title: 'API Key · ' + (r.name || r.id),
      body: h('div', {}, [h('div', { style: 'margin-bottom:8px;color:var(--fb-ink-3)', text: '密钥来自官方 models.json，明文只在你本机显示。' }), box]),
      actions: [{ label: '关闭' }],
    });
  });
}

function modelField(label, value, placeholder, type) {
  var input = h('input', { class: 'fb-input', value: value == null ? '' : value, placeholder: placeholder || '', type: type || 'text' });
  return { el: h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: label }), input]), input: input };
}

function editModel(m) {
  var isNew = !m;
  var src = m || { vendor: 'Custom', supportsToolCall: true, supportsImages: false, supportsReasoning: false };
  var fId = modelField('模型 ID（客户端用它，改了等于换模型）', src.id, 'my-model-id');
  var fName = modelField('显示名称', src.name, '我的模型');
  var fVendor = modelField('厂商', src.vendor || 'Custom', 'Custom');
  var fUrl = modelField('接口地址', src.url, 'https://api.example.com/v1/chat/completions');
  var fKey = modelField('API Key', '', isNew ? 'sk-...' : '留空则保持原密钥不变', 'password');
  var fIn = modelField('最大输入 token（可空）', src.maxInputTokens, '');
  var fOut = modelField('最大输出 token（可空）', src.maxOutputTokens, '');

  function flagRow(label, on) {
    var sw = switchEl(!!on, function () {});
    return h('div', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: label }), sw]);
  }
  var swTool = flagRow('支持工具调用', src.supportsToolCall);
  var swImg = flagRow('支持图片输入', src.supportsImages);
  var swReason = flagRow('支持推理', src.supportsReasoning);

  modal({
    title: isNew ? '新增模型' : '编辑模型 · ' + (src.name || src.id),
    body: h('div', { class: 'fb-form' }, [
      fId.el, fName.el, fVendor.el, fUrl.el, fKey.el, fIn.el, fOut.el, swTool, swImg, swReason,
      h('div', { class: 'fb-field-note', text: isNew ? '写入后需要客户端重新载入配置（或重启）才会出现在模型下拉里。' : '未知字段（例如 ocFerryOwner）会原样保留，不会被覆盖。' }),
    ]),
    actions: [
      { label: '取消' },
      {
        label: isNew ? '新增' : '保存',
        primary: true,
        onClick: function () {
          var payload = {
            id: fId.input.value.trim(),
            name: fName.input.value.trim(),
            vendor: fVendor.input.value.trim() || 'Custom',
            url: fUrl.input.value.trim(),
            supportsToolCall: swTool.querySelector('.fb-switch').classList.contains('is-on'),
            supportsImages: swImg.querySelector('.fb-switch').classList.contains('is-on'),
            supportsReasoning: swReason.querySelector('.fb-switch').classList.contains('is-on'),
          };
          if (fKey.input.value) payload.apiKey = fKey.input.value;
          else if (isNew) payload.apiKey = '';
          if (fIn.input.value) payload.maxInputTokens = Number(fIn.input.value);
          if (fOut.input.value) payload.maxOutputTokens = Number(fOut.input.value);
          api('/api/models/save', { method: 'POST', body: { model: payload, index: isNew ? null : src.index } }).then(function (r) {
            if (r.ok) { toast(isNew ? '已新增' : '已保存', 'ok'); loadModels(true); }
            else { toast(r.error || '保存失败', 'error'); }
          });
        },
      },
    ],
  });
}

function doImportModels() {
  var file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  var replace = h('input', { type: 'checkbox' });
  file.addEventListener('change', function () {
    if (!file.files || !file.files[0]) return;
    var reader = new FileReader();
    reader.onload = function () {
      var content;
      try { content = JSON.parse(String(reader.result)); } catch (e) { toast('文件不是合法 JSON', 'error'); return; }
      api('/api/models/import', { method: 'POST', body: { content: content, replace: replace.checked } }).then(function (r) {
        if (!r.ok) { toast(r.error || '导入失败', 'error'); return; }
        closeModal();
        toast('已新增 ' + r.added + ' 个、更新 ' + r.updated + ' 个', 'ok');
        loadModels(true);
      });
    };
    reader.readAsText(file.files[0]);
  });
  modal({
    title: '导入模型',
    body: h('div', { class: 'fb-form' }, [
      h('div', { class: 'fb-field-note', text: '接受 FreeBuddy 导出的模型文件，或任何「模型数组 / 含 models 数组」的 JSON。同 ID 会按字段合并。' }),
      h('label', { class: 'fb-check' }, [replace, h('span', { text: '先清空现有列表再导入（默认不勾选，只做合并）' })]),
      h('button', { class: 'fb-btn', text: '选择文件…', onclick: function () { file.click(); } }),
    ]),
    actions: [{ label: '取消' }],
  });
}

function viewModels() {
  var m = S.models;
  var head = h('div', { class: 'fb-view-head' }, [
    h('h2', { text: '模型' }),
    h('span', { class: 'fb-sub', text: m && m.ok ? m.count + ' 个自定义模型' : '' }),
    h('div', { class: 'fb-grow' }),
    h('button', { class: 'fb-btn is-sm', onclick: function () { doImportModels(); } }, [svg(ICONS.import), '导入']),
    h('button', { class: 'fb-btn is-sm', onclick: function () {
      api('/api/models/export').then(function (r) {
        if (!r.ok) { toast(r.error || '导出失败', 'error'); return; }
        var blob = new Blob([JSON.stringify(r.content, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = r.filename;
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
        toast('已导出 ' + r.count + ' 个模型（含密钥，请妥善保管）', 'ok');
      });
    } }, [svg(ICONS.export), '导出']),
    h('button', { class: 'fb-btn is-sm is-primary', onclick: function () { editModel(null); } }, [svg(ICONS.plus), '新增']),
    h('button', { class: 'fb-btn is-sm', onclick: function () { loadModels(true); } }, [svg(ICONS.refresh)]),
  ]);

  if (!m) return h('div', { class: 'fb-view' }, [head, h('div', { class: 'fb-empty', text: '正在读取官方模型清单…' })]);

  var parts = [head];
  if (!m.ok && m.error) parts.push(h('div', { class: 'fb-note is-warn' }, [svg(ICONS.warn), m.error]));

  // 默认模型
  var dflt = m.defaultModel || '(未设置)';
  var ids = (m.models || []).map(function (x) { return x.id; });
  var sel = h('select', { class: 'fb-select' });
  sel.appendChild(h('option', { value: '', text: '（保持不变）' }));
  for (var i = 0; i < ids.length; i++) sel.appendChild(h('option', { value: ids[i], text: ids[i] }));
  parts.push(h('div', {}, [secHead('默认模型'), h('div', { class: 'fb-list' }, [
    optionRow('新任务的默认模型', '当前：' + dflt + '。写客户端 settings.json，需要重新载入配置或重启客户端生效。',
      h('div', { style: 'display:flex;gap:6px;align-items:center' }, [sel, h('button', { class: 'fb-btn is-sm', text: '设为默认', onclick: function () {
        if (!sel.value) { toast('先选一个模型', 'warn'); return; }
        api('/api/models/default', { method: 'POST', body: { id: sel.value } }).then(function (r) {
          if (r.ok) { toast('已设为默认（' + r.defaultModel + '）', 'ok'); loadModels(true); } else toast(r.error || '设置失败', 'error');
        });
      } })]),
    )]), ]));

  // 模型列表
  var list = h('div', { class: 'fb-list' });
  if (!(m.models || []).length) {
    list.appendChild(h('div', { class: 'fb-empty', text: '还没有自定义模型。点右上角「新增」加一个，或用「导入」搬一份进来。' }));
  } else {
    for (var k = 0; k < m.models.length; k++) list.appendChild(modelRow(m.models[k]));
  }
  parts.push(h('div', {}, [secHead('模型清单', m.count + ' 个'), list]));

  if (m.backups) parts.push(h('div', { class: 'fb-note' }, [svg(ICONS.about), '每次写 models.json 前都会在数据目录的 models-backup/ 里留一份原件（当前 ' + m.backups + ' 份）。']));
  parts.push(h('div', { class: 'fb-note' }, [svg(ICONS.about), '文件：' + (m.file || '—')]));

  return h('div', { class: 'fb-view' }, parts);
}

/* ───────── 视图：会话 ───────── */

function loadSessions(force) {
  return api('/api/sessions?limit=400').then(function (r) {
    if (r.ok) { S.sessions = r; render(); }
    else { S.sessions = { ok: false, error: r.error, sessions: [] }; render(); }
    return r;
  }).catch(function () {});
}

function fmtTime(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  var p2 = function (n) { return String(n).padStart(2, '0'); };
  var now = new Date();
  var sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return '今天 ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  return (d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function sessionRow(s) {
  var ops = h('div', { class: 'fb-row-ops' });
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '从某条消息分支', onclick: function () { openForkDialog(s); } }, [svg(ICONS.fork)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '迁移到别的工作区', onclick: function () { openCopyDialog(s); } }, [svg(ICONS.export)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '重命名', onclick: function () { openRenameDialog(s); } }, [svg(ICONS.edit)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '打开记录文件', onclick: function () { openPath(s); } }, [svg(ICONS.folder)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn is-danger', title: '删除会话', onclick: function () { deleteSession(s); } }, [svg(ICONS.trash)]));

  var top = h('div', { class: 'fb-acct-top' });
  top.appendChild(h('b', { class: 'fb-acct-name', text: s.title || '(无标题)' }));
  if (s.background) top.appendChild(h('span', { class: 'fb-badge is-warn', text: '自动化' }));
  if (!s.hasFile) top.appendChild(h('span', { class: 'fb-badge is-danger', text: '无记录文件' }));
  if (s.status && s.status !== 'completed') top.appendChild(h('span', { class: 'fb-badge', text: s.status }));
  top.appendChild(h('div', { class: 'fb-grow' }));
  append(top, ops);

  var mid = h('div', { class: 'fb-acct-mid' });
  mid.appendChild(h('span', { class: 'fb-mono', text: String(s.id).slice(0, 8) }));
  if (s.model) mid.appendChild(h('span', { text: '· ' + s.model }));
  if (s.fileSize) mid.appendChild(h('span', { text: '· ' + fmtBytes(s.fileSize) }));
  mid.appendChild(h('div', { class: 'fb-grow' }));
  mid.appendChild(h('span', { text: fmtTime(s.lastActivityAt || s.updatedAt) }));

  var bot = h('div', { class: 'fb-acct-mid' });
  bot.appendChild(h('span', { class: 'fb-mono', style: 'font-size:10.5px;color:var(--fb-ink-3)', text: s.cwd || '（云端会话，无工作目录）' }));

  return h('div', { class: 'fb-row is-acct' }, [top, mid, bot]);
}

function openPath(s) {
  api('/api/sessions/detail?id=' + encodeURIComponent(s.id)).then(function (r) {
    if (!r.ok || !r.file) { toast('这个会话没有本机记录文件', 'warn'); return; }
    toast(r.file, 'info');
    api('/api/open-path', { method: 'POST', body: { path: r.file } });
  });
}

function deleteSession(s) {
  confirmDialog(
    '删除会话',
    '会从本机删掉「' + (s.title || s.id) + '」的记录文件、附属目录和数据库索引行。这一步**不可恢复**（官方云端副本不受影响）。',
    '删除',
    function () {
      api('/api/sessions/delete', { method: 'POST', body: { ids: [s.id] } }).then(function (r) {
        if (r.ok) { toast('已删除', 'ok'); loadSessions(true); } else toast((r.error || '删除失败'), 'error');
      });
    },
    true,
  );
}

function openRenameDialog(s) {
  var input = h('input', { class: 'fb-input', value: s.customTitle || s.baseTitle || s.title || '' });
  modal({
    title: '重命名会话',
    body: h('div', { class: 'fb-form' }, [input, h('div', { class: 'fb-field-note', text: '写的是 custom_title（自定义标题），客户端的原标题保留不动。' })]),
    actions: [
      { label: '取消' },
      { label: '保存', primary: true, onClick: function () {
        api('/api/sessions/rename', { method: 'POST', body: { id: s.id, title: input.value.trim() } }).then(function (r) {
          if (r.ok) { toast('已重命名', 'ok'); loadSessions(true); } else toast(r.error || '重命名失败', 'error');
        });
      } },
    ],
  });
}

function openCopyDialog(s) {
  var wss = (S.sessions && S.sessions.workspaces) || [];
  var sel = h('select', { class: 'fb-select' });
  sel.appendChild(h('option', { value: '', text: '（保持原工作区）' }));
  for (var i = 0; i < wss.length; i++) {
    if (!wss[i].cwd) continue;
    sel.appendChild(h('option', { value: wss[i].cwd, text: wss[i].cwd }));
  }
  var custom = h('input', { class: 'fb-input', placeholder: '或直接填一个绝对路径，例如 D:\\proj\\demo' });
  modal({
    title: '迁移会话',
    body: h('div', { class: 'fb-form' }, [
      h('div', { class: 'fb-field-note', text: '复制出一份新会话（新 ID、新记录文件、附属目录一起搬），原会话一个字节都不动。' }),
      h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '目标工作区（已有）' }), sel]),
      h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '或新的工作目录' }), custom]),
    ]),
    actions: [
      { label: '取消' },
      { label: '迁移', primary: true, onClick: function () {
        var targetCwd = custom.value.trim() || sel.value || '';
        api('/api/sessions/copy', { method: 'POST', body: { id: s.id, targetCwd: targetCwd } }).then(function (r) {
          if (r.ok) { toast('已迁移到 ' + (r.cwd || '原工作区') + '（新会话 ' + String(r.id).slice(0, 8) + '）', 'ok'); loadSessions(true); }
          else toast(r.error || '迁移失败', 'error');
        });
      } },
    ],
  });
}

function openForkDialog(s) {
  var box = h('div', { class: 'fb-anchors' }, [h('div', { class: 'fb-empty', text: '正在读取会话记录…' })]);
  var chosen = null;
  modal({
    title: '分支会话 · ' + (s.title || s.id).slice(0, 40),
    body: h('div', {}, [
      h('div', { class: 'fb-field-note', style: 'margin-bottom:8px', text: '选一条消息作为分叉点：新会话只保留到这条回复为止，后面的不带过去，原会话不变。' }),
      box,
    ]),
    actions: [
      { label: '取消' },
      { label: '末尾整份复制', onClick: function () {
        api('/api/sessions/fork', { method: 'POST', body: { id: s.id, latest: true, title: s.title } }).then(function (r) {
          if (r.ok) { toast('已复制（' + r.keptRecords + ' 条记录）', 'ok'); loadSessions(true); } else toast(r.error || '分支失败', 'error');
        });
      } },
      { label: '保留到这条为止', primary: true, disabled: true, keepOpen: true, onClick: function () {
        if (!chosen) return;
        api('/api/sessions/fork', { method: 'POST', body: { id: s.id, anchor: chosen, title: s.title } }).then(function (r) {
          if (r.ok) { closeModal(); toast('已分支：保留 ' + r.keep + ' 条、丢弃 ' + r.drop + ' 条', 'ok'); loadSessions(true); }
          else toast(r.error || '分支失败（已原样回报原因，不会猜位置）', 'error');
        });
      } },
    ],
  });
  // 选到锚点后才把主按钮放开（modal 的 actions 由我们自己接管那块按钮）
  var acts = modalEl && modalEl.querySelector('.fb-modal-actions');
  var real = acts ? acts.querySelectorAll('.fb-btn')[acts.querySelectorAll('.fb-btn').length - 1] : null;
  api('/api/sessions/detail?id=' + encodeURIComponent(s.id)).then(function (r) {
    if (!r.ok) { clear(box).appendChild(h('div', { class: 'fb-empty', text: r.error || '读不到记录' })); return; }
    if (!r.anchors || !r.anchors.length) { clear(box).appendChild(h('div', { class: 'fb-empty', text: '这个会话没有可分叉的消息' })); return; }
    clear(box);
    if (r.summary) box.appendChild(h('div', { class: 'fb-field-note', text: '共 ' + r.summary.records + ' 条记录 / ' + r.anchors.length + ' 个锚点' }));
    for (var i = 0; i < r.anchors.length; i++) {
      (function (a) {
        var row = h('button', { class: 'fb-anchor', onclick: function () {
          chosen = a.n;
          var kids = box.querySelectorAll('.fb-anchor');
          for (var j = 0; j < kids.length; j++) kids[j].classList.remove('is-on');
          row.classList.add('is-on');
          if (real) real.removeAttribute('disabled');
        } }, [
          h('span', { class: 'fb-anchor-n', text: '#' + a.n }),
          h('span', { class: 'fb-anchor-r', text: a.role === 'user' ? '我' : 'AI' }),
          h('span', { class: 'fb-anchor-t', text: String(a.text || '').replace(/\s+/g, ' ').slice(0, 70) }),
        ]);
        box.appendChild(row);
      })(r.anchors[i]);
    }
    if (real) real.setAttribute('disabled', '');
  });
}

function doExportSessions() {
  var input = h('input', { class: 'fb-input', type: 'password', placeholder: '设置一个导出密码' });
  modal({
    title: '导出会话',
    body: h('div', { class: 'fb-form' }, [
      h('div', { class: 'fb-field-note', text: '把本机全部会话（记录文件 + 附属目录 + 索引行）打成一个 AES-256-GCM 加密包，便于换机器。单个包上限 48 MB。' }),
      input,
    ]),
    actions: [
      { label: '取消' },
      { label: '导出', primary: true, onClick: function () {
        if (!input.value) { toast('请输入密码', 'error'); return; }
        var ids = (S.sessions && S.sessions.sessions || []).map(function (x) { return x.id; });
        api('/api/sessions/export', { method: 'POST', body: { ids: ids, password: input.value } }).then(function (r) {
          if (!r.ok) { toast(r.error || '导出失败', 'error'); return; }
          var blob = new Blob([JSON.stringify(r.content)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = r.filename;
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
          toast('已导出 ' + r.count + ' 个会话（' + fmtBytes(r.bytes) + '）', 'ok');
        });
      } },
    ],
  });
}

function doImportSessions() {
  var file = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  var pwd = h('input', { class: 'fb-input', type: 'password', placeholder: '导出时设置的密码' });
  file.addEventListener('change', function () {
    if (!file.files || !file.files[0]) return;
    var reader = new FileReader();
    reader.onload = function () {
      var content;
      try { content = JSON.parse(String(reader.result)); } catch (e) { toast('文件不是合法 JSON', 'error'); return; }
      api('/api/sessions/import', { method: 'POST', body: { content: content, password: pwd.value } }).then(function (r) {
        if (!r.ok) { toast(r.error || '导入失败', 'error'); return; }
        closeModal();
        toast('已导入 ' + r.imported + ' 个会话' + (r.failed && r.failed.length ? '，' + r.failed.length + ' 个失败' : ''), 'ok');
        loadSessions(true);
      });
    };
    reader.readAsText(file.files[0]);
  });
  modal({
    title: '导入会话',
    body: h('div', { class: 'fb-form' }, [
      h('div', { class: 'fb-field-note', text: '选一个 FreeBuddy 导出的会话包，输入当时的密码。导入会分配新 ID，不覆盖本机已有会话。' }),
      pwd,
      h('button', { class: 'fb-btn', text: '选择文件…', onclick: function () { file.click(); } }),
    ]),
    actions: [{ label: '取消' }],
  });
}

function viewSessions() {
  var data = S.sessions;
  var head = h('div', { class: 'fb-view-head' }, [
    h('h2', { text: '会话' }),
    h('span', { class: 'fb-sub', text: data && data.ok ? data.total + ' 个会话' : '' }),
    h('div', { class: 'fb-grow' }),
    h('button', { class: 'fb-btn is-sm', onclick: function () { doImportSessions(); } }, [svg(ICONS.import), '导入']),
    h('button', { class: 'fb-btn is-sm', onclick: function () { doExportSessions(); } }, [svg(ICONS.export), '导出']),
    h('button', { class: 'fb-btn is-sm', onclick: function () { loadSessions(true); } }, [svg(ICONS.refresh)]),
  ]);

  if (!data) return h('div', { class: 'fb-view' }, [head, h('div', { class: 'fb-empty', text: '正在读取会话索引…' })]);
  var parts = [head];
  if (!data.ok && data.error) parts.push(h('div', { class: 'fb-note is-warn' }, [svg(ICONS.warn), data.error]));

  var all = data.sessions || [];
  var wss = data.workspaces || [];
  var wsSel = h('select', { class: 'fb-select' });
  wsSel.appendChild(h('option', { value: '', text: '全部工作区' }));
  for (var i = 0; i < wss.length; i++) {
    if (!wss[i].cwd) continue;
    wsSel.appendChild(h('option', { value: wss[i].cwd, text: wss[i].cwd }));
  }
  wsSel.value = S.sessWs || '';
  wsSel.addEventListener('change', function () { S.sessWs = wsSel.value; render(); });
  function doSearch() {
    var v = q.value.trim();
    if (v === S.sessQuery) return;
    S.sessQuery = v;
    api('/api/sessions?limit=800&q=' + encodeURIComponent(v)).then(function (r) {
      if (r.ok) { S.sessions = r; render(); }
    });
  }
  var q = h('input', { class: 'fb-input', placeholder: '搜索标题 / ID / 路径', value: S.sessQuery || '' });
  q.addEventListener('change', doSearch);
  q.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });

  var shown = all.filter(function (s) {
    if (S.sessWs && (s.cwd || '') !== S.sessWs) return false;
    return true;
  });
  var bg = shown.filter(function (s) { return s.background; }).length;

  parts.push(h('div', { class: 'fb-tools' }, [q, wsSel]));
  parts.push(h('dl', { class: 'fb-stats' }, [
    stat('会话', String(all.length) + ' 个'),
    stat('当前筛选', String(shown.length) + ' 个'),
    stat('自动化会话', String(bg) + ' 个'),
  ]));

  if (!shown.length) {
    parts.push(h('div', { class: 'fb-empty', text: all.length ? '这个筛选下没有会话。' : '还没有会话记录。' }));
  } else {
    var l = h('div', { class: 'fb-list' });
    for (var k = 0; k < shown.length; k++) l.appendChild(sessionRow(shown[k]));
    parts.push(h('div', {}, [secHead('会话列表', shown.length + ' 个'), l]));
  }
  if (data.db && data.db.ok) parts.push(h('div', { class: 'fb-note' }, [svg(ICONS.about), '索引库：' + data.db.dbPath + ' · 分支/迁移直接写这张表，官方客户端下次刷新即读到。']));
  else if (data.db) parts.push(h('div', { class: 'fb-note is-warn' }, [svg(ICONS.warn), '索引库不可读写：' + (data.db.error || '未知原因')]));
  return h('div', { class: 'fb-view' }, parts);
}

/* ───────── 视图：自动化任务 ───────── */

function loadTasks(force) {
  return api('/api/automations').then(function (r) {
    if (r.ok) { S.tasks = r.tasks || []; S.runs = r.runs || []; S.templates = r.templates || []; S.tasksDb = r.db || null; render(); }
    else { S.tasks = []; S.taskError = r.error; render(); }
    return r;
  }).catch(function () {});
}

var WD = [['MO', '一'], ['TU', '二'], ['WE', '三'], ['TH', '四'], ['FR', '五'], ['SA', '六'], ['SU', '日']];

function taskStateText(t) {
  if (!t.nextRunAt) return '未排期';
  return '下次 ' + fmtTime(t.nextRunAt);
}

function taskRow(t) {
  var ops = h('div', { class: 'fb-row-ops' });
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '立即执行', onclick: function () { runTask(t); } }, [svg(ICONS.play)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: t.status === 'ACTIVE' ? '暂停' : '启用', onclick: function () { toggleTask(t); } }, [svg(t.status === 'ACTIVE' ? ICONS.pause : ICONS.play)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn', title: '编辑', onclick: function () { editTask(t); } }, [svg(ICONS.edit)]));
  ops.appendChild(h('button', { class: 'fb-icon-btn is-danger', title: '删除', onclick: function () {
    confirmDialog('删除任务', '删掉「' + t.name + '」。任务由客户端调度器执行，删掉后就立即停止排期。', '删除', function () {
      api('/api/automations/delete', { method: 'POST', body: { ids: [t.id] } }).then(function (r) {
        if (r.ok) { toast('已删除', 'ok'); loadTasks(true); } else toast(r.error || '删除失败', 'error');
      });
    }, true);
  } }, [svg(ICONS.trash)]));

  var top = h('div', { class: 'fb-acct-top' });
  top.appendChild(h('b', { class: 'fb-acct-name', text: t.name }));
  top.appendChild(h('span', { class: 'fb-badge ' + (t.status === 'ACTIVE' ? 'is-ok' : ''), text: t.status === 'ACTIVE' ? '启用' : '已暂停' }));
  if (t.running) top.appendChild(h('span', { class: 'fb-badge is-accent', text: '运行中' }));
  if (t.ownerStatus === 'freebuddy' || t.ownerSource === 'freebuddy') top.appendChild(h('span', { class: 'fb-badge', text: 'FreeBuddy 建' }));
  top.appendChild(h('div', { class: 'fb-grow' }));
  append(top, ops);

  var mid = h('div', { class: 'fb-acct-mid' });
  mid.appendChild(h('span', { text: t.description || '' }));
  mid.appendChild(h('div', { class: 'fb-grow' }));
  mid.appendChild(h('span', { class: 'fb-mono', text: taskStateText(t) }));
  if (t.modelId) mid.appendChild(h('span', { text: '· ' + t.modelId }));

  var bot = h('div', { class: 'fb-acct-mid' });
  bot.appendChild(h('span', { style: 'font-size:10.5px;color:var(--fb-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%', text: (t.prompt || '').replace(/\s+/g, ' ').slice(0, 110) }));
  if (t.lastError) bot.appendChild(h('span', { class: 'fb-badge is-danger', text: '上次出错' }));

  return h('div', { class: 'fb-row is-acct' + (t.status === 'ACTIVE' ? ' is-current' : '') }, [top, mid, bot]);
}

function runTask(t) {
  api('/api/automations/run', { method: 'POST', body: { id: t.id } }).then(function (r) {
    if (r.ok) { toast('已排入队列，客户端调度器下一跳执行', 'ok'); setTimeout(function () { loadTasks(true); }, 4000); }
    else toast(r.error || '排入失败', 'error');
  });
}

function toggleTask(t) {
  var next = t.status !== 'ACTIVE';
  api('/api/automations/toggle', { method: 'POST', body: { id: t.id, enabled: next } }).then(function (r) {
    if (r.ok) { toast(next ? '已启用' : '已暂停', 'ok'); loadTasks(true); } else toast(r.error || '操作失败', 'error');
  });
}

function editTask(t, preset) {
  var src = t || preset || { status: 'ACTIVE', scheduleType: 'recurring', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', cwds: [] };
  var fName = modelField('任务名', src.name, '每日简报');
  var prompt = h('textarea', { class: 'fb-textarea', rows: 5, placeholder: '到点要执行的提示词' });
  prompt.value = src.prompt || '';

  // 计划：类型 + 频率 + 参数
  var spec = { freq: 'DAILY', interval: 1, byday: [], bymonthday: [1], byhour: 9, byminute: 0 };
  try {
    var m = /FREQ=([A-Z]+)/.exec(src.rrule || '');
    if (m) {
      spec.freq = m[1];
      var iv = /INTERVAL=(\d+)/.exec(src.rrule);
      spec.interval = iv ? Number(iv[1]) : 1;
      var bd = /BYDAY=([A-Z,]+)/.exec(src.rrule);
      spec.byday = bd ? bd[1].split(',') : [];
      var md = /BYMONTHDAY=([\d,]+)/.exec(src.rrule);
      spec.bymonthday = md ? md[1].split(',').map(Number) : [1];
      var hh = /BYHOUR=(\d+)/.exec(src.rrule);
      spec.byhour = hh ? Number(hh[1]) : 9;
      var mm = /BYMINUTE=(\d+)/.exec(src.rrule);
      spec.byminute = mm ? Number(mm[1]) : 0;
    }
  } catch (e) { /* 用默认 */ }

  var typeSeg = h('div', { class: 'fb-seg' });
  var typeBtns = {};
  ['recurring', 'once'].forEach(function (ty) {
    var b = h('button', { class: src.scheduleType === ty ? 'is-on' : '', text: ty === 'recurring' ? '重复' : '只跑一次' });
    b.addEventListener('click', function () {
      src.scheduleType = ty;
      for (var k in typeBtns) typeBtns[k].classList.remove('is-on');
      b.classList.add('is-on');
      freqWrap.style.display = ty === 'recurring' ? '' : 'none';
      onceWrap.style.display = ty === 'once' ? '' : 'none';
    });
    typeBtns[ty] = b;
    typeSeg.appendChild(b);
  });

  var freqSel = h('select', { class: 'fb-select' });
  [['DAILY', '每天'], ['WEEKLY', '每周'], ['MONTHLY', '每月'], ['HOURLY', '每 N 小时'], ['MINUTELY', '每 N 分钟'], ['YEARLY', '每年']].forEach(function (o) {
    var opt = h('option', { value: o[0], text: o[1] });
    if (spec.freq === o[0]) opt.selected = true;
    freqSel.appendChild(opt);
  });
  var ivInput = h('input', { class: 'fb-input', type: 'number', min: '1', value: String(spec.interval) });
  var hourInput = h('input', { class: 'fb-input', type: 'number', min: '0', max: '23', value: String(spec.byhour) });
  var minInput = h('input', { class: 'fb-input', type: 'number', min: '0', max: '59', value: String(spec.byminute) });
  var mdInput = h('input', { class: 'fb-input', placeholder: '1,15,28', value: spec.bymonthday.join(',') });

  var dayWrap = h('div', { class: 'fb-days' });
  var dayBtns = {};
  WD.forEach(function (d) {
    var b = h('button', { class: 'fb-day' + (spec.byday.indexOf(d[0]) >= 0 ? ' is-on' : ''), text: d[1] });
    b.addEventListener('click', function () {
      var i = spec.byday.indexOf(d[0]);
      if (i >= 0) { spec.byday.splice(i, 1); b.classList.remove('is-on'); }
      else { spec.byday.push(d[0]); b.classList.add('is-on'); }
    });
    dayBtns[d[0]] = b;
    dayWrap.appendChild(b);
  });

  var freqWrap = h('div', { class: 'fb-form' }, [
    h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '频率' }), freqSel]),
    h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '间隔（每 N 个周期）' }), ivInput]),
    h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '每周哪几天' }), dayWrap]),
    h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '每月哪几天' }), mdInput]),
    h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '时刻（时 / 分）' }), h('div', { style: 'display:flex;gap:6px' }, [hourInput, minInput])]),
  ]);
  var onceAt = h('input', { class: 'fb-input', type: 'datetime-local', value: src.scheduledAt || '' });
  var onceWrap = h('div', { class: 'fb-form', style: src.scheduleType === 'once' ? '' : 'display:none' }, [
    h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '执行时刻' }), onceAt]),
  ]);
  if (src.scheduleType !== 'once') freqWrap.style.display = '';

  // 模型（当前账号可用的自定义模型 + 留空用默认）
  var modelSel = h('select', { class: 'fb-select' });
  modelSel.appendChild(h('option', { value: '', text: '（用当前客户端默认模型）' }));
  ((S.models && S.models.models) || []).forEach(function (mm) {
    var opt = h('option', { value: mm.id, text: mm.name + ' · ' + mm.id });
    if (src.modelId === mm.id) opt.selected = true;
    modelSel.appendChild(opt);
  });

  var statSeg = h('div', { class: 'fb-seg' });
  ['ACTIVE', 'PAUSED'].forEach(function (st) {
    var b = h('button', { class: (src.status || 'ACTIVE') === st ? 'is-on' : '', text: st === 'ACTIVE' ? '启用' : '暂停' });
    b.addEventListener('click', function () {
      src.status = st;
      var kids = statSeg.querySelectorAll('button');
      for (var j = 0; j < kids.length; j++) kids[j].classList.remove('is-on');
      b.classList.add('is-on');
    });
    statSeg.appendChild(b);
  });

  modal({
    title: t ? '编辑任务 · ' + t.name : '新建自动化任务',
    body: h('div', { class: 'fb-form' }, [
      fName.el,
      h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '提示词（到点由客户端起一个真实会话执行）' }), prompt]),
      h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '计划' }), typeSeg]),
      freqWrap,
      onceWrap,
      h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '模型' }), modelSel]),
      h('label', { class: 'fb-field' }, [h('span', { class: 'fb-field-label', text: '状态' }), statSeg]),
      h('div', { class: 'fb-field-note', text: '这条任务会写进 WorkBuddy 自己的 automations 表，由它内置的调度器执行 —— 到点会真的开一个会话跑这段提示词，消耗对应模型的额度。' }),
    ]),
    actions: [
      { label: '取消' },
      { label: t ? '保存' : '创建', primary: true, onClick: function () {
        var task = {
          name: fName.input.value.trim(),
          prompt: prompt.value.trim(),
          status: src.status || 'ACTIVE',
          scheduleType: src.scheduleType,
          modelId: modelSel.value || null,
          cwds: src.cwds || [],
        };
        if (src.scheduleType === 'once') {
          if (!onceAt.value) { toast('请选一个执行时刻', 'error'); return; }
          task.scheduledAt = onceAt.value;
        } else {
          var spec2 = {
            freq: freqSel.value,
            interval: Number(ivInput.value) || 1,
            byday: spec.byday,
            bymonthday: mdInput.value.split(',').map(function (x) { return Number(x.trim()); }).filter(function (n) { return n >= 1 && n <= 31; }),
            byhour: [Number(hourInput.value) || 0],
            byminute: [Number(minInput.value) || 0],
          };
          var built;
          try {
            built = buildRrule(spec2);
          } catch (e) {
            toast(String(e.message || e), 'error');
            return;
          }
          task.rrule = built;
        }
        api('/api/automations/save', { method: 'POST', body: { task: task, id: t ? t.id : null } }).then(function (r) {
          if (r.ok) { toast(t ? '已保存' : '已创建', 'ok'); loadTasks(true); }
          else toast(r.error || '保存失败', 'error');
        });
      } },
    ],
  });
}

// 前端也放一份 RRULE 拼装（与后端同一套规则，报错更即时）
function buildRrule(s) {
  var p = ['FREQ=' + s.freq];
  if (s.freq === 'HOURLY' || s.freq === 'MINUTELY') {
    p.push('INTERVAL=' + Math.max(1, s.interval));
    if (s.freq === 'HOURLY' && s.byday && s.byday.length) p.push('BYDAY=' + s.byday.join(','));
    return p.join(';');
  }
  if (s.interval > 1) p.push('INTERVAL=' + s.interval);
  if (s.freq === 'WEEKLY') {
    if (!s.byday || !s.byday.length) throw new Error('每周需要选至少一天');
    p.push('BYDAY=' + s.byday.join(','));
  }
  if (s.freq === 'MONTHLY' || s.freq === 'YEARLY') {
    if (!s.bymonthday || !s.bymonthday.length) throw new Error('需要填每月哪几天');
    p.push('BYMONTHDAY=' + s.bymonthday.join(','));
  }
  p.push('BYHOUR=' + (s.byhour[0] || 0), 'BYMINUTE=' + (s.byminute[0] || 0));
  return p.join(';');
}

function viewTasks() {
  var list = S.tasks || [];
  var head = h('div', { class: 'fb-view-head' }, [
    h('h2', { text: '任务' }),
    h('span', { class: 'fb-sub', text: list.length + ' 个自动化任务' }),
    h('div', { class: 'fb-grow' }),
    h('button', { class: 'fb-btn is-sm', onclick: function () {
      confirmDialog('清空运行记录', '只清理 automation_runs 里的历史记录，不影响任务本身。', '清空', function () {
        api('/api/automations/runs/clear', { method: 'POST' }).then(function (r) {
          if (r.ok) { toast('已清空 ' + r.removed + ' 条', 'ok'); loadTasks(true); } else toast(r.error || '清空失败', 'error');
        });
      });
    } }, [svg(ICONS.trash)]),
    h('button', { class: 'fb-btn is-sm is-primary', onclick: function () { editTask(null); } }, [svg(ICONS.plus), '新建']),
    h('button', { class: 'fb-btn is-sm', onclick: function () { loadTasks(true); } }, [svg(ICONS.refresh)]),
  ]);

  var parts = [head];
  if (S.taskError) parts.push(h('div', { class: 'fb-note is-warn' }, [svg(ICONS.warn), S.taskError]));

  var active = list.filter(function (x) { return x.status === 'ACTIVE'; }).length;
  parts.push(h('dl', { class: 'fb-stats' }, [
    stat('任务', String(list.length) + ' 个'),
    stat('启用中', String(active) + ' 个'),
    stat('运行记录', String((S.runs || []).length) + ' 条'),
  ]));

  // 模板
  if (S.templates && S.templates.length) {
    var chips = h('div', { class: 'fb-chips' });
    S.templates.forEach(function (tpl) {
      chips.appendChild(h('button', { class: 'fb-chip-btn', title: tpl.description, onclick: function () { editTask(null, { name: tpl.name, prompt: tpl.prompt, scheduleType: tpl.scheduleType, scheduledAt: tpl.scheduledAt, rrule: tpl.rrule, status: 'PAUSED' }); } }, [
        svg(ICONS.spark), h('span', { text: tpl.name }),
      ]));
    });
    parts.push(h('div', {}, [secHead('从模板快速开始（先建成暂停态，确认无误再启用）'), h('div', { class: 'fb-list' }, [h('div', { class: 'fb-opt' }, [h('div', { class: 'fb-opt-txt' }, [h('b', { text: '预设模板' }), h('small', { text: '点一下载入模板内容，可再改。' })]), chips])])]));
  }

  var l = h('div', { class: 'fb-list' });
  if (!list.length) l.appendChild(h('div', { class: 'fb-empty', text: '还没有自动化任务。点「新建」，或从上面的模板开始。' }));
  else for (var i = 0; i < list.length; i++) l.appendChild(taskRow(list[i]));
  parts.push(h('div', {}, [secHead('任务列表', list.length + ' 个'), l]));

  // 运行记录
  var runs = S.runs || [];
  if (runs.length) {
    var rl = h('div', { class: 'fb-list' });
    for (var j = 0; j < Math.min(runs.length, 12); j++) {
      (function (r) {
        rl.appendChild(h('div', { class: 'fb-row' }, [
          h('div', { class: 'fb-row-main' }, [
            h('div', { class: 'fb-row-title' }, [h('b', { text: r.automationName || r.title || String(r.automationId).slice(0, 10) })]),
            h('div', { class: 'fb-row-meta' }, [h('span', { text: fmtTime(r.createdAt) + (r.cwd ? ' · ' + r.cwd : '') })]),
          ]),
          h('span', { class: 'fb-badge ' + (r.success === true ? 'is-ok' : r.success === false ? 'is-danger' : ''), title: r.status || '', text: r.success === true ? '成功' : r.success === false ? '失败' : r.status || '—' }),
        ]));
      })(runs[j]);
    }
    parts.push(h('div', {}, [secHead('运行记录', String(runs.length) + ' 条'), rl]));
  }

  parts.push(h('div', { class: 'fb-note' }, [svg(ICONS.about), '这些任务由 WorkBuddy 客户端里常驻的本地调度器执行（automations / automation_runs 两张表），到点会真起一个会话跑提示词。FreeBuddy 只负责读写这张表。']));
  return h('div', { class: 'fb-view' }, parts);
}

/* ───────── 路由与渲染 ───────── */

var TABS = [
  { id: 'accounts', label: '账号', icon: 'accounts' },
  { id: 'usage', label: '用量', icon: 'usage' },
  { id: 'models', label: '模型', icon: 'models' },
  { id: 'sessions', label: '会话', icon: 'sessions' },
  { id: 'tasks', label: '任务', icon: 'tasks' },
  { id: 'enhance', label: '增强', icon: 'enhance' },
  { id: 'power', label: '电脑', icon: 'power' },
  { id: 'about', label: '关于', icon: 'about' },
];

var VIEWS = {
  accounts: viewAccounts,
  usage: viewUsage,
  models: viewModels,
  sessions: viewSessions,
  tasks: viewTasks,
  enhance: viewEnhance,
  power: viewPower,
  about: viewAbout,
};

// 每个页签的数据按需加载（打开页签或强刷时才请求）
function ensureTabData(force) {
  if (S.tab === 'models') {
    if (force || !S.models) return loadModels(force);
  } else if (S.tab === 'sessions') {
    if (force || !S.sessions) return loadSessions(force);
  } else if (S.tab === 'tasks') {
    if (force || !S.tasks) return loadTasks(force);
  }
  return Promise.resolve();
}

function buildRail() {
  var rail = h('nav', { class: 'fb-rail' });
  for (var i = 0; i < TABS.length; i++) {
    (function (t) {
      var item = h('button', {
        class: 'fb-rail-item' + (S.tab === t.id ? ' is-active' : ''),
        'data-tab': t.id,
        title: t.label,
        onclick: function () {
          S.tab = t.id;
          render();
          ensureTabData(true);
        },
      }, [svg(ICONS[t.icon]), h('span', { text: t.label })]);
      rail.appendChild(item);
    })(TABS[i]);
  }
  return rail;
}

function render() {
  if (!panelEl) return;
  if (S.livePort && CFG.uiPort !== S.livePort) CFG.uiPort = S.livePort;

  // 头部账号胶囊
  var chipHost = panelEl.querySelector('.fb-head .fb-chip');
  if (chipHost) {
    clear(chipHost);
    var cur = (S.status && S.status.currentAccount) || null;
    var on = S.status && S.status.cdpConnected;
    append(chipHost, [
      h('i', { class: 'fb-dot' + (on ? '' : ' is-off') }),
      h('b', { text: cur ? (cur.note || cur.nickname || String(cur.uid).slice(0, 8)) : '未登录' }),
      cur && cur.credit !== null && cur.credit !== undefined ? h('span', { text: '· ' + fmtNum(cur.credit) + ' 积分' }) : null,
    ]);
  }

  // 侧栏
  var oldRail = panelEl.querySelector('.fb-rail');
  if (oldRail) oldRail.parentNode.replaceChild(buildRail(), oldRail);

  // 工作区（重建后恢复原来的滚动位置）
  if (bodyEl) {
    var keepScroll = bodyEl.scrollTop;
    clear(bodyEl);
    var fn = VIEWS[S.tab] || viewAccounts;
    try {
      bodyEl.appendChild(fn());
    } catch (e) {
      bodyEl.appendChild(h('div', { class: 'fb-empty', text: '渲染出错：' + (e && e.message) }));
    }
    bodyEl.scrollTop = keepScroll;
  }
  setupNoDisturb();

  if (footEl) {
    clear(footEl);
    append(footEl, [
      h('span', { class: 'fb-mono', text: 'FreeBuddy v' + CFG.version }),
      h('span', { text: '·' }),
      h('span', { text: S.status && S.status.cdpConnected ? '调试通道已连接' : '等待调试通道' }),
      h('div', { class: 'fb-grow' }),
      S.lastError ? h('span', { style: 'color:var(--fb-danger)', text: S.lastError }) : null,
    ]);
  }
}

/* ───────── 状态刷新 ───────── */

function loadTokens(force) {
  return api('/api/token-stats' + (force ? '?force=1' : '')).then(function (r) {
    if (r.ok) { S.tokens = r.stats; render(); }
  }).catch(function () {});
}

function refresh(force) {
  if (!S.tokens || force) loadTokens(false);
  return api('/api/state' + (force ? '?refresh=1' : '')).then(function (r) {
    if (!r.ok) {
      if (r.error && r.error.indexOf('token') >= 0) {
        toast('本地服务令牌不匹配，请重启 FreeBuddy 服务', 'error');
      }
      return;
    }
    S.status = r.status;
    S.accounts = r.accounts || [];
    S.settings = r.settings || {};
    if (r.status && r.status.port) S.livePort = r.status.port;
    render();
    return ensureTabData(!!force);
  });
}

/* ───────── 面板开合 ───────── */

function openPanel() {
  S.open = true;
  panelEl.classList.add('is-open');
  if (bodyEl) bodyEl.scrollTop = 0;
  if (fabEl) fabEl.classList.add('is-hidden');
  refresh();
}

function closePanel() {
  S.open = false;
  panelEl.classList.remove('is-open');
  if (fabEl) fabEl.classList.remove('is-hidden');
}

function togglePanel() {
  if (S.open) closePanel();
  else openPanel();
}

/* ───────── 悬浮球拖动 ───────── */

function setupFabDrag() {
  var KEY = 'freebuddy:fab:' + CFG.profileId;
  var saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch (e) {}
  if (saved && typeof saved.bottom === 'number') fabEl.style.bottom = saved.bottom + 'px';
  if (saved && typeof saved.right === 'number') fabEl.style.right = saved.right + 'px';

  var down = null;
  fabEl.addEventListener('pointerdown', function (e) {
    down = { x: e.clientX, y: e.clientY, moved: false };
    fabEl.classList.add('is-dragging');
    fabEl.setPointerCapture(e.pointerId);
  });
  fabEl.addEventListener('pointermove', function (e) {
    if (!down) return;
    var dx = e.clientX - down.x;
    var dy = e.clientY - down.y;
    if (!down.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
    down.moved = true;
    fabEl.style.right = Math.max(8, window.innerWidth - e.clientX - 20) + 'px';
    fabEl.style.bottom = Math.max(8, window.innerHeight - e.clientY - 20) + 'px';
  });
  fabEl.addEventListener('pointerup', function () {
    fabEl.classList.remove('is-dragging');
    if (down && !down.moved) {
      down = null;
      togglePanel();
      return;
    }
    // 吸附到最近的左右边
    var r = fabEl.getBoundingClientRect();
    var snapRight = r.left + r.width / 2 > window.innerWidth / 2;
    var right = snapRight ? 22 : window.innerWidth - r.left - r.width;
    fabEl.style.right = Math.max(12, right) + 'px';
    fabEl.style.transition = 'right .18s ease';
    setTimeout(function () { fabEl.style.transition = ''; }, 200);
    try {
      localStorage.setItem(KEY, JSON.stringify({ right: parseFloat(fabEl.style.right) || 22, bottom: parseFloat(fabEl.style.bottom) || 22 }));
    } catch (e) {}
    down = null;
  });
}

/* ───────── 挂载 ───────── */

function mount() {
  host = document.createElement('div');
  host.id = 'freebuddy-host';
  (document.body || document.documentElement).appendChild(host);
  shadow = host.attachShadow({ mode: 'open' });

  var styleEl = document.createElement('style');
  styleEl.textContent = FB_CSS;
  shadow.appendChild(styleEl);

  var root = h('div', { class: 'fb-root' });
  // 深浅色：官方多源判定；class 打在 host 上，模态/Toast 才能继承同一套 token
  var dark =
    document.documentElement.classList.contains('cb-dark') ||
    document.documentElement.getAttribute('data-theme') === 'dark' ||
    /dark/i.test((document.body && document.body.getAttribute('data-vscode-theme-name')) || '');
  if (dark) host.classList.add('fb-dark');

  fabEl = h('button', { class: 'fb-fab', title: 'FreeBuddy', 'aria-label': 'FreeBuddy' }, [svg(ICONS.enhance), h('span', { class: 'fb-fab-dot' })]);
  panelEl = h('section', { class: 'fb-panel' });
  toastEl = h('div', { class: 'fb-toasts' });

  append(panelEl, [
    h('header', { class: 'fb-head' }, [
      h('div', { class: 'fb-brand' }, [h('span', { text: 'FreeBuddy' }), h('small', { text: 'v' + CFG.version })]),
      h('div', { class: 'fb-head-spacer' }),
      h('div', { class: 'fb-chip' }),
      h('button', { class: 'fb-icon-btn', title: '刷新', onclick: function () { refresh(true); } }, [svg(ICONS.refresh)]),
      h('button', { class: 'fb-icon-btn', title: '关闭', onclick: closePanel }, [svg(ICONS.close)]),
    ]),
    buildRail(),
    (bodyEl = h('main', { class: 'fb-body' })),
    (footEl = h('footer', { class: 'fb-foot' })),
  ]);

  append(root, [fabEl, panelEl, toastEl]);
  shadow.appendChild(root);

  setupFabDrag();
  setupNoDisturb();
  render();

  // 页面级快捷键：Esc 关面板
  var onKey = function (e) {
    if (e.key === 'Escape') {
      if (modalEl) closeModal();
      else if (S.open) closePanel();
    }
  };
  document.addEventListener('keydown', onKey, true);
  listeners.push(function () { document.removeEventListener('keydown', onKey, true); });

  // 轮询：面板打开时 8 秒一次
  timers.push(
    setInterval(function () {
      if (S.open) refresh();
    }, 8000),
  );

  refresh();
  return true;
}

mount();

return {
  destroy: function () {
    for (var i = 0; i < timers.length; i++) clearInterval(timers[i]);
    for (var j = 0; j < listeners.length; j++) {
      try { listeners[j](); } catch (e) {}
    }
    timers = [];
    listeners = [];
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    shadow = null;
  },
  open: openPanel,
  close: closePanel,
  refresh: refresh,
  state: S,
};
