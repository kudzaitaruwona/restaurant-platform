CREATE TABLE "admin_auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_auth_account_provider_id_account_id_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "admin_auth_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "admin_auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "admin_auth_rate_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "admin_auth_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "admin_auth_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "admin_auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admin_auth_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_auth_account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_auth_account_provider_id_account_id_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "staff_auth_account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_auth_rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "staff_auth_rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
ALTER TABLE "staff_auth_rate_limit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_auth_session" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_auth_session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "staff_auth_session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_auth_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_auth_user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "staff_auth_user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "staff_auth_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_auth_verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "admin_auth_account" ADD CONSTRAINT "admin_auth_account_user_id_admin_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_auth_session" ADD CONSTRAINT "admin_auth_session_user_id_admin_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."admin_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_auth_account" ADD CONSTRAINT "staff_auth_account_user_id_staff_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_auth_session" ADD CONSTRAINT "staff_auth_session_user_id_staff_auth_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."staff_auth_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_auth_account_user_id_index" ON "admin_auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_auth_session_user_id_index" ON "admin_auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "admin_auth_verification_identifier_index" ON "admin_auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "staff_auth_account_user_id_index" ON "staff_auth_account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_auth_session_user_id_index" ON "staff_auth_session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "staff_auth_verification_identifier_index" ON "staff_auth_verification" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_admins_email_lower_unique" ON "platform_admins" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "staff_email_lower_unique" ON "staff" USING btree (lower("email"));--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_account" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_rate_limit" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_session" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_user" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "admin_auth_verification" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "staff_auth_account" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "staff_auth_rate_limit" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "staff_auth_session" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "staff_auth_user" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
CREATE POLICY "outside_tenant_only" ON "staff_auth_verification" AS PERMISSIVE FOR ALL TO public USING (nullif(current_setting('app.restaurant_id', true), '') is null) WITH CHECK (nullif(current_setting('app.restaurant_id', true), '') is null);--> statement-breakpoint
-- Sign-in comes before any tenant is known, so RLS rightly hides staff from
-- app_tenant. These functions are the one narrow way past it (S-28): they take
-- an exact email and return only what a session needs. search_path is empty and
-- every name qualified, so nothing a caller creates can shadow them.
--
-- `email` is globally unique, case included (the indexes above), so this finds
-- at most one person. kind = 'staff' refuses platform_admin shadow rows even
-- though the CHECK on staff would let one have an email.
CREATE FUNCTION public.staff_identity_by_email(p_email text)
RETURNS TABLE (restaurant_id uuid, staff_id uuid, role public.staff_role)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT s.restaurant_id, s.id, s.role
  FROM public.staff s
  WHERE lower(s.email) = lower(p_email)
    AND s.kind = 'staff'
    AND s.active
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.staff_identity_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.staff_identity_by_email(text) TO app_tenant;
--> statement-breakpoint
CREATE FUNCTION public.platform_admin_id_by_email(p_email text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT a.id FROM public.platform_admins a WHERE lower(a.email) = lower(p_email)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.platform_admin_id_by_email(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.platform_admin_id_by_email(text) TO app_tenant;
--> statement-breakpoint
-- Spec 01: deactivating staff kills their sessions immediately. The request-time
-- check already refuses them; this makes it final, so reactivating someone can't
-- revive a forgotten tablet, however the row came to change. SECURITY DEFINER
-- because the change arrives inside withTenant(), where the session tables are
-- hidden. A changed email ends sessions too: the old address proved nothing about
-- the new one. Triggers need no EXECUTE grant.
CREATE FUNCTION public.end_staff_sessions()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.staff_auth_session s
  USING public.staff_auth_user u
  WHERE s.user_id = u.id AND u.email = lower(OLD.email);
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.end_staff_sessions() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER staff_end_sessions
AFTER UPDATE OF active, email ON public.staff
FOR EACH ROW
WHEN (NOT NEW.active OR OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION public.end_staff_sessions();
