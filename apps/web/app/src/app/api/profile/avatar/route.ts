import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRouteUser } from "@/lib/auth/route-auth";

const MAX_SIZE = 2 * 1024 * 1024; // 2MB

// SVG is intentionally excluded: the assets bucket is public, and an SVG
// served from it can carry script.
const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

const fileSchema = z
  .instanceof(File, { message: "No file provided" })
  .refine((f) => f.type in EXT_BY_TYPE, {
    message: "Invalid file type. Use PNG, JPEG, WebP, or GIF.",
  })
  .refine((f) => f.size <= MAX_SIZE, {
    message: "File too large. Maximum size is 2MB.",
  });

const avatarPrefix = (userId: string) => `avatars/${userId}`;

async function removeStoredAvatars(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  keep?: string,
) {
  const prefix = avatarPrefix(userId);
  const { data: existing } = await admin.storage.from("assets").list(prefix);
  const stale = (existing ?? [])
    .map((f) => `${prefix}/${f.name}`)
    .filter((p) => p !== keep);
  if (stale.length > 0) {
    await admin.storage.from("assets").remove(stale);
  }
}

/** POST /api/profile/avatar — upload the current user's profile photo */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }
  const parsed = fileSchema.safeParse(formData.get("file"));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid file" },
      { status: 400 },
    );
  }
  const file = parsed.data;

  // Derive the extension from the validated MIME type, not the client filename.
  const path = `${avatarPrefix(user.id)}/avatar.${EXT_BY_TYPE[file.type]}`;
  const admin = createAdminClient();

  const { error: uploadError } = await admin.storage
    .from("assets")
    .upload(path, file, { upsert: true, contentType: file.type });

  if (uploadError) {
    console.error("[Breezify] Failed to upload avatar:", uploadError.message);
    return NextResponse.json({ error: "Failed to upload avatar" }, { status: 500 });
  }

  // Drop a previous avatar saved under a different extension.
  await removeStoredAvatars(admin, user.id, path);

  const { data: urlData } = admin.storage.from("assets").getPublicUrl(path);
  // Cache-buster so the browser fetches the new image when replacing one.
  const avatarUrl = `${urlData.publicUrl}?v=${Date.now()}`;

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_url: avatarUrl, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[Breezify] Failed to save avatar_url:", updateError.message);
    return NextResponse.json({ error: "Failed to save avatar" }, { status: 500 });
  }

  return NextResponse.json({ avatar_url: avatarUrl });
}

/** DELETE /api/profile/avatar — remove the current user's profile photo */
export async function DELETE(): Promise<NextResponse> {
  const supabase = await createClient();
  const { user, response: authResponse } = await requireRouteUser(supabase);
  if (!user) return authResponse;

  const { error: updateError } = await supabase
    .from("profiles")
    .update({ avatar_url: null, updated_at: new Date().toISOString() })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[Breezify] Failed to clear avatar_url:", updateError.message);
    return NextResponse.json({ error: "Failed to remove avatar" }, { status: 500 });
  }

  await removeStoredAvatars(createAdminClient(), user.id);

  return NextResponse.json({ ok: true });
}
