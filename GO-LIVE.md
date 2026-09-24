# CAPPERR 上线清单

代码这一侧**已经全部完成**。剩下的每一步都需要只有你才有的东西
（GitHub 凭据、阿里云控制台），所以列在这里。

现状：
- 插件：Kindle 上已装，真机导出成功（41 本）
- 转换器 + 页面：完成，126 条插件断言 + 70 条页面断言全过
- 接收端：`services/ingest` 写好，39 条断言全过，**未部署**

---

## ① 推送代码（Mac 上，一条）

```bash
cd ~/Documents/CEVTUO-Z && git push
```

⚠️ `git push` 会被拒一次，因为 `.github/workflows/paperr.yml` 是新文件，
而本机 token **没有 `workflow` scope**。二选一：

- 给 token 加上 **Workflow** 权限（GitHub → Settings → Developer settings →
  Fine-grained tokens → 勾 Workflow），再 push
- 或者在 GitHub 网页上手动建这个文件，然后从仓库里删掉本地那份再 push

---

## ② 建一个 GitHub PAT（接收端用来提交数据）

GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new：

| 项 | 值 |
|---|---|
| Repository access | Only select repositories → **CEVTUO-Z** |
| Permissions → Contents | **Read and write** |
| Permissions → Actions | **不需要**（转换跑在服务器上，不走 Actions） |
| Expiration | 你自己定 |

⚠️ **只给这一个仓库、只给这一个权限。** 这个 token 会放在阿里云那台服务器上，
一旦泄露，破坏范围就是这一个仓库。

---

## ③ 部署到阿里云（一条命令）

阿里云控制台 → 那台 `CEVTUO431` → **远程连接 → Workbench 一键连接 → 立即登录**
（不用密码，走控制台会话）。然后：

```bash
sudo bash -c 'CEVTUO_DEVICE_TOKEN='"$(openssl rand -hex 24)"' \
  CEVTUO_GITHUB_TOKEN=<第②步的 PAT> \
  CEVTUO_ADMIN_PASSWORD=<自己起一个密码> \
  bash <(curl -fsSL https://raw.githubusercontent.com/cevtuocjw/CEVTUO-Z/main/services/ingest/deploy.sh)'
```

⚠️ **把命令跑完后打印出来的那个 `CEVTUO_DEVICE_TOKEN` 抄下来** ——
Kindle 的配置文件要用它。脚本也会在最后再打印一次。

脚本做的事：装 Bun → 克隆仓库 → 建专用非 root 用户 → 写 `.env`(600) →
装 systemd 单元 → 启动 → 自检 `/health`。**可以重复跑**，会更新代码并重启。

⚠️ 服务器**不需要任何 GitHub Actions 或 workflow 配置** —— 转换器就在这台机器上跑。

---

## ④ 防火墙放行 8789

控制台 → 服务器 → **防火墙** → 添加规则：

| 字段 | 值 |
|---|---|
| 应用类型 | 自定义 |
| 协议 | TCP |
| 端口范围 | `8789` |
| 来源 | `0.0.0.0/0` |

⚠️ 因为这台机器在**深圳（大陆）**，域名绑 80/443 需要备案，所以走**裸 IP + 非标准
端口**，不涉及备案。代价是明文 HTTP —— 设备 token 可被嗅探，后果上限是别人能往
统计里塞假数据（拿不到仓库权限）。

---

## ⑤ Kindle 上放配置文件

在 KOReader 设置目录里建 `cevtuo-capperr.conf.json`
（和 `statistics.sqlite3` 同一个目录，即 `/mnt/us/koreader/settings/`）：

```json
{
  "url": "http://120.77.27.128:8789/api/paperr",
  "token": "<第③步的 CEVTUO_DEVICE_TOKEN>",
  "autoOnWifi": true,
  "minIntervalMinutes": 30
}
```

**不用重启 KOReader** —— 事件是常驻注册的，开关在这个文件里实时读。

---

## ⑥ 验证

Kindle 连上 WiFi，等几秒。然后：

- 管理页 `http://120.77.27.128:8789/` 登录后看「设备最后导出」
- 或直接 curl：
  ```bash
  curl -H "Authorization: Bearer <token>" \
       --data-binary @data/paperr/raw-koreader.json \
       http://120.77.27.128:8789/api/paperr
  ```
  `{"status":"committed"}` = 提交了；`"unchanged"` = 阅读数据没变，**这是正常的**
  （插件每次连 WiFi 都推，服务端会自己判断）

---

## 之后

页面地址不变：`https://cevtuo.cjw.github.io/...` → 301 到 `z.cevtuogrnd.com`。
CAPPERR 页面在 `/pages/paperr/index`。
