#!/usr/bin/env bash
#
# CHEALTH 手机端设置 —— 三星健康更新之后跑这个
#
#   bash scripts/chealth-phone-setup.sh            # 交互式，一步步来
#   bash scripts/chealth-phone-setup.sh status     # 只看现状，不动任何东西
#
# ─────────────────────────────────────────────────────────────
# ⚠️⚠️ 为什么会有这个脚本
#
# **国行（CHC）三星健康不往 Health Connect 写数据，即使权限全给了。**
#
# 这不是猜的，是 2026-09-24 在这台 SM-F9660 上量的：
#
#   · 三星健康声明了 33 个 android.permission.health.* 权限
#   · Health Connect 里三星健康的「全部允许」是开的，读写全选
#   · 然后按 dataOrigin 拆开九个数据类型 —— **com.sec.android.app.shealth
#     的记录数是 0。不是少，是没有。**
#
# 三星健康自己的设置里也**没有「Health Connect」这一项**（设置全表扫过）。
# 同一份设置里还有「京ICP备05068163号-86A」—— 中国区特供包。
#
# 所以走的是一条绕路：Health Sync 把三星健康的数据搬进 Health Connect。
# 那条路能用，但有两个代价（都在下面 STATUS 里检查）。
#
# 而 Health Sync 自己的依赖链上又挂着 Google（它有 com.android.vending.BILLING，
# 而且这台机器上是侧载安装的），于是「没 VPN 就一直转圈」。
#
# 把三星健康本身的地区解开，就能把 Health Sync 整条链去掉。
#
# ─────────────────────────────────────────────────────────────
# ⚠️ 改的是三星健康认的地区，不是手机的地区
#
# 手机 CSC 仍然是 CHC。被改的是 Samsung Health 自己那份 CSC/MCC 配置，
# 影响面是三星健康这一个 app 的功能开关（Health Connect 导出就是其中之一）。
#
# ⚠️ 但有一个已知的不确定性，写在最前面：**三星账号是国区、三星健康要认美区。**
# 三星健康可能在某次联网后把地区拉回账号所属地区。这正是这个脚本存在的理由 ——
# 更新之后跑一次，而不是假设它一次就永久生效。
#
# ─────────────────────────────────────────────────────────────
# ✅✅✅ 2026-09-24 16:29 实测：**整条链在没有 VPN 的情况下全线跑通。**
#
#   VPN 确认关闭（无 tun0、无代理进程、到 8.8.8.8 走 wlan0）
#   Health Sync 正常写 Health Connect（九种类型，时间戳 1~2 分钟内）
#   CEVTUO Health 上报 → HTTP 202，4980 字节
#   阿里云心跳 16:29 → gh-pages 上的密文索引 updatedAt = 16:29
#
# ⚠️ 所以**方案 A（改三星健康地区）已经不需要了**。上面那段失败记录保留，
#   不是为了让人再试一遍，是为了说明：这条路走不通**没有关系** ——
#    另外一条路（Health Sync）已经能不要 VPN 了。
#
# ⚠️ 用户自己解决了 Health Sync 的同步方式。具体改了什么我没测出来 ——
#    版本没变（7.9.2.3，2026-09-09 装的），安装来源也没变（侧载）。
#    **这一点要问本人**，因为它决定了这个状态稳不稳、更新后会不会退化。
#
# ─────────────────────────────────────────────────────────────
# ⚠️⚠️ 已知的代价：撤销 Google Fit 之后丢了两个指标
#
# 2026-09-24 我撤销了 Google Fit 在 Health Connect 的读写权限（它全部数据
# 都停在 21.9 小时前、且是 Health Sync 写过的重复）。事后从合并数据里看到：
#
#   · **静息心率** 只来自 com.google.android.apps.fitness（按 dataOrigin 拆开
#     九个类型，RestingHeartRateRecord 只有它一家）。撤销后 09-24 就没有了。
#   · **总消耗**（含基础代谢那个）同样只有它一家，09-24 也没有了。
#
# ⚠️ 活动消耗不受影响 —— Health Sync 在写（今天 186 kcal）。
# ⚠️ 要拿回静息心率，把 Google Fit 的 Health Connect 权限加回去即可（一个开关）。
#    但它自己也是 21.9 小时没更新了，加回去不一定就能活 —— 先测。
#
# ─────────────────────────────────────────────────────────────
# ⚠️⚠️⚠️ 2026-09-24 实测结论：**方案 A 在三星健康 7.00.6.012 上走不通。**
#
# 试过的，全部失败：
#
#   1. 连点版本号 10~15 次
#      → **成功**。关于页出现了两个开发者按钮（旧 SDK 和 Data SDK）。
#        这一步在 7.00.6.012 上仍然有效，只是要连点够快够多次。
#   2. 进入 Developer mode (Samsung Health Data SDK)
#      → 打开「Developer mode」开关（**成功**），但那一页只有
#        App package name / Access code 两个框 —— 那是**写入**用的，
#        要三星合作伙伴审批才拿得到 Access code。**我们没有填。**
#   3. 建三个标记文件夹 /sdcard/Download/SamsungHealth/{FeatureManagerOn,
#      FeatureListOn,CscManagerOn}，强停 + 冷启动三星健康
#      → 关于页**没有**出现 Set Feature。失败。
#   4. 补上媒体扫描（am broadcast MEDIA_SCANNER_SCAN_FILE + content call scan_volume）
#      → 仍然没有。失败。
#   5. 把同样的文件夹放进应用自己的外部目录
#      /sdcard/Android/data/com.sec.android.app.shealth/files/SamsungHealth/
#      （那儿分区存储也读得到）→ 仍然没有。失败。
#
# ⚠️ 根本原因（不是没试够，是有物理障碍）：
#     三星健康 **targetSdk=36**（Android 16），
#     `READ_EXTERNAL_STORAGE: ignore`、`MANAGE_EXTERNAL_STORAGE: default`。
#     它**读不到 /sdcard/Download 下 adb 建的目录**。
#     那套文件夹做法是 Android 10 之前的环境。
#     写这篇教程的人测的是 **6.30.7.004**；XDA 上 2022 年就有人报过
#     「Set Features 已从 6.22 消失」。
#
# ⚠️ 所以下面的 guide 保留，但**别指望它**。真要在新版上解锁地区，
#    已知的路只剩「降级三星健康到 6.x」—— 那是另一件事，风险自负。
# ─────────────────────────────────────────────────────────────
#
set -euo pipefail

