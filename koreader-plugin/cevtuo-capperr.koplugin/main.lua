--[[
CEVTUO CAPPERR — export KOReader's own reading statistics.

    koreader/plugins/cevtuo-capperr.koplugin/

── What it does ────────────────────────────────────────────────

Reads `statistics.sqlite3` — the database KOReader's own Statistics plugin
maintains — and writes a JSON file the CEVTUO-Z pipeline consumes. Optionally
POSTs the same payload to a URL when the device is online.

── Why this exists rather than an SFTP pull ────────────────────

⚠️ The statistics DB is in WAL mode. Copying `statistics.sqlite3` alone can
read a stale snapshot: recent reads still live in `-wal` and are only folded in
on a checkpoint. Reading it from INSIDE KOReader, through ljsqlite3, in the same
process that owns it, is the only way to be sure the numbers are current. The
SFTP path stays as a fallback for a device that will not run the plugin.

── What it never does ──────────────────────────────────────────

It issues only SELECTs and PRAGMA reads, and writes one JSON file. It does not
change a single reading statistic, and it does not touch Reading Insight or any
other plugin's storage.

⚠️ Precise wording on "never writes": the connection is opened read-write,
because a read-only connection to a WAL database fails when it cannot create the
`-shm` file. SQLite may itself checkpoint the WAL on close. That is SQLite's own
bookkeeping — no row this plugin reads is ever modified.

── ⚠️ The database API is NOT generic lsqlite3 ──────────────────

The first draft of this file queried with `conn:nrows(sql)`. **ljsqlite3 has no
such method.** KOReader's binding is stepelu's ljsqlite3, whose entire query
surface is:

    conn:exec(sql)      -> resultset (BY COLUMN) + nrow
    conn:rowexec(sql)   -> the values of at most one record
    conn:prepare(sql)   -> stmt;  stmt:step(row[, colnames]) walks the records

Verified against <http://scilua.org/ljsqlite3.html> and against KOReader's own
`statistics.koplugin` and `vocabbuilder.koplugin`, which both require the module
as `"lua-ljsqlite3/init"` (not `"ljsqlite3"`) and both iterate with
`prepare`/`step`.

⚠️ And an INTEGER column comes back as `cdata<int64_t>`, not a Lua number. Every
numeric read below goes through `num()`, which is the same `tonumber()` wrap
KOReader's own plugins use.

⚠️ Still UNTESTED ON A DEVICE. What *has* been checked is the data layer: the
SQL below is executed against a synthetic statistics database with the real
schema, under LuaJIT with a cdata-faithful ljsqlite3 shim. Everything outside
that (menu wiring, file paths, network) is still reasoned-about, not run.
]]

local DataStorage = require("datastorage")
local Device = require("device")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local InfoMessage = require("ui/widget/infomessage")
local NetworkMgr = require("ui/network/manager")
local logger = require("logger")
local lfs = require("libs/libkoreader-lfs")
local _ = require("gettext")
local T = require("ffi/util").template

local EXPORT_NAME = "cevtuo-capperr.json"

local CevtuoCapperr = WidgetContainer:extend{
    name = "cevtuo-capperr",
    is_doc_only = false,
}

-- ⚠️ Under the settings dir, BESIDE the database, not in it. `data/paperr/` in
-- the repo is the published copy; this is the device's outbox.
local function settingsDir()
    return DataStorage:getSettingsDir()
end

local function dbPath()
    return settingsDir() .. "/statistics.sqlite3"
end

