import type { SessionSnapshot } from "../types";
import { getSupabaseClient } from "./supabaseClient";

type ShareRow = {
  id: string;
  snapshot: unknown;
};

export const createShare = async ({
  id,
  snapshot,
}: {
  id: string;
  snapshot: SessionSnapshot;
}) => {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      "Sharing is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  const { error } = await client.from("litmus_shares").insert({
    id,
    snapshot,
  });

  if (error) {
    throw error;
  }
};

export const fetchSharedSnapshot = async (id: string): Promise<unknown> => {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      "Sharing is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  const { data, error } = await client
    .from("litmus_shares")
    .select("snapshot")
    .eq("id", id)
    .single<ShareRow>();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new Error("Shared session not found.");
  }

  return data.snapshot;
};

