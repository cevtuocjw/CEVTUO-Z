#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""截图 + 断言工具。

⚠️ 为什么单独写一个:上次我截出一张"惨白"的图并据此改了配色,结果那张图是
Chrome 残留 emulation + 旧标签页缓存渲染出来的假象 —— 真实 DOM 是暗色主题白字。
**截图必须自带校验**,否则它比没有截图更糟:它会让作者基于幻觉做决定。

所以这个脚本每次截图前先读一遍 `document.documentElement.className` 和实际计算
色值,把结果连同图片路径一起打印出来。颜色和主题对不上时,看输出就知道图是假的。

用法:
    uv run --with requests --with websocket-client --with pillow \\
        python3 scripts/shot.py <url> <out.png> [--width N] [--height N] [--theme dark|light]
"""

import argparse
import base64
import io
import json
import sys
import time

import requests
import websocket

CDP = "http://127.0.0.1:9222"


class Page:
    def __init__(self, url, width=None, height=None, theme=None, wait=7.0, scale=1):
        self.s = requests.Session()
        self.s.trust_env = False

        # ⚠️ A FRESH tab every time. Reusing one produced the bogus screenshot:
        # a stale tab keeps its own emulation overrides and cached bundles, so
        # what you capture is not what a new visitor sees.
        self.tab = self.s.put(f"{CDP}/json/new?about:blank", timeout=10).json()
        self.ws = websocket.create_connection(self.tab["webSocketDebuggerUrl"], timeout=120)
        self.mid = 0
        self.cmd("Page.enable")
        self.cmd("Runtime.enable")
        self.cmd("Network.enable")
        self.cmd("Network.setCacheDisabled", {"cacheDisabled": True})

        if width and height:
            self.cmd(
                "Emulation.setDeviceMetricsOverride",
                {
                    "width": width,
                    "height": height,
                    "deviceScaleFactor": scale,
                    "mobile": width < 900,
                },
            )
        if theme:
            # ⚠️ Chrome's emulation overrides `prefers-color-scheme`, which is
            # what the inline script in index.html reads. This is how the light
            # theme gets exercised without changing the OS setting.
            self.cmd("Emulation.setEmulatedMedia", {
                "features": [{"name": "prefers-color-scheme", "value": theme}]
            })

        self.cmd("Page.navigate", {"url": url})
        time.sleep(wait)

    def cmd(self, method, params=None):
        self.mid += 1
        i = self.mid
        self.ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == i:
                return m

    def ev(self, expr):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = r.get("result", {})
        if "exceptionDetails" in res:
            return f"<err {res['exceptionDetails'].get('text')}>"
        return (res.get("result") or {}).get("value")

    def audit(self):
        """Facts that must agree with what the PNG shows."""
        return {
            "url": self.ev("location.href"),
            "html_class": self.ev("document.documentElement.className"),
            "data_page": self.ev("document.documentElement.getAttribute('data-page')"),
            "body_bg": (self.ev("getComputedStyle(document.body).backgroundImage") or "")[:80],
            "text_color": self.ev(
                "(function(){var e=document.querySelector('.stats__value')||document.querySelector('.page__title');"
                "return e?getComputedStyle(e).color:'-'})()"
            ),
            "sections": self.ev("document.querySelectorAll('.section').length"),
            "rail_dots": self.ev("document.querySelectorAll('.rail__dot').length"),
            "stack_h": self.ev("(document.querySelector('.stack')||{}).clientHeight"),
            "scroll_h": self.ev("(document.querySelector('.stack')||{}).scrollHeight"),
            "scroll_top": self.ev("(document.querySelector('.stack')||{}).scrollTop"),
        }

    def shot(self, out):
        r = self.cmd("Page.captureScreenshot", {"format": "png"})
        d = (r.get("result") or {}).get("data")
        if not d:
            print("截图失败:", json.dumps(r)[:200])
            return False
        with open(out, "wb") as f:
            f.write(base64.b64decode(d))
        return True

    def scroll_to_section(self, i):
        """Jump the stack to panel i the way the rail does, so a screenshot of a
        later panel exercises the same code path a tap would."""
        self.ev(
            "(function(){var e=document.querySelector('.stack');"
            f"if(e)e.scrollTop={i}*e.clientHeight;}})()"
        )
        time.sleep(1.2)

    def close(self):
        try:
            self.s.get(f"{CDP}/json/close/{self.tab['id']}", timeout=5)
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("url")
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=390)
    ap.add_argument("--height", type=int, default=844)
    ap.add_argument("--theme", default=None)
    ap.add_argument("--scale", type=int, default=2)
    ap.add_argument("--section", type=int, default=None)
    ap.add_argument("--wait", type=float, default=7.0)
    a = ap.parse_args()

    p = Page(a.url, a.width, a.height, a.theme, a.wait, a.scale)
    if a.section is not None:
        p.scroll_to_section(a.section)

    info = p.audit()
    if p.shot(a.out):
        from PIL import Image

        print(f"图片: {a.out}  {Image.open(a.out).size}")
    print("校验:")
    for k, v in info.items():
        print(f"  {k:12} = {v}")
    p.close()


if __name__ == "__main__":
    sys.exit(main() or 0)
