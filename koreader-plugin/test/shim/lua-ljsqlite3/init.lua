-- TEST SHIM: ljsqlite3 over the sqlite3 CLI.
-- Faithful to scilua.org/ljsqlite3.html: exec (by column) / rowexec / prepare+step.
-- INTEGER columns come back as cdata<int64_t>, exactly as the real binding does.
local ffi = require("ffi")
local SEP, NL, NULLV = string.char(31), string.char(30), "<<NULL>>"
local M = {}
local function q(s) return "'" .. tostring(s):gsub("'", "'\\''") .. "'" end

local function run_sql(path, sql)
  local errf = os.tmpname()
  local cmd = "sqlite3 -batch -header -separator " .. q(SEP) .. " -newline " .. q(NL)
    .. " -nullvalue " .. q(NULLV) .. " " .. q(path) .. " " .. q(sql) .. " 2> " .. q(errf)
  local p = io.popen(cmd, "r")
  local out = p:read("*a") or ""
  p:close()
  local ef = io.open(errf, "r"); local err = ef and ef:read("*a") or ""
  if ef then ef:close() end; os.remove(errf)
  if err ~= "" then error("sqlite3: " .. err, 0) end
  return out
end

-- ⚠️ Two splitters, on purpose. A field may legitimately be the empty string
-- (`authors` can be ''), so field splitting must keep every piece. A record
-- never is: the CLI terminates the last row, so the piece after the final
-- separator is an artifact and must be dropped — keeping it invents a phantom
-- row of all-NULLs.
local function split_fields(line, sep)
  local t, pos = {}, 1
  while true do
    local i = line:find(sep, pos, true)
    if not i then t[#t+1] = line:sub(pos); break end
    t[#t+1] = line:sub(pos, i - 1); pos = i + 1
  end
  return t
end

local function split_records(out, sep)
  if out == "" then return {} end
  local t = split_fields(out, sep)
  if t[#t] == "" then table.remove(t) end
  return t
end

local function conv(v)
  if v == NULLV then return nil end
  if v:match("^%-?%d+$") then
    local n = tonumber(v); if n then return ffi.new("int64_t", n) end
  end
  if v:match("^%-?%d*%.%d+$") then return tonumber(v) end
  return v
end

local function query(path, sql)
  local recs = split_records(run_sql(path, sql), NL)
  if #recs == 0 then return { names = {}, rows = {} } end
  local names = split_fields(recs[1], SEP)
  local rows = {}
  for i = 2, #recs do
    local vals = split_fields(recs[i], SEP)
    for j = 1, #vals do vals[j] = conv(vals[j]) end
    rows[#rows+1] = vals
  end
  return { names = names, rows = rows }
end

local Conn, Stmt = {}, {}
Conn.__index, Stmt.__index = Conn, Stmt

function M.open(path)
  local f = io.open(path, "r"); if not f then return nil end; f:close()
  return setmetatable({ path = path }, Conn)
end
function Conn:close() self.closed = true end
function Conn:exec(sql)
  local r, res = query(self.path, sql), {}
  for j, nm in ipairs(r.names) do
    local col = {}; for i, row in ipairs(r.rows) do col[i] = row[j] end; res[nm] = col
  end
  for i, row in ipairs(r.rows) do
    local rec = {}; for j = 1, #r.names do rec[j] = row[j] end; res[i] = rec
  end
  if #r.rows == 0 then return nil, 0 end
  return res, #r.rows
end
function Conn:rowexec(sql)
  local r = query(self.path, sql)
  if #r.rows == 0 then return nil end
  local vals = {}
  for j = 1, #r.names do vals[j] = r.rows[1][j] end
  return unpack(vals, 1, #r.names)
end
function Conn:prepare(sql)
  return setmetatable({ res = query(self.path, sql), idx = 0 }, Stmt)
end
function Stmt:step(row, colnames)
  if self.closed then error("statement is closed", 0) end
  self.idx = self.idx + 1
  local rec = self.res.rows[self.idx]
  if not rec then return nil end
  row = row or {}
  for j = 1, #self.res.names do row[j] = rec[j] end
  if colnames then
    for j = 1, #self.res.names do colnames[j] = self.res.names[j] end
    return row, colnames
  end
  return row
end
function Stmt:close() self.closed = true end
function Stmt:reset() self.idx = 0; return self end
function Stmt:bind() return self end
function Stmt:clearbind() return self end
return M
