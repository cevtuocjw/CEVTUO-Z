-- Assertions for the CEVTUO CAPPERR KOReader plugin.
--
-- ⚠️ This runs the plugin's REAL code against a REAL sqlite3 database with the
-- schema KOReader's Statistics plugin creates. What is faked is only the
-- surroundings: KOReader's UI modules, and ljsqlite3 itself (shimmed over the
-- sqlite3 CLI, faithfully enough that INTEGER columns come back as
-- cdata<int64_t> exactly as the real binding returns them).
--
-- It cannot prove the plugin works on a Kindle. It does prove the thing that
-- actually bit us: the SQL, the row-walking API, and the number handling.
local SHIM   = assert(os.getenv("CAPPERR_SHIM"),     "CAPPERR_SHIM not set")
local PLUGIN = assert(os.getenv("CAPPERR_PLUGIN"),   "CAPPERR_PLUGIN not set")
local WORK   = assert(os.getenv("CAPPERR_WORK"),     "CAPPERR_WORK not set")
local mode   = (arg and arg[1]) or "main"

package.path = SHIM .. "/?.lua;" .. SHIM .. "/?/init.lua;" .. package.path

local passes, fails = 0, {}
local function check(cond, label, extra)
  if cond then passes = passes + 1
  else fails[#fails + 1] = label .. (extra ~= nil and ("   <got: " .. tostring(extra) .. ">") or "") end
end
local function near(a, b) return type(a) == "number" and math.abs(a - b) < 1e-6 end

local ffi = require("ffi")
-- Negative control: prove the shim really hands back cdata<int64_t>. If it did
-- not, every assertion below about number handling would be testing nothing.
check(tostring(ffi.new("int64_t", 7)) == "7LL",
      "negative control: int64 cdata renders as 7LL", tostring(ffi.new("int64_t", 7)))

local ok, CevtuoCapperr = pcall(dofile, PLUGIN)
if not ok then print("LOAD FAILED: " .. tostring(CevtuoCapperr)) os.exit(1) end
check(type(CevtuoCapperr) == "table", "plugin returns a table")

local inst = setmetatable({ ui = { menu = { registerToMainMenu = function() end } } },
                          { __index = CevtuoCapperr })
local payload, err = inst:buildPayload()

print("=== mode: " .. mode .. " ===")
if not payload then print("buildPayload returned nil, err = " .. tostring(err)) end

if mode == "notime" then
  check(payload == nil, "notime: payload must be nil")
  check(err ~= nil and err:find("total_read_time") ~= nil,
        "notime: error must name the missing total_read_time column", err)
else
  check(payload ~= nil, "payload must be built", err)
  if payload then
    local byid = {}
    for _, b in ipairs(payload.books) do byid[b.id] = b end
    local want_books = (mode == "main") and 5 or 1

    check(#payload.books == want_books, "expected book count", #payload.books)
    check(payload.totals.booksStarted == want_books, "totals.booksStarted", payload.totals.booksStarted)
    check(payload.totals.booksFinished == (mode == "main" and 2 or 0),
          "totals.booksFinished", payload.totals.booksFinished)
    check(payload.totals.readSeconds == (mode == "main" and 57200 or 5000),
          "totals.readSeconds", payload.totals.readSeconds)
    check(payload.totals.pagesTurned == (mode == "main" and 460 or 0),
          "totals.pagesTurned", payload.totals.pagesTurned)
    check(payload.schemaVersion == 1, "schemaVersion")

    -- ⚠️ tostring() on cdata<int64_t> yields "7LL". If a book id ever contains
    -- "LL" the id was never converted to a Lua number.
    for _, b in ipairs(payload.books) do
      check(not b.id:find("LL"), "book id has no LL suffix", b.id)
      check(type(b.pages) == "number" or b.pages == nil, "pages is a Lua number", type(b.pages))
      check(type(b.totalReadTime) == "number", "totalReadTime is a Lua number", type(b.totalReadTime))
      check(b.lastOpen ~= nil, "lastOpen present", b.id)
    end

    if mode == "main" then
      check(#payload.daily == 5, "5 daily buckets", #payload.daily)
      local dsecs = 0
      for _, d in ipairs(payload.daily) do
        dsecs = dsecs + d.s
        check(d.d:match("^%d%d%d%d%-%d%d%-%d%d$") ~= nil, "day key shape", d.d)
      end
      check(dsecs == 3705, "daily seconds sum", dsecs)

      -- The page-0 row is the newest start_time for book 1; if the page>0
      -- guard were missing this would read 0 instead of 83.33.
      check(byid["1"] ~= nil and near(byid["1"].progressPct, 250 / 300 * 100),
            "book 1 progress from last page>0 (83.33)", byid["1"] and byid["1"].progressPct)
      check(byid["2"] and near(byid["2"].progressPct, 100), "book 2 progress 100",
            byid["2"] and byid["2"].progressPct)
      check(byid["3"] and byid["3"].progressPct == nil, "book 3 no page count -> no progress")
      check(byid["4"] and byid["4"].progressPct == nil, "book 4 unread -> no progress")
      check(byid["1"] and byid["1"].series == nil, "book 1 series NULL -> absent")
      check(byid["2"] and byid["2"].series == "Series A", "book 2 series", byid["2"] and byid["2"].series)
      check(byid["1"] and byid["1"].highlights == 5 and byid["1"].notes == 2, "book 1 highlights/notes")
      check(byid["5"] and byid["5"].pages == 400, "book 5 pages", byid["5"] and byid["5"].pages)
      check(byid["5"] and type(byid["5"].lastOpen) == "string", "book 5 NULL last_open -> fallback")
      check(byid["2"] and byid["2"].title == "It's a test", "single quote in title survived",
            byid["2"] and byid["2"].title)
      check(byid["3"] and byid["3"].title == "line1\nline2", "embedded newline in title survived",
            byid["3"] and byid["3"].title)
      check(byid["1"] and byid["1"].title == "深度工作", "non-ASCII title survived",
            byid["1"] and byid["1"].title)
    else -- legacy: no notes / highlights / total_read_pages columns
      check(byid["1"] and byid["1"].highlights == 0, "legacy: missing highlights -> 0",
            byid["1"] and byid["1"].highlights)
      check(byid["1"] and byid["1"].notes == 0, "legacy: missing notes -> 0")
      check(byid["1"] and byid["1"].totalReadPages == 0, "legacy: missing total_read_pages -> 0")
      check(byid["1"] and near(byid["1"].progressPct, 40), "legacy: progress 40",
            byid["1"] and byid["1"].progressPct)
      check(#payload.daily == 1, "legacy: 1 daily bucket", #payload.daily)
    end

    local rj = require("rapidjson")
    local json = rj.encode(payload)
    check(json:find('"books":%[') ~= nil, "books encodes as a JSON array")
    check(json:find("LL") == nil, "no LL leaks into the JSON")
    check(#json > 100, "json is non-trivial")
    local f = io.open(WORK .. "/out_" .. mode .. ".json", "w"); f:write(json); f:close()
  end
end

print(string.format("PASS %d, FAIL %d", passes, #fails))
for _, f in ipairs(fails) do print("  FAIL: " .. f) end
os.exit(#fails == 0 and 0 or 1)
