local IM = {}; IM.__index = IM
function IM:new(o) o = o or {}; return setmetatable(o, IM) end
return IM
