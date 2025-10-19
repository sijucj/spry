import { z } from "jsr:@zod/zod@4";

export const sqlPageConfSchema = z.object({
  // Core server & DB
  database_url: z.string().min(1).optional(),
  database_password: z.string().min(1).optional(), // optional, supported in newer versions
  listen_on: z.string().min(1).optional(), // e.g. "0.0.0.0:8080"
  port: z.number().min(1).optional(),
  web_root: z.string().min(1).optional(),

  // Routing / base path
  site_prefix: z.string().min(1).optional(), // e.g. "/sqlpage"

  // HTTPS / host
  https_domain: z.string().min(1).optional(), // e.g. "example.com"
  host: z.string().min(1).optional(), // required by SSO; must match domain exactly

  // Security / limits
  allow_exec: z.boolean().optional(),
  max_uploaded_file_size: z.number().int().positive().optional(),

  // Environment
  environment: z.enum(["production", "development"]).optional(),

  // Frontmatter-friendly nested OIDC
  oidc: z.object({
    issuer_url: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    scopes: z.array(z.string()).optional(),
    redirect_path: z.string().min(1).optional(),
  }).optional(),

  // Also accept already-flat OIDC keys (as SQLPage expects in json)
  oidc_issuer_url: z.string().min(1).optional(),
  oidc_client_id: z.string().min(1).optional(),
  oidc_client_secret: z.string().min(1).optional(),
}).catchall(z.unknown());

export type SqlPageConf = z.infer<typeof sqlPageConfSchema>;

// Utility: drop undefined recursively
export function dropUndef<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = dropUndef(v as Record<string, unknown>);
      if (Object.keys(nested).length > 0) out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// Produces the exact JSON object you can write to sqlpage/sqlpage.json
export function sqlPageConf(conf: z.infer<typeof sqlPageConfSchema>) {
  // Start from a shallow clone
  const out: Record<string, unknown> = { ...conf };

  // Flatten nested OIDC if provided
  if (conf.oidc) {
    const { issuer_url, client_id, client_secret, scopes, redirect_path } =
      conf.oidc;
    // Only set flat keys if not already set at top level
    if (issuer_url && out.oidc_issuer_url === undefined) {
      out.oidc_issuer_url = issuer_url;
    }
    if (client_id && out.oidc_client_id === undefined) {
      out.oidc_client_id = client_id;
    }
    if (client_secret && out.oidc_client_secret === undefined) {
      out.oidc_client_secret = client_secret;
    }
    if (scopes !== undefined) out.oidc_scopes = scopes; // SQLPage ignores unknowns; keeping for future
    if (redirect_path !== undefined) out.oidc_redirect_path = redirect_path;
    delete out.oidc;
  }

  // Clean undefineds
  return dropUndef(out);
}
