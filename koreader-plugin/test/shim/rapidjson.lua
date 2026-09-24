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

local function decode(s)
  local pos = 1
  local function skip() while pos <= #s and s:sub(pos,pos):match("%s") do pos = pos + 1 end end
  local parse_value
  local function parse_string()
    pos = pos + 1
    local out = {}
    while true do
      local c = s:sub(pos,pos)
      if c == '"' then pos = pos + 1; break end
      if c == "\\" then
        local n = s:sub(pos+1,pos+1)
        local map = { n='\n', t='\t', r='\r', b='\b', f='\f', ['"']='"', ['\\']='\\', ['/']='/' }
        if map[n] then out[#out+1] = map[n]; pos = pos + 2
        elseif n == 'u' then
          local cp = tonumber(s:sub(pos+2,pos+5), 16) or 63
          if cp < 0x80 then out[#out+1] = string.char(cp)
          elseif cp < 0x800 then out[#out+1] = string.char(0xC0 + math.floor(cp/64), 0x80 + cp%64)
          else out[#out+1] = string.char(0xE0 + math.floor(cp/4096), 0x80 + math.floor(cp/64)%64, 0x80 + cp%64) end
          pos = pos + 6
        else out[#out+1] = n; pos = pos + 2 end
      else out[#out+1] = c; pos = pos + 1 end
    end
    return table.concat(out)
  end
  parse_value = function()
    skip()
    local c = s:sub(pos,pos)
    if c == '{' then
      pos = pos + 1; local t = {}; skip()
      if s:sub(pos,pos) == '}' then pos = pos + 1; return t end
      while true do
        skip(); local k = parse_string(); skip(); pos = pos + 1
        t[k] = parse_value(); skip()
        local d = s:sub(pos,pos); pos = pos + 1
        if d == '}' then break end
      end
      return t
    elseif c == '[' then
      pos = pos + 1; local t = {}; skip()
      if s:sub(pos,pos) == ']' then pos = pos + 1; return t end
      while true do
        t[#t+1] = parse_value(); skip()
        local d = s:sub(pos,pos); pos = pos + 1
        if d == ']' then break end
      end
      return t
    elseif c == '"' then return parse_string()
    elseif s:sub(pos,pos+3) == 'true' then pos = pos + 4; return true
    elseif s:sub(pos,pos+4) == 'false' then pos = pos + 5; return false
    elseif s:sub(pos,pos+3) == 'null' then pos = pos + 4; return nil
    else
      local num = s:match("^%-?%d+%.?%d*[eE]?[%+%-]?%d*", pos)
      pos = pos + #num
      return tonumber(num)
    end
  end
  return parse_value()
end

return { encode = encode, decode = decode }
