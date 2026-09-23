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
on a checkpoint. Reading it from INSIDE KOReader, through sqlite3, in the same
process that owns it, is the only way to be sure the numbers are current. The
SFTP path stays as a fallback for a device that will not run the plugin.

── What it never does ──────────────────────────────────────────

It does not write to the statistics DB, and it does not touch Reading Insight
or any other plugin's storage. Only SELECTs, plus one JSON file.

⚠️ UNTESTED ON DEVICE. This was written against KOReader's documented plugin
API and the schema the Statistics plugin creates, without a Kindle to run it on.
The defensive parts below (column probing, every step in pcall, a visible error
message) exist because of that: a first run that fails should SAY it failed
rather than write a half-empty file that looks like a reading drought.
]]

local DataStorage = require("datastorage")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local InfoMessage = require("ui/widget/infomessage")
local NetworkMgr = require("ui/network/manager")
local logger = require("logger")
local lfs = require("libs/libkoreader-lfs")
local _ = require("gettext")
local T = require("ffi/util").template

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
-- ⚠️ Tries the user-visible USB partition first — that is the whole point of
-- the fallback path: the file has to be reachable by plugging the Kindle in.
-- On a device with no such mount (or a build where it is elsewhere) it falls
-- back to the settings directory rather than failing.
local function outPaths()
    local candidates = {
        "/mnt/onboard/cevtuo-capperr.json",   -- Kindle
        "/mnt/us/cevtuo-capperr.json",        -- some Kindle builds
        "/mnt/sdcard/cevtuo-capperr.json",    -- Kobo SD
    }
    for _, p in ipairs(candidates) do
        local dir = p:match("^(.*)/[^/]+$")
        if dir and lfs.attributes(dir, "mode") == "directory" then
            return p
        end
    end
    return settingsDir() .. "/cevtuo-capperr.json"
end

--- Column names that actually exist on a table.
--
-- ⚠️ The statistics schema has grown over KOReader releases — `highlights` and
-- `notes` are not on older databases. Selecting a column that is not there is a
-- hard SQL error, so the whole export would fail on an older device. Probing
-- first means an old DB still exports, just without those two fields.
local function columnsOf(db, table_name)
    local cols = {}
    local ok = pcall(function()
        for row in db:nrows("PRAGMA table_info(" .. table_name .. ")") do
            cols[row.name] = true
        end
    end)
    return ok and cols or {}
end

local function isoNow()
    return os.date("%Y-%m-%dT%H:%M")
end

--- Build the payload. Returns `payload, nil` or `nil, err`.
function CevtuoCapperr:buildPayload()
    local lsqlite3_ok, lsqlite3 = pcall(require, "ljsqlite3")
    if not lsqlite3_ok then
        return nil, _("这个 KOReader 没有带 ljsqlite3，无法读取统计库。")
    end

    local path = dbPath()
    if lfs.attributes(path, "mode") ~= "file" then
        return nil, T(_("找不到统计库：%1\n先在 KOReader 里正常读一本书，统计库才会被创建。"), path)
    end

    local db = lsqlite3.open(path)
    if not db then
        return nil, T(_("打不开统计库：%1"), path)
    end

    local bookCols = columnsOf(db, "book")
    if not bookCols.id then
        db:close()
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
        db:close()
        return nil, _("统计库的 book 表里没有 total_read_time —— 这个版本的 KOReader 太旧了。")
    end

    local books, byId = {}, {}
    local total_time, total_pages, finished = 0, 0, 0

    local ok, err = pcall(function()
        for row in db:nrows("SELECT " .. table.concat(select, ",") .. " FROM book ORDER BY last_open DESC") do
            local pages = tonumber(row.pages)
            local read_pages = tonumber(row.total_read_pages) or 0
            local read_time = tonumber(row.total_read_time) or 0
            -- ⚠️ KOReader marks a book finished at 99%+ and, for a book whose
            -- page count it never learned, treats any reading as finished. The
            -- same rule here, or the two disagree about the same library.
            local done = false
            if pages and pages > 0 then
                done = read_pages >= pages - 1
            else
                done = read_pages > 0
            end
            if done then finished = finished + 1 end

            total_time = total_time + read_time
            total_pages = total_pages + read_pages

            local b = {
                id = tostring(row.id),
                title = row.title or _("(无标题)"),
                authors = row.authors or "",
                series = row.series,
                pages = pages,
                totalReadPages = read_pages,
                totalReadTime = read_time,
                lastOpen = row.last_open and os.date("%Y-%m-%dT%H:%M", tonumber(row.last_open)) or isoNow(),
                progressPct = nil,
                highlights = tonumber(row.highlights) or 0,
                notes = tonumber(row.notes) or 0,
            }
            books[#books + 1] = b
            byId[b.id] = b
        end
    end)
    if not ok then
        db:close()
        return nil, T(_("读 book 表失败：%1"), tostring(err))
    end

    -- ── Progress ─────────────────────────────────────────────
    --
    -- ⚠️ From the LAST PAGE READ, not from a stored percentage — the statistics
    -- DB has no percentage column. `MAX(start_time)` with bare columns is
    -- SQLite's documented way to get the row the max came from; picking the
    -- page in Lua instead would need the whole page_stat_data table in memory.
    pcall(function()
        for row in db:nrows([[
            SELECT id_book, page, MAX(start_time) AS t
            FROM page_stat_data GROUP BY id_book
        ]]) do
            local b = byId[tostring(row.id_book)]
            if b and b.pages and b.pages > 0 and row.page then
                local pct = (tonumber(row.page) / b.pages) * 100
                b.progressPct = math.max(0, math.min(100, pct))
            end
        end
    end)

    -- ── Daily ────────────────────────────────────────────────
    --
    -- ⚠️ Aggregated in SQL, not in Lua. A heavy reader's page_stat_data runs to
    -- hundreds of thousands of rows and building that table in memory is how a
    -- plugin gets a device killed for OOM. `localtime` so a day means the
    -- reader's day, not UTC's.
    local daily = {}
    pcall(function()
        for row in db:nrows([[
            SELECT date(start_time, 'unixepoch', 'localtime') AS d,
                   SUM(duration) AS s,
                   COUNT(*) AS p
            FROM page_stat_data
            GROUP BY d ORDER BY d
        ]]) do
            if row.d then
                daily[#daily + 1] = {
                    d = row.d,
                    s = tonumber(row.s) or 0,
                    p = tonumber(row.p) or 0,
                }
            end
        end
    end)

    db:close()

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
    local _, code = http.request{
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
    if code and code >= 200 and code < 300 then
        return true
    end
    return false, T(_("推送失败：HTTP %1"), tostring(code or "?"))
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
        sorting_hint = "tools",
        callback = function() self:run(true) end,
    }
end

return CevtuoCapperr
