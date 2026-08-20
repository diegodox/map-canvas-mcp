const HOST_DATA_KEYS = [
  "structuredContent",
  "structured_content",
  "toolOutput",
  "toolInput",
  "toolResponseMetadata",
  "mcp_tool_result",
  "call_tool_result",
  "result",
  "output",
  "input",
  "arguments",
  "params",
  "data",
  "_meta",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function findHostData<T>(
  value: unknown,
  parse: (candidate: unknown) => T | undefined,
  depth = 0,
  seen = new Set<object>(),
): T | undefined {
  const direct = parse(value);
  if (direct !== undefined) return direct;
  if (!isRecord(value) || depth >= 8 || seen.has(value)) return undefined;

  seen.add(value);
  for (const key of HOST_DATA_KEYS) {
    const nested = findHostData(value[key], parse, depth + 1, seen);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
