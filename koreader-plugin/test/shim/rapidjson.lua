local function esc(s)
  return (s:gsub('[%z\1-\31\\"]', function(c)
    local map = { ['"']='\\"', ['\\']='\\\\', ['\n']='\\n', ['\r']='\\r', ['\t']='\\t', ['\b']='\\b', ['\f']='\\f' }
    return map[c] or string.format("\\u%04x", c:byte())
  end))
end
local function is_array(t)
  local n = 0
  for k in pairs(t) do if type(k) ~= "number" then return false end; n = n + 1 end
  return n == #t and n > 0
end
local encode
encode = function(v)
  local tv = type(v)
  if v == nil then return "null"
  elseif tv == "boolean" then return tostring(v)
  elseif tv == "number" then
    if v ~= v or v == math.huge or v == -math.huge then return "null" end
    return string.format("%.14g", v)
  elseif tv == "string" then return '"' .. esc(v) .. '"'
  elseif tv == "table" then
    if is_array(v) then
      local p = {}; for i = 1, #v do p[i] = encode(v[i]) end
      return "[" .. table.concat(p, ",") .. "]"
    end
    local p = {}
    for k, val in pairs(v) do p[#p+1] = '"' .. esc(tostring(k)) .. '":' .. encode(val) end
    return "{" .. table.concat(p, ",") .. "}"
  end
  return "null"
end
return { encode = encode }
