-- Assertions for the automatic (on-WiFi) sync path.
--
-- This is the "功能写完没接线" risk this project has been burned by three times:
-- the push code can be perfect and still never run because the event handler was
-- never installed. So this drives the event the device would send.
local SHIM     = assert(os.getenv("CAPPERR_SHIM"),     "CAPPERR_SHIM not set")
local PLUGIN   = assert(os.getenv("CAPPERR_PLUGIN"),   "CAPPERR_PLUGIN not set")
local SETTINGS = assert(os.getenv("CAPPERR_SETTINGS"), "CAPPERR_SETTINGS not set")

package.path = SHIM .. "/?.lua;" .. SHIM .. "/?/init.lua;" .. package.path

local UIManager = require("ui/uimanager")

-- ⚠️ A GLOBAL, because that is how the plugin uses it — KOReader installs
-- `InfoMessage` into `_G`. Without this stub the manual export throws on its
-- first line and the one control the reader actually presses stays untested.
_G.InfoMessage = { new = function(_, o) return o end }
local NetworkMgr = require("ui/network/manager")
local http = require("socket.http")
local rj = require("rapidjson")

local passes, fails = 0, {}
local function check(cond, label, extra)
  if cond then passes = passes + 1
  else fails[#fails + 1] = label .. (extra ~= nil and ("   <got: " .. tostring(extra) .. ">") or "") end
end

local CONF  = SETTINGS .. "/cevtuo-capperr.conf.json"
local STATE = SETTINGS .. "/cevtuo-capperr.state.json"

local function writeConf(t)
  local f = assert(io.open(CONF, "w")); f:write(rj.encode(t)); f:close()
end
local function readState()
  local f = io.open(STATE, "r"); if not f then return nil end
  local raw = f:read("*a"); f:close()
  local ok, st = pcall(rj.decode, raw)
  if ok and type(st) == "table" then return st end
  return nil
end
local function reset() os.remove(CONF); os.remove(STATE) end
-- Returns the timestamp it wrote. ⚠️ os.time() has 1-second resolution, so
-- "after the push the clock moved" cannot be tested by comparing two timestamps
-- taken moments apart — they are legitimately equal. Compare against the value
-- we deliberately aged instead.
local function ageState(seconds)
  local at = os.time() - seconds
  local f = assert(io.open(STATE, "w"))
  f:write(rj.encode({ lastPushAt = at })); f:close()
  return at
end

local CevtuoCapperr = dofile(PLUGIN)
local inst = setmetatable({ ui = { menu = { registerToMainMenu = function() end } } },
                          { __index = CevtuoCapperr })
inst:registerEvents()
check(type(inst.onNetworkConnected) == "function", "registerEvents installs onNetworkConnected")
check(type(inst.onCloseDocument) == "function", "registerEvents installs onCloseDocument");
check(type(inst.onSuspend) == "function", "registerEvents installs onSuspend")

local fired = function() return UIManager:_runScheduled() end
print("=== mode: auto ===")

reset()
inst:_onNetworkConnected()
check(fired() == 0, "no config file -> nothing scheduled")

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t", autoOnWifi = false })
inst:_onNetworkConnected()
check(fired() == 0, "autoOnWifi=false -> nothing scheduled")

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
http._reset(); http._setResponse(1, 200)
inst:_onNetworkConnected()
check(fired() == 1, "configured -> exactly one scheduled task")
check(#http._calls() == 1, "one HTTP push happened", #http._calls())
check(readState() ~= nil and readState().lastPushAt ~= nil, "success records lastPushAt")
local first = readState() and readState().lastPushAt

local req = http._calls()[1]
check(req and req.url == "http://127.0.0.1:9/x", "posts to the configured url", req and req.url)
check(req and req.headers and req.headers["Authorization"] == "Bearer t", "sends the bearer token")
check(http.TIMEOUT == 20, "http timeout is bounded", http.TIMEOUT)

http._reset()
inst:_onNetworkConnected()
check(fired() == 1, "still schedules; the debounce lives inside the task")
check(#http._calls() == 0, "no push inside minIntervalMinutes")
check(readState() and readState().lastPushAt == first, "clock unchanged by a skipped push")

local aged = ageState(31 * 60)
http._reset(); http._setResponse(1, 200)
inst:_onNetworkConnected(); fired()
check(#http._calls() == 1, "pushes again once the interval has passed")
check(readState() and readState().lastPushAt > aged, "clock advances after a later success",
      readState() and readState().lastPushAt)

os.remove(STATE)
http._reset(); http._setResponse(nil, nil, "connection refused")
inst:_onNetworkConnected(); fired()
check(#http._calls() == 1, "failed push was still attempted")
check(readState() == nil, "failed push does NOT move the clock, so the next connect retries")

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t", minIntervalMinutes = 1 })
http._reset(); http._setResponse(1, 200)
inst:_onNetworkConnected(); fired()
ageState(2 * 60)
inst:_onNetworkConnected(); fired()
check(#http._calls() == 2, "minIntervalMinutes=1 allows a push 2 minutes later", #http._calls())

-- ── The other two triggers ─────────────────────────────────
--
-- ⚠️ These close a real hole: `NetworkConnected` fires only when WiFi
-- TRANSITIONS. A reader who joins once and reads for three hours produces no
-- second event, and none of that session leaves the device. The guard that
-- makes this safe is `isConnected` — we never power the radio to sync.
inst.onCloseDocument = inst._onCloseDocument
inst.onSuspend = inst._onSuspend

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
http._reset(); http._setResponse(1, 200)

NetworkMgr:_set(false)
inst:_onCloseDocument()
check(fired() == 0, "close while OFFLINE -> nothing scheduled")
check(#http._calls() == 0, "close while OFFLINE -> no request")

NetworkMgr:_set(true)
inst:_onCloseDocument()
check(fired() == 1, "close while ONLINE -> one scheduled task")
check(#http._calls() == 1, "close while ONLINE -> pushed", #http._calls())
check(readState() ~= nil, "close push recorded the clock")

-- The debounce must apply here too — closing documents is far more frequent
-- than reconnecting, and without it this trigger would fire constantly.
http._reset()
inst:_onCloseDocument(); fired()
check(#http._calls() == 0, "a second close inside the interval does not push")

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
http._reset(); http._setResponse(1, 200)

NetworkMgr:_set(false)
inst:_onSuspend()
check(#http._calls() == 0, "suspend while OFFLINE -> no request")

NetworkMgr:_set(true)
inst:_onSuspend()
check(#http._calls() == 1, "suspend while ONLINE -> pushed WITHOUT a scheduler tick", #http._calls())
check(readState() ~= nil, "suspend push recorded the clock")

-- ⚠️ The suspend path must run SYNCHRONOUSLY. A scheduled callback may never
-- fire — the device is already on its way down — so if this ever regresses to
-- `scheduleIn`, the push silently stops happening on the one trigger that
-- covers "WiFi on all day, device sleeping".
check(fired() == 0, "suspend did NOT go through the scheduler")

-- ⚠️ And it must use the shorter timeout: it blocks the suspend itself.
check(http.TIMEOUT == 8, "suspend uses the short timeout", http.TIMEOUT)

-- autoOnWifi=false must silence these too, not just the WiFi-connect one.
reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t", autoOnWifi = false })
http._reset()
inst:_onCloseDocument(); inst:_onSuspend()
check(fired() == 0 and #http._calls() == 0, "autoOnWifi=false silences close and suspend")

-- ── Startup catch-up ────────────────────────────────────────
--
-- ⚠️ The hole the three events cannot see: KOReader STARTED while already
-- online. NetworkConnected never fires because the radio never went down,
-- CloseDocument and Suspend have not happened yet. That is exactly what
-- happened on 2026-09-24 — the reader installed a plugin, restarted, and
-- nothing was pushed for seventeen minutes.

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
NetworkMgr:_set(true); http._reset(); http._setResponse(1, 200)
inst:scheduleStartupSync()
check(fired() == 1, "startup -> exactly one scheduled task")
check(#http._calls() == 1, "startup online -> one HTTP push", #http._calls())

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t", autoOnWifi = false })
NetworkMgr:_set(true)
inst:scheduleStartupSync()
check(fired() == 0, "startup respects autoOnWifi=false")

reset()
inst:scheduleStartupSync()
check(fired() == 0, "startup with no config -> nothing scheduled")

-- ⚠️ Offline is checked BEFORE the payload is built, not after. Building it is
-- a SQL pass over page_stat_data and the POST that follows blocks the UI
-- thread; offline that is the full HTTP timeout of frozen screen.
reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
NetworkMgr:_set(false); http._reset()
inst:scheduleStartupSync()
check(fired() == 1, "startup offline -> the task is still scheduled")
check(#http._calls() == 0, "startup offline -> but no HTTP happened", #http._calls())

-- ⚠️ Config is read BEFORE scheduling, so an unconfigured device leaves nothing
-- in the scheduler. Deferring only the connectivity check is the point: that is
-- the one fact init cannot know.
reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t", autoOnWifi = false })
NetworkMgr:_set(true)
inst:scheduleStartupSync()
check(fired() == 0, "autoOnWifi=false -> nothing SCHEDULED, not merely a no-op")

-- ⚠️ THE safety property. On a Kindle every document close can be a fresh
-- KOReader process, so `init` is not a rare event. Without the interval guard
-- this would be a push per book, on a device whose whole job is lasting weeks.
reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
NetworkMgr:_set(true); http._reset(); http._setResponse(1, 200)
-- ⚠️ One minute ago is inside whatever the default is — but assert the ORDER of
-- magnitude too, so lowering or raising the default cannot quietly make this
-- pass for the wrong reason.
local interval = tonumber(os.getenv("CAPPERR_INTERVAL") or "15")
check(interval >= 5 and interval <= 60, "default interval is a sane debounce", interval)
ageState(60)   -- one minute ago, inside the default
inst:scheduleStartupSync()
check(fired() == 1, "startup with a recent push -> task still scheduled")
check(#http._calls() == 0, "startup within the interval -> NOTHING pushed", #http._calls())

-- ── The manual export's popup ───────────────────────────────
--
-- ⚠️ This popup is the ONLY feedback the reader gets from a manual push, and
-- the thing it must say is what the SERVER did — not merely that the request
-- succeeded. "阅读数据没有变化" is the outcome that otherwise looks identical to
-- a broken sync: they tap 导出, the popup says 已推送, the site does not move,
-- and there is nothing anywhere saying that was the correct result.

reset(); writeConf({ url = "http://127.0.0.1:9/x", token = "t" })
NetworkMgr:_set(true)

UIManager:_resetShown(); http._reset()
http._setResponse(1, 200, nil, rj.encode({ ok = true, status = 'unchanged', message = '阅读数据没有变化', books = 5 }))
inst:run(true)
local t1 = UIManager:_lastText() or ''
check(t1:find('没有变化') ~= nil, 'popup says the reading did not change', t1)
check(t1:find('网站不会更新') ~= nil, 'popup explains the site will not move', t1)

UIManager:_resetShown(); http._reset()
http._setResponse(1, 200, nil, rj.encode({ ok = true, status = 'committed', message = '已保存并重新生成', books = 5 }))
inst:run(true)
local t2 = UIManager:_lastText() or ''
check(t2:find('网站已更新') ~= nil, 'popup says the site WAS updated', t2)

-- ⚠️ A body that will not parse must not turn a successful push into a failure.
UIManager:_resetShown(); http._reset()
http._setResponse(1, 200, nil, 'not json at all')
inst:run(true)
local t3 = UIManager:_lastText() or ''
check(t3:find('已推送到服务器') ~= nil, 'an unparseable body still reads as a successful push', t3)

-- And the shim's body plumbing is itself worth a negative control.
UIManager:_resetShown(); http._reset()
http._setResponse(nil, nil, 'connection refused')
inst:run(true)
local t4 = UIManager:_lastText() or ''
check(t4:find('connection refused') ~= nil or t4:find('失败') ~= nil,
      'a connection failure still surfaces in the popup', t4)

print(string.format("PASS %d, FAIL %d", passes, #fails))
for _, x in ipairs(fails) do print("  FAIL: " .. x) end
os.exit(#fails == 0 and 0 or 1)
