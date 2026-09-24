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

print(string.format("PASS %d, FAIL %d", passes, #fails))
for _, x in ipairs(fails) do print("  FAIL: " .. x) end
os.exit(#fails == 0 and 0 or 1)
