export type TomlPrimitive = string | string[];

export function renderToml(values: Record<string, TomlPrimitive>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${assertSafeKey(key)} = ${renderValue(value)}`)
    .join("\n")}\n`;
}

export function tomlBasicString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\\n")}"`;
}

function renderValue(value: TomlPrimitive): string {
  if (Array.isArray(value)) return `[${value.map(tomlBasicString).join(", ")}]`;
  return tomlBasicString(value);
}

function assertSafeKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`unsafe TOML key: ${key}`);
  return key;
}
