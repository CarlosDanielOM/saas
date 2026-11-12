-- DIMA032_CLEAN_OLD
for _, key in ipairs(KEYS) do
    local raw = redis.call('GET', key)
    if raw then
        local ok, item = pcall(cjson.decode, raw)
        if not ok or type(item) ~= 'table' or item.queueSession == nil or item.queueSession == cjson.null or item.queueSession == ARGV[1] then
            redis.call('DEL', key)
        end
    end
end
return 1