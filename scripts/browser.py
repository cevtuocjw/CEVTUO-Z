#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CEVTUO-Z 的浏览器操作工具(CDP)。

⚠️ 为什么不用 AppleScript:本机 Chrome 的 AppleScript-JS 被禁用(-1723),
只有 GUI 盲打可用。CDP 能真正读 DOM、点击、截图、看控制台。

⚠️ 为什么不能直接开 --remote-debugging-port:Chrome 136 起禁止对**默认
用户目录**开启调试端口。epub 项目已解决 —— rsync 一份真实 profile(含登录态)
到 state/chrome_user,对着副本开。启动:rss-epub 里的 capture.launch()。

用法:
    python3 scripts/browser.py tabs
    python3 scripts/browser.py go    <url>          # 当前标签页导航(等加载完)
    python3 scripts/browser.py shot  <out.png>
    python3 scripts/browser.py tree                 # 列出可点元素(带 CSS 坐标)
    python3 scripts/browser.py click <selector|CSS x,y>
    python3 scripts/browser.py fill  <selector> <text>
    python3 scripts/browser.py eval  '<js>'
    python3 scripts/browser.py text                 # 正文前 3000 字
"""

import base64
import io
import json
import sys
import time

import requests
import websocket

PORT = 9222
BASE = f"http://127.0.0.1:{PORT}"


class Tab:
    def __init__(self):
        self.ws = None
        self.mid = 0
        self._connect()

    def _connect(self):
        targets = requests.get(BASE + "/json/list", timeout=8).json()
        pages = [t for t in targets if t.get("type") == "page"]
        if not pages:
            pages = [requests.put(BASE + "/json/new?about:blank", timeout=8).json()]
        page = pages[0]
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30)
        self.cmd("Page.enable")
        self.cmd("Runtime.enable")

    def cmd(self, method, params=None, timeout=40):
        self.mid += 1
        i = self.mid
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        self.ws.settimeout(timeout)
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == i:
                return m

    def evaluate(self, expr):
        r = self.cmd("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True,
        })
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return {"__error__": str(res["exceptionDetails"].get("text"))[:200]}
        return (res.get("result") or {}).get("value")

    def goto(self, url, wait=4.0):
        self.cmd("Page.navigate", {"url": url})
        # Poll readyState instead of a flat sleep — pages vary from 0.5s to 8s.
        deadline = time.time() + 30
        while time.time() < deadline:
            time.sleep(0.4)
            try:
                if self.evaluate("document.readyState") == "complete":
                    break
            except Exception:
                pass
        time.sleep(wait)
        return self.evaluate("location.href")

    def shot(self, out):
        r = self.cmd("Page.captureScreenshot", {"format": "png"}, timeout=60)
        d = (r.get("result") or {}).get("data")
        if not d:
            print("截图失败:", json.dumps(r)[:200])
            return 1
        from PIL import Image
        raw = base64.b64decode(d)
        Image.open(io.BytesIO(raw)).save(out)
        # Screenshots are device pixels; clicks need CSS pixels. Report the ratio
        # so a coordinate read off the PNG can be converted reliably.
        iw = self.evaluate("window.innerWidth") or 1280
        sw = Image.open(io.BytesIO(raw)).size[0]
        print(f"已保存: {out} | ratio={sw/iw:.2f} | {self.evaluate('location.href')}")
        return 0

    def ratio(self):
        iw = self.evaluate("window.innerWidth") or 1280
        r = self.cmd("Page.captureScreenshot", {"format": "png"})
        from PIL import Image
        sw = Image.open(io.BytesIO(base64.b64decode(r["result"]["data"]))).size[0]
        return sw / iw

    def click_at(self, x, y):
        for t in ("mousePressed", "mouseReleased"):
            self.cmd("Input.dispatchMouseEvent",
                     {"type": t, "x": x, "y": y, "button": "left", "clickCount": 1})
            time.sleep(0.08)

    def click_text(self, text):
        """Click the first visible element whose text matches. Far more robust
        than coordinates — it does not care where the page scrolled to."""
        js = """
        (() => {
          const want = %s;
          const els = [...document.querySelectorAll('a,button,input,summary,[role=button]')];
          for (const el of els) {
            const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
            if (t.toLowerCase() === want.toLowerCase() && el.offsetParent !== null) {
              el.scrollIntoView({block:'center'}); el.click();
              return {hit: 'exact', text: t};
            }
          }
          for (const el of els) {
            const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
            if (t.toLowerCase().includes(want.toLowerCase()) && el.offsetParent !== null) {
              el.scrollIntoView({block:'center'}); el.click();
              return {hit: 'partial', text: t};
            }
          }
          return {hit: null};
        })()
        """ % json.dumps(text)
        return self.evaluate(js)

    def fill(self, selector, value):
        js = """
        (() => {
          const el = document.querySelector(%s);
          if (!el) return {ok:false, why:'not found'};
          el.focus();
          const setter = Object.getOwnPropertyDescriptor(
            el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            'value').set;
          setter.call(el, %s);
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          return {ok:true, value: el.value};
        })()
        """ % (json.dumps(selector), json.dumps(value))
        return self.evaluate(js)

    def tree(self):
        js = """
        (() => {
          const out = [];
          for (const el of document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=checkbox]')) {
            if (el.offsetParent === null) continue;
            const r = el.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;
            const label = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.name || el.type || '').trim().replace(/\\s+/g,' ').slice(0,70);
            if (!label) continue;
            out.push({tag: el.tagName.toLowerCase(), type: el.type||'', label,
                      x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
                      id: el.id||'', name: el.name||''});
          }
          return out.slice(0, 90);
        })()
        """
        return self.evaluate(js)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    cmd = sys.argv[1]
    t = Tab()

    if cmd == "tabs":
        for x in requests.get(BASE + "/json/list", timeout=8).json():
            if x.get("type") == "page":
                print(x["id"][:8], "|", (x.get("url") or "")[:100])
        return 0
    if cmd == "go":
        print("→", t.goto(sys.argv[2]))
        return 0
    if cmd == "shot":
        return t.shot(sys.argv[2])
    if cmd == "eval":
        print(json.dumps(t.evaluate(sys.argv[2]), ensure_ascii=False)[:4000])
        return 0
    if cmd == "text":
        print(t.evaluate("document.body.innerText.slice(0,3000)"))
        return 0
    if cmd == "tree":
        for e in t.tree() or []:
            print(f"  [{e['tag']}{'/'+e['type'] if e['type'] else ''}] {e['label']!r} @({e['x']},{e['y']}) id={e['id']} name={e['name']}")
        return 0
    if cmd == "click":
        arg = sys.argv[2]
        if "," in arg and arg.replace(",", "").replace(".", "").strip().isdigit():
            x, y = [float(v) for v in arg.split(",")]
            k = t.ratio()
            t.click_at(x / k, y / k)
            print(f"已点击 CSS ({x/k:.0f},{y/k:.0f})")
        else:
            print("点击结果:", t.click_text(arg))
        return 0
    if cmd == "fill":
        print("填写结果:", t.fill(sys.argv[2], sys.argv[3]))
        return 0
    print("未知命令")
    return 1


if __name__ == "__main__":
    sys.exit(main())
