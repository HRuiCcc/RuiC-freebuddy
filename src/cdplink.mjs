// 自研 CDP 客户端 —— 只依赖 Node 内建能力（fetch + 全局 WebSocket），零 npm 依赖。
// Node 的 WebSocket 不带 Origin 头，正好满足 Electron CDP 服务端的要求。

export async function listTargets(port, timeoutMs = 3000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function probePort(port) {
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!v.ok) return null;
    return await v.json();
  } catch {
    return null;
  }
}

// WorkBuddy 的渲染页目标：type=page 且 URL 指向 app.asar/renderer/index.html
export function pickPageTarget(targets) {
  const pages = targets.filter((t) => t.type === 'page');
  const scored = pages
    .map((t) => {
      const s = `${t.url} ${t.title}`;
      let score = 0;
      if (/app\.asar\/renderer\/index\.html/i.test(t.url)) score += 100;
      if (/^WorkBuddy/i.test(t.title || '')) score += 20;
      if (/devtools|settings|about:blank/i.test(s)) score -= 50;
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.t || null;
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closed = false;
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`CDP ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method) {
        for (const fn of this.listeners.get(msg.method) || []) {
          try {
            fn(msg.params);
          } catch {
            /* 事件回调异常不影响链路 */
          }
        }
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error('CDP 连接已关闭'));
      this.pending.clear();
      for (const fn of this.listeners.get('__close') || []) fn();
    });
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }

  async evaluate(expression, { returnByValue = true, awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue,
      awaitPromise,
      allowUnsafeEvalBlockedByCSP: false,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`页面内异常: ${d.exception?.description || d.text}`);
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

export async function connect(wsUrl, timeoutMs = 8000) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket 连接失败'));
    });
  });
  return new CdpSession(ws);
}

// 连到 profile 对应的 WorkBuddy 渲染进程；成功返回 {session, target, port}
export async function attach(cdpPort) {
  // 客户端可能被别的东西以别的端口重启过，所以按区间扫一遍，而不是只认一个端口
  const ports = [];
  for (let p = cdpPort; p <= cdpPort + 10; p++) ports.push(p);
  ports.push(9333, 9334);
  for (const port of ports) {
    const ver = await probePort(port);
    if (!ver) continue;
    let targets;
    try {
      targets = await listTargets(port);
    } catch {
      continue;
    }
    const target = pickPageTarget(targets);
    if (!target) continue;
    try {
      const session = await connect(target.webSocketDebuggerUrl);
      return { session, target, port };
    } catch {
      continue;
    }
  }
  return null;
}
