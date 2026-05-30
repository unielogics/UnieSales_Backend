-- How a lead first entered the system: 'upload' (a source's initial import)
-- or 'update' (a later scheduled refresh of that source). Null for manual
-- and warm-up leads. Powers the dashboard "new leads today" split and the
-- refresh-highlight on the leads table.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS import_origin text;
