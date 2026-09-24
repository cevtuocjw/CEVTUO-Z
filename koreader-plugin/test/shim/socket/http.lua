-- luasocket http shim.
--
-- ⚠️ `_setResponse` takes a BODY as well as a status. The plugin reads the
-- server's JSON answer to tell "已保存并重新生成" from "阅读数据没有变化" — and a
-- shim that can only return a code makes that whole path untestable, which is
-- how it went unwritten for so long.
local M = {}
local calls = {}
local resp = { ok = 1, code = 200, body = nil }
M._calls = function() return calls end
M._reset = function() calls = {}; resp = { ok = 1, code = 200, body = nil } end
M._setResponse = function(ok, code, err, body) resp = { ok = ok, code = code, err = err, body = body } end
function M.request(req)
  calls[#calls + 1] = req
  if not resp.ok then return nil, resp.err or "connection refused" end
  -- ⚠️ Feed the sink the way luasocket does, or the plugin's `resp` table stays
  -- empty and every response looks like an unparseable body.
  if resp.body and req.sink then req.sink(resp.body) end
  return 1, resp.code, {}, "OK"
end
return M
