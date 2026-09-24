-- ⚠️ These are declared with ':' — KOReader calls UIManager:show(...) and
-- UIManager:scheduleIn(...), so the first argument is the module itself. Declare
-- them with '.' and the delay silently becomes UIManager and the callback
-- becomes the delay; the failure looks like nonsense deep inside the stub.
local M = {}
M._scheduled = {}
-- ⚠️ Captured, not discarded. The manual export's popup is the ONLY feedback
-- the reader gets, and it is where "阅读数据没有变化" has to appear — the outcome
-- that otherwise looks exactly like a broken sync.
M._shown = {}
function M:show(w) M._shown[#M._shown + 1] = w end
function M:_lastText()
  local w = M._shown[#M._shown]
  if not w then return nil end
  if type(w) == "table" then return w.text end
  return tostring(w)
end
function M:_resetShown() M._shown = {} end
function M:scheduleIn(delay, fn) M._scheduled[#M._scheduled + 1] = { delay = delay, fn = fn } end
function M:_runScheduled()
  local list, n = M._scheduled, #M._scheduled
  M._scheduled = {}
  for _, item in ipairs(list) do item.fn() end
  return n
end
return M
