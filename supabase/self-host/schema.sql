-- ============================================================================
-- FULL DATABASE SETUP FOR SELF-HOSTING (run once on a fresh Supabase project)
-- Supabase Dashboard -> SQL Editor -> New query -> paste everything -> Run
-- ============================================================================

-- ---------------------------------------------------------------- 1. ENUMS
DO $$ BEGIN
  CREATE TYPE public.ai_mode AS ENUM ('AI_ACTIVE', 'HUMAN_ACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.app_role AS ENUM ('SUPER_ADMIN', 'BUSINESS_USER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.business_status AS ENUM ('ACTIVE', 'SUSPENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.contact_stage AS ENUM ('NEW', 'INTERESTED', 'READY_TO_BUY', 'ORDERED', 'COMPLETED', 'LOST');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.conversation_status AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.kb_category AS ENUM ('BUSINESS', 'PRODUCTS', 'FAQ', 'SERVICES', 'POLICIES', 'DOCUMENTS', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.kb_status AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.member_role AS ENUM ('OWNER', 'MEMBER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.message_type AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.order_status AS ENUM ('PENDING', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.product_availability AS ENUM ('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.sender_type AS ENUM ('CUSTOMER', 'AI', 'HUMAN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE public.wa_connection_state AS ENUM ('CONNECTING', 'CONNECTED', 'DISCONNECTED', 'RECONNECTING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------- 2. TABLES
CREATE TABLE IF NOT EXISTS public.businesses (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  name text NOT NULL,
  owner_id uuid,
  status business_status DEFAULT 'ACTIVE'::business_status NOT NULL,
  contact_email text,
  contact_phone text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid NOT NULL,
  email text,
  full_name text,
  phone text,
  avatar_url text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  role app_role NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.business_members (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role member_role DEFAULT 'MEMBER'::member_role NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.business_settings (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  business_name text,
  description text,
  phone text,
  email text,
  location text,
  opening_hours text,
  delivery_info text,
  payment_methods text,
  website text,
  social_links jsonb DEFAULT '{}'::jsonb NOT NULL,
  logo_url text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.ai_prompts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  system_prompt text DEFAULT 'Wewe ni msaidizi wa biashara hii kwenye WhatsApp. Jibu kwa upole, kwa ufupi na kwa usahihi. Tumia Kiswahili cha Tanzania, na ubadilike kwenda Kiingereza kama mteja anatumia Kiingereza.'::text NOT NULL,
  language text DEFAULT 'sw-TZ'::text NOT NULL,
  personality text DEFAULT 'Friendly, helpful, natural, professional when necessary'::text NOT NULL,
  response_length text DEFAULT 'SHORT'::text NOT NULL,
  ai_enabled boolean DEFAULT true NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.whatsapp_accounts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  phone_number text,
  jid text,
  display_name text,
  status text DEFAULT 'INACTIVE'::text NOT NULL,
  connection_state wa_connection_state DEFAULT 'DISCONNECTED'::wa_connection_state NOT NULL,
  last_error text,
  last_connected_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.contacts (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  name text,
  phone text NOT NULL,
  jid text,
  email text,
  tags text[] DEFAULT '{}'::text[] NOT NULL,
  notes text,
  stage contact_stage DEFAULT 'NEW'::contact_stage NOT NULL,
  last_interaction_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.conversations (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  whatsapp_account_id uuid,
  status conversation_status DEFAULT 'OPEN'::conversation_status NOT NULL,
  ai_mode ai_mode DEFAULT 'AI_ACTIVE'::ai_mode NOT NULL,
  last_message_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.messages (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  sender text,
  sender_type sender_type NOT NULL,
  message_type message_type DEFAULT 'TEXT'::message_type NOT NULL,
  content text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  external_id text,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.products (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  price numeric(12,2) DEFAULT 0 NOT NULL,
  currency text DEFAULT 'TZS'::text NOT NULL,
  category text,
  sku text,
  stock integer DEFAULT 0 NOT NULL,
  availability product_availability DEFAULT 'IN_STOCK'::product_availability NOT NULL,
  image_url text,
  product_url text,
  tags text[] DEFAULT '{}'::text[] NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.orders (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  order_number text,
  status order_status DEFAULT 'PENDING'::order_status NOT NULL,
  total numeric(12,2) DEFAULT 0 NOT NULL,
  currency text DEFAULT 'TZS'::text NOT NULL,
  delivery_address text,
  delivery_notes text,
  payment_method text,
  notes text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid,
  product_name text NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  unit_price numeric(12,2) DEFAULT 0 NOT NULL,
  subtotal numeric(12,2) DEFAULT 0 NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.knowledge_base (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  title text NOT NULL,
  content text,
  category kb_category DEFAULT 'BUSINESS'::kb_category NOT NULL,
  status kb_status DEFAULT 'PUBLISHED'::kb_status NOT NULL,
  source_url text,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.knowledge_documents (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  knowledge_base_id uuid,
  file_name text NOT NULL,
  storage_path text NOT NULL,
  mime_type text,
  size_bytes bigint,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.usage_events (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid NOT NULL,
  event_type text NOT NULL,
  quantity integer DEFAULT 1 NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  business_id uuid,
  actor_id uuid,
  action text NOT NULL,
  resource_type text,
  resource_id text,
  metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------- 3. CONSTRAINTS
ALTER TABLE public.businesses ADD CONSTRAINT businesses_pkey PRIMARY KEY (id);
ALTER TABLE public.businesses ADD CONSTRAINT businesses_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.profiles ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);
ALTER TABLE public.profiles ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;

ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.user_roles ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);

ALTER TABLE public.business_members ADD CONSTRAINT business_members_pkey PRIMARY KEY (id);
ALTER TABLE public.business_members ADD CONSTRAINT business_members_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.business_members ADD CONSTRAINT business_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.business_members ADD CONSTRAINT business_members_business_id_user_id_key UNIQUE (business_id, user_id);

ALTER TABLE public.business_settings ADD CONSTRAINT business_settings_pkey PRIMARY KEY (id);
ALTER TABLE public.business_settings ADD CONSTRAINT business_settings_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.business_settings ADD CONSTRAINT business_settings_business_id_key UNIQUE (business_id);

ALTER TABLE public.ai_prompts ADD CONSTRAINT ai_prompts_pkey PRIMARY KEY (id);
ALTER TABLE public.ai_prompts ADD CONSTRAINT ai_prompts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.ai_prompts ADD CONSTRAINT ai_prompts_business_id_key UNIQUE (business_id);

ALTER TABLE public.whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

ALTER TABLE public.contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);
ALTER TABLE public.contacts ADD CONSTRAINT contacts_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.contacts ADD CONSTRAINT contacts_business_id_phone_key UNIQUE (business_id, phone);

ALTER TABLE public.conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);
ALTER TABLE public.conversations ADD CONSTRAINT conversations_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_whatsapp_account_id_fkey FOREIGN KEY (whatsapp_account_id) REFERENCES public.whatsapp_accounts(id) ON DELETE SET NULL;

ALTER TABLE public.messages ADD CONSTRAINT messages_pkey PRIMARY KEY (id);
ALTER TABLE public.messages ADD CONSTRAINT messages_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.messages ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;

ALTER TABLE public.products ADD CONSTRAINT products_pkey PRIMARY KEY (id);
ALTER TABLE public.products ADD CONSTRAINT products_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

ALTER TABLE public.orders ADD CONSTRAINT orders_pkey PRIMARY KEY (id);
ALTER TABLE public.orders ADD CONSTRAINT orders_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.orders ADD CONSTRAINT orders_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;
ALTER TABLE public.orders ADD CONSTRAINT orders_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;

ALTER TABLE public.order_items ADD CONSTRAINT order_items_pkey PRIMARY KEY (id);
ALTER TABLE public.order_items ADD CONSTRAINT order_items_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_order_id_fkey FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE CASCADE;
ALTER TABLE public.order_items ADD CONSTRAINT order_items_product_id_fkey FOREIGN KEY (product_id) REFERENCES public.products(id) ON DELETE SET NULL;

ALTER TABLE public.knowledge_base ADD CONSTRAINT knowledge_base_pkey PRIMARY KEY (id);
ALTER TABLE public.knowledge_base ADD CONSTRAINT knowledge_base_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_pkey PRIMARY KEY (id);
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.knowledge_documents ADD CONSTRAINT knowledge_documents_knowledge_base_id_fkey FOREIGN KEY (knowledge_base_id) REFERENCES public.knowledge_base(id) ON DELETE CASCADE;

ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_pkey PRIMARY KEY (id);
ALTER TABLE public.usage_events ADD CONSTRAINT usage_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;

ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_business_id_fkey FOREIGN KEY (business_id) REFERENCES public.businesses(id) ON DELETE CASCADE;
ALTER TABLE public.audit_logs ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- ------------------------------------------------------------- 4. INDEXES
CREATE INDEX IF NOT EXISTS idx_audit_actor ON public.audit_logs USING btree (actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_business_created ON public.audit_logs USING btree (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_members_business ON public.business_members USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_business_members_user ON public.business_members USING btree (user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_business ON public.contacts USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_contacts_jid ON public.contacts USING btree (jid);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON public.contacts USING btree (phone);
CREATE INDEX IF NOT EXISTS idx_contacts_stage ON public.contacts USING btree (business_id, stage);
CREATE INDEX IF NOT EXISTS idx_conversations_business ON public.conversations USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON public.conversations USING btree (contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_msg ON public.conversations USING btree (business_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_kb_business ON public.knowledge_base USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_kb_category ON public.knowledge_base USING btree (business_id, category);
CREATE INDEX IF NOT EXISTS idx_kb_docs_business ON public.knowledge_documents USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_messages_business ON public.messages USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON public.messages USING btree (conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_created ON public.messages USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_order_items_business ON public.order_items USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON public.order_items USING btree (order_id);
CREATE INDEX IF NOT EXISTS idx_orders_business ON public.orders USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_orders_created ON public.orders USING btree (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_status ON public.orders USING btree (business_id, status);
CREATE INDEX IF NOT EXISTS idx_products_business ON public.products USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON public.products USING btree (business_id, category);
CREATE INDEX IF NOT EXISTS idx_products_name ON public.products USING btree (business_id, name);
CREATE INDEX IF NOT EXISTS idx_products_tags ON public.products USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_usage_business_created ON public.usage_events USING btree (business_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_type ON public.usage_events USING btree (event_type);
CREATE INDEX IF NOT EXISTS idx_wa_accounts_business ON public.whatsapp_accounts USING btree (business_id);
CREATE INDEX IF NOT EXISTS idx_wa_accounts_jid ON public.whatsapp_accounts USING btree (jid);
CREATE INDEX IF NOT EXISTS idx_wa_accounts_phone ON public.whatsapp_accounts USING btree (phone_number);

-- ------------------------------------------------------------ 5. FUNCTIONS
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public' AS $function$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $function$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$function$;

CREATE OR REPLACE FUNCTION public.is_business_member(_user_id uuid, _business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.business_members
    WHERE user_id = _user_id AND business_id = _business_id
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.has_role(auth.uid(), 'SUPER_ADMIN'::public.app_role);
$function$;

CREATE OR REPLACE FUNCTION public.can_access_business(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT public.is_business_member(auth.uid(), _business_id)
      OR public.has_role(auth.uid(), 'SUPER_ADMIN'::public.app_role);
$function$;

CREATE OR REPLACE FUNCTION public.owns_business(_business_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  SELECT EXISTS (SELECT 1 FROM public.businesses WHERE id = _business_id AND owner_id = auth.uid());
$function$;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, phone)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name'),
    NEW.raw_user_meta_data->>'phone'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END; $function$;

-- ------------------------------------------------------------- 6. TRIGGERS
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE TRIGGER trg_ai_prompts_updated BEFORE UPDATE ON public.ai_prompts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_business_members_updated BEFORE UPDATE ON public.business_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_settings_updated BEFORE UPDATE ON public.business_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_businesses_updated BEFORE UPDATE ON public.businesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_contacts_updated BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_conversations_updated BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_kb_updated BEFORE UPDATE ON public.knowledge_base FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_kb_docs_updated BEFORE UPDATE ON public.knowledge_documents FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_order_items_updated BEFORE UPDATE ON public.order_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON public.orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON public.products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_wa_updated BEFORE UPDATE ON public.whatsapp_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------- 7. GRANTS
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ai_prompts','audit_logs','business_members','business_settings','businesses',
    'contacts','conversations','knowledge_base','knowledge_documents','messages',
    'order_items','orders','products','profiles','usage_events','user_roles','whatsapp_accounts'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ------------------------------------------------------------- 8. POLICIES
CREATE POLICY ai_prompts_all ON public.ai_prompts FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY audit_insert ON public.audit_logs FOR INSERT TO authenticated WITH CHECK (((actor_id = auth.uid()) AND ((business_id IS NULL) OR can_access_business(business_id))));
CREATE POLICY audit_select ON public.audit_logs FOR SELECT TO authenticated USING ((((business_id IS NULL) AND is_super_admin()) OR can_access_business(business_id)));
CREATE POLICY members_delete ON public.business_members FOR DELETE TO authenticated USING ((is_super_admin() OR owns_business(business_id)));
CREATE POLICY members_insert ON public.business_members FOR INSERT TO authenticated WITH CHECK ((is_super_admin() OR owns_business(business_id)));
CREATE POLICY members_select ON public.business_members FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR can_access_business(business_id)));
CREATE POLICY members_update ON public.business_members FOR UPDATE TO authenticated USING ((is_super_admin() OR owns_business(business_id))) WITH CHECK ((is_super_admin() OR owns_business(business_id)));
CREATE POLICY settings_all ON public.business_settings FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY businesses_insert_own ON public.businesses FOR INSERT TO authenticated WITH CHECK (((owner_id = auth.uid()) OR is_super_admin()));
CREATE POLICY businesses_select ON public.businesses FOR SELECT TO authenticated USING (((owner_id = auth.uid()) OR can_access_business(id)));
CREATE POLICY businesses_update ON public.businesses FOR UPDATE TO authenticated USING ((owns_business(id) OR is_super_admin())) WITH CHECK ((owns_business(id) OR is_super_admin()));
CREATE POLICY contacts_all ON public.contacts FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY conversations_all ON public.conversations FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY kb_all ON public.knowledge_base FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY kb_docs_all ON public.knowledge_documents FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY messages_all ON public.messages FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY order_items_all ON public.order_items FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY orders_all ON public.orders FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY products_all ON public.products FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));
CREATE POLICY profiles_insert_self ON public.profiles FOR INSERT TO authenticated WITH CHECK ((id = auth.uid()));
CREATE POLICY profiles_select_self_or_admin ON public.profiles FOR SELECT TO authenticated USING (((id = auth.uid()) OR is_super_admin() OR (EXISTS ( SELECT 1
   FROM business_members bm
  WHERE ((bm.user_id = profiles.id) AND is_business_member(auth.uid(), bm.business_id))))));
CREATE POLICY profiles_update_self ON public.profiles FOR UPDATE TO authenticated USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));
CREATE POLICY usage_insert ON public.usage_events FOR INSERT TO authenticated WITH CHECK (can_access_business(business_id));
CREATE POLICY usage_select ON public.usage_events FOR SELECT TO authenticated USING (can_access_business(business_id));
CREATE POLICY user_roles_select_self_or_admin ON public.user_roles FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR is_super_admin()));
CREATE POLICY wa_all ON public.whatsapp_accounts FOR ALL TO authenticated USING (can_access_business(business_id)) WITH CHECK (can_access_business(business_id));

-- -------------------------------------------------------------- 9. STORAGE
INSERT INTO storage.buckets (id, name, public)
VALUES ('product-images','product-images', true),
       ('business-assets','business-assets', false),
       ('knowledge-files','knowledge-files', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY tenant_files_select ON storage.objects FOR SELECT TO authenticated
USING ((bucket_id = ANY (ARRAY['product-images','business-assets','knowledge-files']))
  AND ((storage.foldername(name))[1] IS NOT NULL)
  AND can_access_business(((storage.foldername(name))[1])::uuid));

CREATE POLICY tenant_files_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK ((bucket_id = ANY (ARRAY['product-images','business-assets','knowledge-files']))
  AND ((storage.foldername(name))[1] IS NOT NULL)
  AND can_access_business(((storage.foldername(name))[1])::uuid));

CREATE POLICY tenant_files_update ON storage.objects FOR UPDATE TO authenticated
USING ((bucket_id = ANY (ARRAY['product-images','business-assets','knowledge-files']))
  AND can_access_business(((storage.foldername(name))[1])::uuid))
WITH CHECK ((bucket_id = ANY (ARRAY['product-images','business-assets','knowledge-files']))
  AND can_access_business(((storage.foldername(name))[1])::uuid));

CREATE POLICY tenant_files_delete ON storage.objects FOR DELETE TO authenticated
USING ((bucket_id = ANY (ARRAY['product-images','business-assets','knowledge-files']))
  AND can_access_business(((storage.foldername(name))[1])::uuid));

-- -------------------------------------------- 10. MAKE YOURSELF SUPER ADMIN
-- After signing up in the app, run this once with your email:
-- INSERT INTO public.user_roles (user_id, role)
-- SELECT id, 'SUPER_ADMIN'::app_role FROM auth.users WHERE email = 'you@example.com'
-- ON CONFLICT DO NOTHING;

-- Commerce, carts and subscription plans live in 002_commerce_and_plans.sql (run it next).
