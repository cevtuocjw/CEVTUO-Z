-- ltn12 shim.
--
-- ⚠️ `sink.table(t)` must return a FUNCTION that appends to `t`, because that
-- is what the real library returns and what `socket.http` calls. Returning `t`
-- itself looks equivalent — the plugin never inspects it — right up until the
-- shim tries to feed a response body through it.
return {
  source = { string = function(s) return s end },
  sink = {
    table = function(t)
      return function(chunk)
        if chunk then t[#t + 1] = chunk end
        return 1
      end
    end,
  },
}