ADB="${ADB:-adb}"
DEVICE="${CEVTUO_PHONE:-}"
SHEALTH="com.sec.android.app.shealth"
HEALTHSYNC="nl.appyhapps.healthsync"

say() { printf '%s\n' "$*" >&2; }
hr() { printf '%s\n' "──────────────────────────────────────────" >&2; }

# ⚠️ 设备可以是无线 adb 的名字，而且这台机器上出现过**同一个手机两条连接**
# （一条 _adb-tls-connect 一条不带的），任何 adb 命令都会因为「多于一个设备」
# 直接失败。所以这里解析出一个名字就固定用它。
pick_device() {
  if [[ -n "$DEVICE" ]]; then printf '%s' "$DEVICE"; return; fi
  local n
  n=$("$ADB" devices | awk 'NR>1 && $2=="device" {print $1}' | head -1)
  [[ -n "$n" ]] || { say "✗ 没有连接的设备。先 adb connect <ip:port>"; exit 1; }
  printf '%s' "$n"
}

D="$(pick_device)"
sh() { "$ADB" -s "$D" shell "$@"; }

# ─────────────────────────────────────────────────────────────

status() {
  hr
  say "设备 $D"
  hr

  local ver
  ver=$(sh "dumpsys package $SHEALTH" 2>/dev/null | grep -m1 versionName | tr -d '\r' | cut -d= -f2)
  say "三星健康版本：${ver:-读不到}"

  local csc
  csc=$(sh getprop ro.csc.sales_code 2>/dev/null | tr -d '\r')
  say "手机 CSC    ：${csc:-?}   （⚠️ 这个不该改，也不归这个脚本管）"

  say ""
  say "三星健康在 Health Connect 里的权限："
  # ⚠️ Health Connect 自己的授权存在它的数据库里，adb 读不到。
  #    所以这里只能读「它声明了什么」，读不到「用户授了什么」——
  #    后者要去 Health Connect → 应用访问权限 里看。
  local n
  n=$(sh "dumpsys package $SHEALTH" 2>/dev/null | grep -oE 'android\.permission\.health\.[A-Z_]+' | sort -u | wc -l | tr -d ' ')
  say "  · 声明的 health.* 权限：${n:-0} 个（33 左右是正常）"

  say ""
  say "Health Sync："
  if sh "pm list packages" 2>/dev/null | grep -q "$HEALTHSYNC"; then
    say "  · 已安装 —— 走的是「三星健康 → Health Sync → Health Connect」绕路"
    say "  · ⚠️ 它是侧载的 Google Play 付费应用（带 com.android.vending.BILLING）。"
    say "    2026-09-24 之前它要有 VPN 才能同步（向 Google 校验会卡住转圈）。"
    say "    ✅ 现在**不要 VPN 也能同步**（同一台机器实测，版本没变）——"
    say "    用户改了什么没测出来，更新之后如果又卡住，回来查这一条。"
    say "  · 后台限制已经是「不受限制」，不用加白名单（实测）"
  else
    say "  · 没装 —— 那三星健康必须自己写 Health Connect（即本脚本的目标态）"
  fi

  say ""
  say "真正的判据只有一条，脚本读不到，要用手机上的 app 看："
  say "  CEVTUO Health → 「②C 各类型的写入方」"
  say "  · 出现 com.sec.android.app.shealth  → 地区已解开 ✅"
  say "  · 只有 healthsync / fitness / android → 地区还是锁的，跑 setup"
  hr
}

