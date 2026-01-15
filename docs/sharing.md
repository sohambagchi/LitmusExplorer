# Shareable sessions (Supabase)

The `Share` button stores the current session snapshot as JSON in a Supabase table and generates a UUID link like `https://your-domain/<uuid>`.

## 1) Create the table

Run this in the Supabase SQL editor:

```sql
create table if not exists public.litmus_shares (
  id uuid primary key,
  snapshot jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.litmus_shares enable row level security;

-- Demo policies (public read + public insert).
-- Tighten these for production if needed.
create policy "litmus_shares_read"
on public.litmus_shares
for select
using (true);

create policy "litmus_shares_insert"
on public.litmus_shares
for insert
with check (true);
```

## 2) Configure env vars

Create `.env.local`:

```sh
VITE_SUPABASE_URL=... # Project URL (not /rest/v1)
VITE_SUPABASE_ANON_KEY=... # anon/public key (not service_role)
```

## 3) Ensure SPA routing works

Visiting `/<uuid>` must still serve `index.html` (the React app), so your host needs a “single page app” rewrite rule.
