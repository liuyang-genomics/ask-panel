/**
 * Chrome DevTools Protocol transport. Node's built-in WebSocket, no dependencies.
 *
 * One Tab per target, opened and closed per operation, so every site is driven
 * concurrently rather than in sequence.
 */

export class Tab {
  constructor(target) {
    this.target = target;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      }
    };
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('ws failed: ' + this.target.url));
      setTimeout(() => rej(new Error('ws timeout')), 10000);
    });
    await this.unthrottle();
    return this;
  }

  /**
   * DO NOT REMOVE. These tabs are never brought to the front, so Chrome reports
   * document.visibilityState === 'hidden' and throttles rAF, CSS transitions and
   * streaming renders. Two real failures came from exactly that: Claude's send
   * button sat at opacity:0/visibility:hidden forever because its fade-in
   * transition never ran, and ChatGPT finished a response server-side leaving an
   * assistant node with no text in it.
   *
   * Focus emulation makes the renderer treat the tab as visible. It is
   * renderer-side only and does NOT raise or focus the Chrome window.
   */
  async unthrottle() {
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    // Belt and braces: a long-idle background tab can also be frozen outright.
    await this.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(method + ' timeout'));
      }, 30000);
    });
  }

  /** Run a function (passed as source) inside the page with JSON-safe arguments. */
  async eval(fnSource, ...args) {
    const expr = `(${fnSource}).apply(null, ${JSON.stringify(args)})`;
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
    return r.result.value;
  }

  async key(opts) {
    await this.send('Input.dispatchKeyEvent', opts);
  }

  close() { try { this.ws.close(); } catch {} }
}

export async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()).filter((t) => t.type === 'page');
}

/**
 * One tab per site. Sites with no open tab are reported separately rather than
 * dropped: five silent results look exactly like a six-site panel otherwise.
 */
export async function resolveTabs(sites, port, only = []) {
  const list = await targets(port);
  const picked = {};
  const missing = [];
  for (const [key, site] of Object.entries(sites)) {
    if (only.length && !only.includes(key)) continue;
    const hits = list.filter((t) => site.match.test(t.url));
    if (!hits.length) { missing.push(key); continue; }
    // Prefer a tab already inside a conversation over one sitting on the
    // site's landing page, so --continue resumes the thread you were using.
    picked[key] = hits.find((t) => t.url !== site.newUrl && t.url.length > site.newUrl.length + 4) || hits[0];
  }
  return { tabs: picked, missing };
}

export async function withTab(target, fn) {
  const tab = await new Tab(target).connect();
  try { return await fn(tab); } finally { tab.close(); }
}

export const par = (tabs, fn) => Promise.all(Object.entries(tabs).map(([k, t]) => fn(k, t)));