# ⚠️ 标记文件夹。教程（xice.cx/posts/openDevOnSamsungHelathCN/）说新版三星健康
# 需要这三个目录才会放出 Set Feature 菜单。
#
# ⚠️⚠️ 但 2026-09-24 在这台机器上**没成功**，而且原因很可能是dead end：
# 三星健康 targetSdk=36（Android 16），受分区存储约束，READ_EXTERNAL_STORAGE
# 是 ignore，MANAGE_EXTERNAL_STORAGE 是 default —— **它根本读不到
# /sdcard/Download 下 shell 建的目录。** 那套做法是 Android 10 之前的环境。
#
# 所以这个函数保留，但**不要指望它**。真正管用的是 Set Feature 那一页。
make_markers() {
  say "▸ 建标记文件夹（教程要求，⚠️ 在新版上可能无效，见脚本注释）"
  for f in FeatureManagerOn FeatureListOn CscManagerOn; do
    sh "mkdir -p /sdcard/Download/SamsungHealth/$f"
  done
  sh "ls /sdcard/Download/SamsungHealth/" | tr -d '\r' | sed 's/^/    /' >&2
}

guide() {
  hr
  say "接下来这几步**得你在手机上点** —— adb 点不准，原因不是手抖："
  say "三星健康那个「关于」页面**在两次读取之间会重排**，同一个"
  say "「版本7.00.6.012」一会儿在 y=802 一会儿在 y=896，脚本按坐标点必然点错。"
  hr
  cat >&2 <<'STEPS'

  ① 三星健康 → 右上角 ⋮ → 设置 → 拉到最后 → 关于三星健康
  ② 连点「版本7.00.6.012」那一行 10 次以上
     ⚠️ 别点到它下面那行蓝色的「京ICP备05068163号-86A」，那是链接
  ③ 出「Developer Mode (Samsung Health Data SDK)」就点进去
     把 **Developer Mode for Data Read** 打开
  ④ 回到关于页，点 **Set Feature**
     · **Common** → CSC Country Code 改成 `US`
     · **MCC Configuration** 改成 `310(US)`
     · **Analytics** → [HA] Server 改成 `DEV`
     · **Data Platform** → Developer Mode 和 Data SDK Developer mode 都打开
  ⑤ 退出，三星健康会要求「强行停止」一次，照做
  ⑥ 重新打开三星健康 —— 会重新问一遍隐私协议，**全部同意**
  ⑦ 这时 设置 里应该出现 **健康连接**，进去把权限给上

STEPS
  hr
  say "⚠️ 2026-09-24 实测：第 ② ③ 步在 7.00.6.012 上**都能成功**"
  say "   （连点后确实出现两个 Developer mode 按钮，开关也能打开）。"
  say ""
  say "⚠️⚠️ 卡住的是第 ④ 步：**Set Feature 根本不出现。**"
  say "   五条路都试过了，见文件顶部那段。所以走到这里就可以停了 ——"
  say "   跑 planb 看退路，别再耗时间在这页上。"
  hr
}

