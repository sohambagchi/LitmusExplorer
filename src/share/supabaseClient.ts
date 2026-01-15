import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cachedClient: SupabaseClient | null = null;

const normalizeSupabaseUrl = (url: string) =>
  url
    .trim()
    .replace(/\/rest\/v1\/?$/i, "")
    .replace(/\/+$/, "");

export const getSupabaseClient = () => {
  if (cachedClient) {
    return cachedClient;
  }

  const rawUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

  if (!rawUrl || !anonKey) {
    return null;
  }

  const url = normalizeSupabaseUrl(rawUrl);
  cachedClient = createClient(url, anonKey);
  return cachedClient;
};
