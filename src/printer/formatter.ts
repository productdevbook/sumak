const KEYWORDS = new Set([
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "JOIN",
  "INNER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "ON",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "RETURNING",
  "WITH",
  "WITH RECURSIVE",
  "UNION",
  "UNION ALL",
  "INTERSECT",
  "EXCEPT",
  "FOR UPDATE",
  "ON CONFLICT",
  "DO NOTHING",
  "DO UPDATE SET",
]);

export interface FormatOptions {
  indent?: string;
  uppercase?: boolean;
}

export function formatSQL(sql: string, options: FormatOptions = {}): string {
  const indent = options.indent ?? "  ";
  const lines: string[] = [];
  let depth = 0;

  const tokens = tokenize(sql);
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i]!;

    if (token === "(") {
      depth++;
      appendToLastLine(lines, token);
      i++;
      continue;
    }

    if (token === ")") {
      depth = Math.max(0, depth - 1);
      appendToLastLine(lines, token);
      i++;
      continue;
    }

    const twoToken = i + 1 < tokens.length ? `${token} ${tokens[i + 1]}` : "";
    const threeToken = i + 2 < tokens.length ? `${token} ${tokens[i + 1]} ${tokens[i + 2]}` : "";

    if (KEYWORDS.has(threeToken.toUpperCase())) {
      lines.push(`${indent.repeat(depth)}${threeToken}`);
      i += 3;
      continue;
    }

    if (KEYWORDS.has(twoToken.toUpperCase())) {
      lines.push(`${indent.repeat(depth)}${twoToken}`);
      i += 2;
      continue;
    }

    if (KEYWORDS.has(token.toUpperCase())) {
      lines.push(`${indent.repeat(depth)}${token}`);
      i++;
      continue;
    }

    appendToLastLine(lines, token);
    i++;
  }

  return lines.join("\n");
}

function appendToLastLine(lines: string[], token: string): void {
  if (lines.length === 0) {
    lines.push(token);
  } else {
    lines[lines.length - 1] += ` ${token}`;
  }
}

function tokenize(sql: string): string[] {
  const tokens: string[] = [];
  let current = "";

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;

    if (ch === "'" || ch === '"') {
      current += ch;
      i++;
      while (i < sql.length && sql[i] !== ch) {
        if (sql[i] === ch && i + 1 < sql.length && sql[i + 1] === ch) {
          current += ch + ch;
          i += 2;
          continue;
        }
        current += sql[i];
        i++;
      }
      if (i < sql.length) current += sql[i];
      continue;
    }

    if (ch === "(" || ch === ")") {
      if (current.trim()) {
        tokens.push(current.trim());
        current = "";
      }
      tokens.push(ch);
      continue;
    }

    if (ch === "," || ch === ";") {
      if (current.trim()) {
        tokens.push(current.trim());
        current = "";
      }
      tokens.push(ch);
      continue;
    }

    if (/\s/.test(ch)) {
      if (current.trim()) {
        tokens.push(current.trim());
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}
