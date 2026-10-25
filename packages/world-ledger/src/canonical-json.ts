function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Canonical JSON does not support non-finite numbers");
      }
      return JSON.stringify(value);
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      throw new TypeError(`Canonical JSON does not support ${typeof value}`);
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    throw new TypeError("Canonical JSON does not support cyclic values");
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError("Canonical JSON does not support symbol-keyed properties");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError("Canonical JSON does not support sparse arrays");
        }
        items.push(encode(value[index], ancestors));
      }
      return `[${items.join(",")}]`;
    }

    if (!isPlainObject(value)) {
      throw new TypeError("Canonical JSON only supports plain objects");
    }

    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(value[key], ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}
