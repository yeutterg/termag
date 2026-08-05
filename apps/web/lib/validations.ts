import { z } from "zod";

// Common validation patterns
const cuidSchema = z.string().cuid("Invalid ID format");
const nonEmptyString = z.string().min(1, "Cannot be empty");

// Agent token validation
export const agentTokenSchema = z.object({
  name: nonEmptyString.max(100, "Name too long"),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color format")
    .optional(),
  defaultRootKey: z.string().optional(),
  defaultRelativePath: z.string().optional(),
});

// Project validation
export const projectSchema = z.object({
  name: nonEmptyString.max(255, "Project name too long"),
  rootKey: nonEmptyString,
  relativePath: nonEmptyString,
  agentType: z.enum(["shell", "codex", "claude", "custom"], {
    errorMap: () => ({ message: "Invalid agent type" }),
  }),
  agentSpawnCommand: z.string().optional(),
  ctrlSpawnCommand: z.string().default("$SHELL"),
});

// Tab validation
export const tabSchema = z.object({
  name: nonEmptyString.max(100, "Tab name too long"),
  ordinal: z.number().int().nonnegative("Ordinal must be non-negative"),
});

// SSH host validation
export const sshHostSchema = z.object({
  name: nonEmptyString.max(100, "Host name too long"),
  host: nonEmptyString.max(255, "Host address too long"),
  port: z.number().int().min(1).max(65535, "Port must be between 1 and 65535"),
  user: nonEmptyString.max(100, "Username too long"),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/, "Invalid color format")
    .optional(),
});

// Session validation
export const sessionSchema = z.object({
  tmuxName: nonEmptyString,
  tmuxWindowName: z.string().optional(),
  agentType: z.string().optional(),
  spawnCommand: z.string().optional(),
});

// Share link validation
export const shareLinkSchema = z.object({
  sessionId: cuidSchema.optional(),
  sshHostId: cuidSchema.optional(),
  tmuxName: z.string().optional(),
  expiresIn: z
    .number()
    .int()
    .positive("Expiration must be positive")
    .max(86400, "Maximum expiration is 24 hours"),
});

// Bootstrap code validation
export const bootstrapSchema = z.object({
  deviceName: z.string().max(100, "Device name too long").optional(),
  expiresIn: z
    .number()
    .int()
    .positive("Expiration must be positive")
    .max(3600, "Maximum expiration is 1 hour"),
});

// Password validation
export const passwordSchema = z.object({
  password: z.string().min(8, "Password must be at least 8 characters"),
});

// Theme validation
export const themeSchema = z.object({
  theme: z.enum(["light", "dark", "system"], {
    errorMap: () => ({ message: "Invalid theme value" }),
  }),
});

// Project order validation
export const projectOrderSchema = z.object({
  projectIds: z.array(cuidSchema).min(1, "At least one project ID required"),
});

// Directory browse validation
export const directoryBrowseSchema = z.object({
  deviceName: nonEmptyString,
  path: z.string().optional(),
});

// Search validation
export const searchSchema = z.object({
  query: nonEmptyString.max(200, "Search query too long"),
  limit: z.number().int().min(1).max(100).optional(),
});

// Health check response validation
export const healthStatusSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  timestamp: z.string(),
  uptime: z.number(),
  memory: z.object({
    used: z.number(),
    total: z.number(),
    percentage: z.number(),
  }),
  database: z.object({
    status: z.enum(["connected", "disconnected", "error"]),
    latency: z.number().optional(),
  }),
  warnings: z.array(
    z.object({
      id: z.string(),
      level: z.enum(["critical", "warn", "info"]),
      title: z.string(),
      detail: z.string(),
      action: z
        .object({
          label: z.string(),
          href: z.string(),
        })
        .nullable()
        .optional(),
    })
  ),
});

// WebSocket message validation
export const wsMessageSchema = z.object({
  type: z.string(),
  payload: z.any().optional(),
});

// Agent device status validation
export const agentDeviceStatusSchema = z.object({
  name: z.string(),
  connected: z.boolean(),
  version: z.string().optional(),
  fake: z.boolean().optional(),
  streamCount: z.number().optional(),
  uptimeSec: z.number().optional(),
  memMb: z.number().optional(),
  lastSeenAt: z.string().optional(),
  roots: z.record(z.string()).optional(),
  tmuxSessions: z
    .array(
      z.object({
        name: z.string(),
        path: z.string().optional(),
        windowCount: z.number().optional(),
        windows: z
          .array(
            z.object({
              index: z.number(),
              id: z.string(),
              name: z.string(),
              target: z.string(),
              path: z.string().optional(),
            })
          )
          .optional(),
      })
    )
    .optional(),
});

// Error response validation
export const errorResponseSchema = z.object({
  error: z.string(),
  details: z.any().optional(),
});

// Utility function to validate request body
export function validateRequestBody<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    const errors = result.error.errors.map(err => ({
      field: err.path.join("."),
      message: err.message,
    }));
    throw new Error(`Validation failed: ${JSON.stringify(errors)}`);
  }
  return result.data;
}

// Utility function to validate query parameters
export function validateQueryParams<T>(schema: z.ZodSchema<T>, params: unknown): T {
  const result = schema.safeParse(params);
  if (!result.success) {
    const errors = result.error.errors.map(err => ({
      field: err.path.join("."),
      message: err.message,
    }));
    throw new Error(`Query validation failed: ${JSON.stringify(errors)}`);
  }
  return result.data;
}
