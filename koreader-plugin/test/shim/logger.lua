local function p(...) local t = {}; for i = 1, select("#", ...) do t[i] = tostring((select(i, ...))) end
  io.stderr:write("[log] " .. table.concat(t, " ") .. "\n") end
return { warn = p, info = p, dbg = p, err = p }
