local M = {}
local function sh(cond)
  local ok = os.execute(cond)
  if type(ok) == "number" then return ok == 0 end
  return ok == true
end
local function isdir(p) return sh("test -d '" .. p .. "'") end
local function isfile(p) local f = io.open(p, "r"); if f then f:close(); return true end; return false end
function M.attributes(p, what)
  if what == "mode" then
    if isdir(p) then return "directory" end
    if isfile(p) then return "file" end
    return nil
  end
  return nil
end
return M
