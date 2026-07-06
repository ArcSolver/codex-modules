export type TomlPrimitive = string | string[];

export function renderToml(values: Record<string, TomlPrimitive>): string {
  return `${Object.entries(values)
    .map(([key, value]) => `${assertSafeKey(key)} = ${renderValue(value)}`)
    .join("\n")}\n`;
}

export function tomlBasicString(value: string): string {
  let rendered = '"';
  for (const char of value.replace(/\r\n/g, "\n").replace(/\r/g, "\n")) {
    const code = char.charCodeAt(0);
    if (char === "\b") rendered += "\\b";
    else if (char === "\t") rendered += "\\t";
    else if (char === "\n") rendered += "\\n";
    else if (char === "\f") rendered += "\\f";
    else if (char === '"') rendered += '\\"';
    else if (char === "\\") rendered += "\\\\";
    else if (code === 0x7f || code < 0x20) rendered += `\\u${code.toString(16).padStart(4, "0")}`;
    else rendered += char;
  }
  return `${rendered}"`;
}

function renderValue(value: TomlPrimitive): string {
  if (Array.isArray(value)) return `[${value.map(tomlBasicString).join(", ")}]`;
  return tomlBasicString(value);
}

function assertSafeKey(key: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`unsafe TOML key: ${key}`);
  return key;
}
