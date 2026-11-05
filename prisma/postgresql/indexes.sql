-- Search indexes Prisma's schema language cannot express. Search works without
-- them, only slower, so setup warns instead of failing if they cannot be made.
-- __TRGM_OPS__ is replaced with the operator class in pg_trgm's own schema.

CREATE INDEX IF NOT EXISTS user_data_payload_gin ON "UserDataItem" USING GIN (payload jsonb_path_ops);
CREATE INDEX IF NOT EXISTS app_data_payload_gin ON "AppDataItem" USING GIN (payload jsonb_path_ops);
CREATE INDEX IF NOT EXISTS user_data_search_trgm ON "UserDataItem" USING GIN ("searchText" __TRGM_OPS__);
CREATE INDEX IF NOT EXISTS app_data_search_trgm ON "AppDataItem" USING GIN ("searchText" __TRGM_OPS__);
