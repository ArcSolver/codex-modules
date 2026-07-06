import fs from "node:fs";
import readline from "node:readline";

export interface JsonlLine {
  lineNo: number;
  value: unknown;
}

export async function* readJsonl(filePath: string): AsyncGenerator<JsonlLine> {
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNo = 0;

  for await (const rawLine of rl) {
    lineNo += 1;
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      yield { lineNo, value: JSON.parse(line) as unknown };
    } catch (error) {
      yield {
        lineNo,
        value: {
          __parse_error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}
