local M = {}
M.TIMEOUT = nil
local calls, resp = {}, { ok = 1, code = 200 }
M._reset = function() calls = {} end
M._calls = function() return calls end
M._setResponse = function(ok, code, err) resp = { ok = ok, code = code, err = err } end
function M.request(req)
  calls[#calls + 1] = req
  if resp.ok then return 1, resp.code, {}, "OK" end
  return nil, resp.err or "connection refused"
end
return M
