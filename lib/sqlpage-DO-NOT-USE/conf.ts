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