# ─────────────────────────────────────────────────────────────
# 方案 B：地区解不开时，让 Health Sync 那条路别那么脆
# ─────────────────────────────────────────────────────────────
plan_b() {
  hr
  say "方案 B —— 保留 Health Sync，但把它的两个已知毛病压住"
  hr
  say "B1. 后台限制：**不用做，已经是了**。"
  say "    2026-09-24 在 设置 → 电池 → 后台控制 里实测读到："
  say "      Health Sync      不受限制"
  say "      CEVTUO Health    不受限制"
  say "    ⚠️ 我上一轮建议「加进从不休眠名单」是错的 —— 它本来就在。"
  say ""
  say "    ⚠️ 那被冻结是怎么回事？logcat 里确实有"
  say "      FreecessController: FZ reason: Bg / UFZ reason: Packet"
  say "    每隔几秒一次。但**打开 App 时它立刻就同步成功了**（九种类型全写、"
  say "    时间戳 6 分钟内）。所以冻结不是断档的原因 —— 它只是三星的常态，"
  say "    来网络包就解冻。"
  say ""
  say "B2. Google Fit 已经被撤销 Health Connect 权限（2026-09-24 做的）"
  say "    ⚠️ 别去 Health Sync 里关它的目标 —— 它本来就没启用（图标是灰的），"
  say "    那批 fitness 记录是 Google Fit 自己写的"
  say ""
  say "B3. ~~接受 VPN 依赖~~ —— **这条已经作废。**"
  say "    2026-09-24 16:29 实测：VPN 关着，Health Sync 照常写九种类型、"
  say "    CEVTUO Health 照常上报 202、网站照常更新。"
  say "    唯一还挂着 Google 的是**静息心率**和**总消耗** —— 它们只由 Google Fit"
  say "    提供，而 Google Fit 的 Health Connect 权限已被撤销（那批数据是重复的）。"
  say "    要拿回就把那个开关加回去，但 Google Fit 自己也 21.9 小时没更新了。"
  hr
}

# ─────────────────────────────────────────────────────────────

case "${1:-setup}" in
  status)  status ;;
  markers) make_markers ;;
  guide)   guide ;;
  planb)   plan_b ;;
  setup)
    status
    make_markers
    guide
    say ""
    say "做完之后跑：bash scripts/chealth-phone-setup.sh status"
    say "以及手机上 CEVTUO Health →「②C 各类型的写入方」确认"
    ;;
  *)
    say "用法：$0 [status|markers|guide|planb|setup]"
    exit 1
    ;;
esac
