-- exchange_rates is append-only for tenants, as spec 02 says ("every change is a
-- new row") and audit_log is: the latest row sets every calculated ZiG price, so
-- they can add a rate and read their own (RLS limits them to their restaurant),
-- never rewrite or erase one. Same exception to 0002's default privileges as 0003.
REVOKE UPDATE, DELETE ON exchange_rates FROM app_tenant;
