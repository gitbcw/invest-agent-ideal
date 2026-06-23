export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const parts = [error.name, error.message].filter(Boolean);
    return parts.length ? parts.join(": ") : "Error";
  }

  if (typeof error === "string") return error;
  if (error === null || error === undefined) return String(error);

  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of ["name", "code", "message", "reason", "status"]) {
      const value = record[key];
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}=${value}`);
      }
    }
    if (parts.length) {
      const detail = stringifyErrorObject(record);
      return detail ? `${parts.join(" ")} ${detail}` : parts.join(" ");
    }

    const detail = stringifyErrorObject(record);
    if (detail) return detail;
  }

  return String(error);
}

function stringifyErrorObject(value: Record<string, unknown>) {
  try {
    return JSON.stringify(value, (_key, nested) => {
      if (nested instanceof Error) {
        return {
          name: nested.name,
          message: nested.message,
          stack: nested.stack,
        };
      }
      return nested;
    });
  } catch {
    return "";
  }
}
