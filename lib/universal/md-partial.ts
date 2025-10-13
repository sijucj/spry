import { z, ZodType } from "jsr:@zod/zod@4";
import { jsonToZod } from "./zod-aide.ts";

// TS-only types for dev ergonomics
type InjectContentFn = (
  locals: Record<string, unknown>,
  onError?: (message: string, content: string, error?: unknown) => string,
) =>
  | { content: string; interpolate: boolean; locals: Record<string, unknown> }
  | Promise<
    { content: string; interpolate: boolean; locals: Record<string, unknown> }
  >;

export const mdFencedBlockPartialSchema = z.object({
  identity: z.string().min(1),
  argsZodSchema: z.instanceof(ZodType).optional(),
  argsZodSchemaSpec: z.string().optional(),

  // Zod v4: cannot embed parameter/return schemas for function *fields*.
  // Use z.custom<InjectFn>(...) with a guard (and optional runtime checks).
  content: z.custom<InjectContentFn>(
    (v): v is InjectContentFn =>
      typeof v === "function" &&
      // optional arity sanity-check: 1 or 2 params (locals[, onError])
      // deno-lint-ignore ban-types
      (v as Function).length >= 1 &&
      // deno-lint-ignore ban-types
      (v as Function).length <= 2,
    {
      message:
        "inject must be a function (locals: Record<string, unknown>, onError?: (msg, content, err) => string) => string | Promise<string>",
    },
  ),
}).strict();

export type FencedBlockPartial = z.infer<typeof mdFencedBlockPartialSchema>;

export type FencedBlockPartialSupplier = {
  partial: FencedBlockPartial;
};

export function fbPartialCandidate(
  info: string,
  content: string,
  zodSchemaSpec?: Record<string, unknown>,
  init?: {
    registerIssue: (message: string, content: string, error?: unknown) => void;
  },
): FencedBlockPartial {
  const argsZodSchemaSpec = JSON.stringify(
    zodSchemaSpec
      ? Object.keys(zodSchemaSpec).length > 0 ? zodSchemaSpec : undefined
      : undefined,
  );
  let argsZodSchema: ZodType | undefined;
  if (argsZodSchemaSpec) {
    try {
      argsZodSchema = jsonToZod(JSON.stringify({
        type: "object",
        properties: JSON.parse(argsZodSchemaSpec),
        additionalProperties: true,
      }));
    } catch (error) {
      argsZodSchema = undefined;
      init?.registerIssue(
        `Invalid Zod schema spec: ${argsZodSchemaSpec}`,
        content,
        error,
      );
    }
  }

  const identity = info.trim();
  return {
    identity,
    argsZodSchema,
    argsZodSchemaSpec,
    content: (locals, onError) => {
      if (argsZodSchema) {
        const parsed = z.safeParse(
          argsZodSchema,
          locals,
        );
        if (!parsed.success) {
          const message = `Invalid arguments passed to partial '${identity}': ${
            z.prettifyError(parsed.error)
          }\nPartial '${identity}' expected arguments ${argsZodSchemaSpec}`;
          return {
            content: onError
              ? onError(message, content, parsed.error)
              : message,
            interpolate: false,
            locals,
          };
        }
      }
      return { content, interpolate: true, locals };
    },
  };
}

export function fbPartialsCollection<
  Supplier extends FencedBlockPartialSupplier,
>(
  init?: { onDuplicate?: (fbps: Supplier) => "overwrite" | "throw" | "ignore" },
) {
  const catalog = new Map<string, Supplier>();
  return {
    catalog,
    register: (fbps: Supplier) => {
      const { identity } = fbps.partial;
      const found = catalog.get(identity);
      if (found && init?.onDuplicate) {
        const onDupe = init.onDuplicate(fbps);
        if (onDupe === "throw") {
          throw new Deno.errors.AlreadyExists(
            `Partial '${identity}' defined already, not creating duplicate in fbPartialsCollection`,
          );
        } else if (onDupe === "ignore") {
          return;
        }
      } // else we overwrite by default
      catalog.set(identity, fbps);
    },
    partialSupplier: (identity: string) => catalog.get(identity),
    partial: (identity: string) => catalog.get(identity)?.partial,
  };
}
