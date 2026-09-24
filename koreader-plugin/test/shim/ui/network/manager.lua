-- ⚠️ Settable, unlike the real one. The whole battery argument for this plugin
-- rests on the guard `if not NetworkMgr:isConnected() then return end`, so a
-- stub stuck at `false` would make every "does not push while offline" test
-- pass for the wrong reason and the "pushes while online" ones unreachable.
local M = { _connected = false }
function M:isConnected() return M._connected end
function M:_set(v) M._connected = v and true or false end
return M
