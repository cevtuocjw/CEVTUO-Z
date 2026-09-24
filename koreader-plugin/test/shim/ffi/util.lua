local M = {}
function M.template(s, ...)
  local args = { ... }
  return (s:gsub("%%(%d)", function(d) return tostring(args[tonumber(d)]) end))
end
return M
