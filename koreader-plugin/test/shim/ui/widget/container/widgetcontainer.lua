local WC = {}; WC.__index = WC
function WC:extend(o)
  o = o or {}; o.__index = o
  return setmetatable(o, { __index = self })
end
return WC
