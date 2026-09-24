-- ⚠️ These are declared with ':' — KOReader calls UIManager:show(...) and
-- UIManager:scheduleIn(...), so the first argument is the module itself. Declare
-- them with '.' and the delay silently becomes UIManager and the callback
-- becomes the delay; the failure looks like nonsense deep inside the stub.
local M = {}
M._scheduled = {}
function M:show() end
function M:scheduleIn(delay, fn) M._scheduled[#M._scheduled + 1] = { delay = delay, fn = fn } end
function M:_runScheduled()
  local list, n = M._scheduled, #M._scheduled
  M._scheduled = {}
  for _, item in ipairs(list) do item.fn() end
  return n
end
return M