--- Where the export lands.
--
-- ⚠️ `Device.home_dir` first: it is KOReader's own name for the user-visible
-- partition, and it is set per device (Kindle `/mnt/us`, Kobo `/mnt/onboard`).
-- Hardcoding a device list means guessing which mount is the visible one, and
-- the first draft of this file guessed wrong — it labelled `/mnt/onboard` as
-- Kindle and used `/mnt/sdcard` for the Kobo SD card, which is actually
-- `/mnt/sd`.
--
-- The list below is only a fallback for devices where `home_dir` is nil or
-- unused. It is probed, not assumed: first existing directory wins.
local function outPaths()
    local candidates = {}
    local function add(dir)
        if dir and dir ~= "" then candidates[#candidates + 1] = dir .. "/" .. EXPORT_NAME end
    end

    add(Device.home_dir)
    add("/mnt/us")        -- Kindle
    add("/mnt/onboard")   -- Kobo
    add("/mnt/sd")        -- Kobo, SD card
    add("/mnt/ext1")      -- PocketBook

    for _, p in ipairs(candidates) do
        local dir = p:match("^(.*)/[^/]+$")
        if dir and lfs.attributes(dir, "mode") == "directory" then
            return p
        end
    end
    return settingsDir() .. "/" .. EXPORT_NAME
end

--- SQLite INTEGER arrives as cdata<int64_t>; REAL arrives as a Lua number.
-- Everything numeric goes through here so the rest of the file never has to
-- care which it got. `tonumber` is exactly what KOReader's own plugins do.
local function num(v)
    if v == nil then return nil end
    return tonumber(v)
end

--- Column names that actually exist on a table.
--
-- ⚠️ The statistics schema has grown over KOReader releases — `highlights` and
-- `notes` are not on older databases. Selecting a column that is not there is a
-- hard SQL error, so the whole export would fail on an older device. Probing
-- first means an old DB still exports, just without those two fields.
--
-- ⚠️ Uses `exec`, not a row iterator: `PRAGMA table_info` comes back as a
-- resultset indexed BY COLUMN, so `res.name[i]` is the i-th column name, and
-- `nrow` is returned separately rather than inferred with `#` (which is
-- unreliable the moment a NULL shows up).
local function columnsOf(conn, table_name)
    local cols = {}
    local res, nrow = conn:exec("PRAGMA table_info('" .. table_name .. "');")
    if not res or not res.name then return cols end
    for i = 1, (num(nrow) or 0) do
        local nm = res.name[i]
        if nm then cols[nm] = true end
    end
    return cols
end

--- Walk the records of a query, one at a time.
--
-- ⚠️ There is no `nrows` iterator in ljsqlite3. `prepare` + `step` is the whole
-- row-walking API, and it is what KOReader's own plugins use.
--
-- ⚠️ `step` is handed a FRESH table each time rather than the one it returned
-- before. Reusing it is the documented idiom, but a NULL column binds to nil —
-- which either clears the slot or leaves the previous record's value sitting
-- there, depending on the binding. A fresh table cannot show the old value.
local function eachRow(conn, sql, fn)
    local stmt = conn:prepare(sql)
    if not stmt then return false, "无法准备查询：" .. sql end

    local ok, err = pcall(function()
        local row, names = stmt:step({}, {})
        while row do
            fn(row, names)
            row = stmt:step({})
        end
    end)
    stmt:close()

    if not ok then return false, tostring(err) end
    return true
end

local function isoNow()
    return os.date("%Y-%m-%dT%H:%M")
end

--- Build the payload. Returns `payload, nil` or `nil, err`.
function CevtuoCapperr:buildPayload()
    -- ⚠️ KOReader requires this module as "lua-ljsqlite3/init". The bare
    -- "ljsqlite3" name is what the upstream project calls itself, and the
    -- fallback is here only so a device that somehow ships it under that name
    -- still works. Getting this wrong is not a crash — it is a message saying
    -- KOReader has no SQLite at all, which sends you looking in the wrong place.
    local SQ3
    for _, mod in ipairs({ "lua-ljsqlite3/init", "ljsqlite3" }) do
        local ok, m = pcall(require, mod)
        if ok and m then SQ3 = m break end
    end
    if not SQ3 then
        return nil, _("这个 KOReader 没有带 ljsqlite3，无法读取统计库。")
    end

    local path = dbPath()
    if lfs.attributes(path, "mode") ~= "file" then
        return nil, T(_("找不到统计库：%1\n先在 KOReader 里正常读一本书，统计库才会被创建。"), path)
    end

    -- ⚠️ Default mode is "rwc", and it has to stay that way. A read-only
    -- connection to a WAL database fails outright when it cannot create the
    -- `-shm` file beside it — which is exactly the case on the device this
    -- plugin exists for. No statement issued below writes anything.
    local conn = SQ3.open(path)
    if not conn then
        return nil, T(_("打不开统计库：%1"), path)
    end

    local bookCols = columnsOf(conn, "book")
    if not bookCols.id then
        conn:close()
        return nil, _("统计库里没有 book 表 —— 可能是还没读过书，或版本太旧。")
    end

    -- ── Books ────────────────────────────────────────────────
    -- ⚠️ Only columns that exist. `total_read_time` and `total_read_pages` are
    -- what the dashboard actually reads, so their absence is worth reporting
    -- rather than silently exporting zeros.
    local wanted = {
        "id", "title", "authors", "series", "pages", "last_open",
        "notes", "highlights", "total_read_time", "total_read_pages",
    }
    local select = {}
    for _, c in ipairs(wanted) do
        if bookCols[c] then select[#select + 1] = c end
    end
    if not bookCols.total_read_time then
        conn:close()
        return nil, _("统计库的 book 表里没有 total_read_time —— 这个版本的 KOReader 太旧了。")
    end

    local books, byId = {}, {}
    local total_time, total_pages, finished = 0, 0, 0

    local book_sql = "SELECT " .. table.concat(select, ",") .. " FROM book"
    if bookCols.last_open then book_sql = book_sql .. " ORDER BY last_open DESC" end

    -- ⚠️ `names` maps a numeric slot to its column name. The SELECT list is
    -- built dynamically from whichever columns this database happens to have,
    -- so the slot a column lands in is not fixed — reading `row[1]` would be
    -- reading whatever column came first on THIS device.
    local ok, err = eachRow(conn, book_sql, function(row, names)
        local r = {}
        for i = 1, #names do r[names[i]] = row[i] end

        local pages = num(r.pages)
        local read_pages = num(r.total_read_pages) or 0
        local read_time = num(r.total_read_time) or 0

        -- ⚠️ KOReader marks a book finished at 99%+ and, for a book whose page
        -- count it never learned, treats any reading as finished. The same rule
        -- here, or the two disagree about the same library.
        local done
        if pages and pages > 0 then
            done = read_pages >= pages - 1
        else
            done = read_pages > 0
        end
        if done then finished = finished + 1 end

        total_time = total_time + read_time
        total_pages = total_pages + read_pages

        local id = num(r.id)
        local b = {
            -- ⚠️ `tostring` on cdata<int64_t> yields "7LL", not "7". Convert to
            -- a Lua number first or every book id carries an LL suffix.
            id = id and string.format("%d", id) or tostring(r.id),
            title = r.title or _("(无标题)"),
            authors = r.authors or "",
            series = r.series,
            pages = pages,
            totalReadPages = read_pages,
            totalReadTime = read_time,
            lastOpen = num(r.last_open) and os.date("%Y-%m-%dT%H:%M", num(r.last_open)) or isoNow(),
            highlights = num(r.highlights) or 0,
            notes = num(r.notes) or 0,
        }
        -- progressPct stays absent until the second pass fills it in. Absent
        -- means "unknown", which is not the same as 0%.
        books[#books + 1] = b
        byId[b.id] = b
    end)
    if not ok then
        conn:close()
        return nil, T(_("读 book 表失败：%1"), err)
    end

    -- ── Progress ─────────────────────────────────────────────
    --
    -- ⚠️ From the LAST PAGE READ, not from a stored percentage — the statistics
    -- DB has no percentage column. `MAX(start_time)` with bare columns is
    -- SQLite's documented way to get the row the max came from; picking the
    -- page in Lua instead would need the whole page_stat_data table in memory.
    --
    -- ⚠️ `page > 0` guards the rows a reader never actually landed on (the
    -- column defaults to 0). Without it a stray page-0 record at the newest
    -- start_time reports 0% for a book that was nearly finished.
    eachRow(conn, [[
        SELECT id_book, page, MAX(start_time) AS t
        FROM page_stat_data
        WHERE page > 0
        GROUP BY id_book
    ]], function(row)
        local b = byId[string.format("%d", num(row[1]))]
        local page, pages = num(row[2]), b and b.pages
        if b and pages and pages > 0 and page then
            b.progressPct = math.max(0, math.min(100, (page / pages) * 100))
        end
    end)

    -- ── Daily ────────────────────────────────────────────────
    --
    -- ⚠️ Aggregated in SQL, not in Lua. A heavy reader's page_stat_data runs to
    -- hundreds of thousands of rows and building that table in memory is how a
    -- plugin gets a device killed for OOM. `localtime` so a day means the
    -- reader's day, not UTC's.
    local daily = {}
    eachRow(conn, [[
        SELECT date(start_time, 'unixepoch', 'localtime') AS d,
               SUM(duration) AS s,
               COUNT(*) AS p
        FROM page_stat_data
        GROUP BY d ORDER BY d
    ]], function(row)
        if row[1] then
            daily[#daily + 1] = {
                d = row[1],
                s = num(row[2]) or 0,
                p = num(row[3]) or 0,
            }
        end
    end)

    conn:close()

    return {
        schemaVersion = 1,
        device = "koreader",
        exportedAt = isoNow(),
        books = books,
        daily = daily,
        totals = {
            booksStarted = #books,
            booksFinished = finished,
            readSeconds = total_time,
            pagesTurned = total_pages,
        },
    }
end

--- Write the file. Returns `path, nil` or `nil, err`.
function CevtuoCapperr:writePayload(payload)
    local rapidjson_ok, rapidjson = pcall(require, "rapidjson")
    if not rapidjson_ok then
        return nil, _("缺少 rapidjson，无法写 JSON。")
    end
    local path = outPaths()
    local f, ferr = io.open(path, "w")
    if not f then
        return nil, T(_("写不了 %1：%2"), path, tostring(ferr))
    end
    f:write(rapidjson.encode(payload))
    f:close()
    return path
end

--- POST the payload, if a URL is configured.
--
-- ⚠️ The URL and token live in a settings file rather than in this source: a
-- plugin is a plain-text Lua file sitting on a mounted USB partition, so
-- anything hardcoded here is readable by anyone holding the Kindle.
function CevtuoCapperr:pushPayload(payload)
    local rapidjson_ok, rapidjson = pcall(require, "rapidjson")
    if not rapidjson_ok then return false, _("缺少 rapidjson") end

    local cfg_path = settingsDir() .. "/cevtuo-capperr.conf.json"
    if lfs.attributes(cfg_path, "mode") ~= "file" then
        return false, nil   -- not configured; file-only export is a valid mode
    end
    local f = io.open(cfg_path, "r")
    if not f then return false, nil end
    local raw = f:read("*a")
    f:close()

    local ok, cfg = pcall(rapidjson.decode, raw)
    if not ok or type(cfg) ~= "table" or not cfg.url then
        return false, _("cevtuo-capperr.conf.json 格式不对（需要 {\"url\":..., \"token\":...}）")
    end

    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local body = rapidjson.encode(payload)
    local resp = {}
    local sent, code = http.request{
        url = cfg.url,
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Content-Length"] = tostring(#body),
            ["Authorization"] = "Bearer " .. (cfg.token or ""),
        },
        source = ltn12.source.string(body),
        sink = ltn12.sink.table(resp),
    }
    -- ⚠️ On a connection failure luasocket returns nil + an error string, so
    -- `code` is not always a number. Report both rather than "HTTP nil".
    if sent and num(code) and num(code) >= 200 and num(code) < 300 then
        return true
    end
    return false, T(_("推送失败：%1"), tostring(code or "无响应"))
end

--- Export, then optionally push. Every failure surfaces as a message.
function CevtuoCapperr:run(interactive)
    local payload, err = self:buildPayload()
    if not payload then
        if interactive then UIManager:show(InfoMessage:new{ text = err, timeout = 6 }) end
        logger.warn("cevtuo-capperr:", err)
        return
    end

    local path, werr = self:writePayload(payload)
    if not path then
        if interactive then UIManager:show(InfoMessage:new{ text = werr, timeout = 6 }) end
        logger.warn("cevtuo-capperr:", werr)
        return
    end

    local n = payload.totals.booksStarted
    logger.info("cevtuo-capperr: exported", n, "books to", path)

    -- ⚠️ Network is attempted only when it is already up. Bringing WiFi up
    -- from a menu action would drain the battery on a device whose whole job is
    -- lasting weeks, and the file has already been written either way.
    local pushed, perr = false, nil
    if NetworkMgr:isConnected() then
        pushed, perr = self:pushPayload(payload)
    end

    if interactive then
        local msg = T(_("已导出 %1 本书的阅读统计\n%2"), n, path)
        if pushed then
            msg = msg .. "\n" .. _("并已推送到服务器。")
        elseif perr then
            msg = msg .. "\n" .. perr
        end
        UIManager:show(InfoMessage:new{ text = msg, timeout = 5 })
    end
end

function CevtuoCapperr:init()
    self.ui.menu:registerToMainMenu(self)
end

function CevtuoCapperr:addToMainMenu(menu_items)
    menu_items.cevtuo_capperr = {
        text = _("导出阅读统计（CEVTUO）"),
        -- ⚠️ Must be an id that exists in BOTH the reader menu and the file
        -- manager menu: `is_doc_only = false` means this registers into both.
        -- MenuSorter does `findById(hint).sub_item_table` with no nil check, so
        -- an id that resolves nowhere does not merely misplace the entry — it
        -- throws while building the menu. Both menus carry "tools".
        sorting_hint = "tools",
        callback = function() self:run(true) end,
    }
end

return CevtuoCapperr
