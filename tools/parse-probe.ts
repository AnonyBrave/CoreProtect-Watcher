/** Sonde le parseur de tuples sur les lignes INSERT des fixtures (copie locale du code de sqlimport). */
import fs from "node:fs";

function decodeMysqlString(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\" && i + 1 < body.length) {
      const n = body[i + 1];
      switch (n) {
        case "n": out += "\n"; break;
        case "r": out += "\r"; break;
        case "t": out += "\t"; break;
        case "0": out += "\0"; break;
        case "Z": out += "\x1a"; break;
        default: out += n;
      }
      i++;
    } else out += c;
  }
  return out;
}

function hexAt(line: string, start: number): string | null {
  let j = start;
  while (j < line.length && /[0-9a-fA-F]/.test(line[j])) j++;
  if (line[j] !== "'") return null;
  return line.slice(start, j);
}

function parseInsertTuples(line: string): unknown[][] {
  const out: unknown[][] = [];
  const vm = /\bVALUES\b/i.exec(line);
  let i = vm ? vm.index + 6 : line.indexOf("(");
  if (i < 0) return out;
  const n = line.length;
  while (i < n && line[i] !== "(") i++;
  if (i >= n) return out;
  while (i < n) {
    if (line[i] !== "(") break;
    i++;
    const row: unknown[] = [];
    let depth = 1;
    while (i < n && depth > 0) {
      const c = line[i];
      if (c === "'" || c === '"') {
        const q = c;
        let body = "";
        i++;
        while (i < n && line[i] !== q) {
          if (line[i] === "\\" && i + 1 < n) { body += line[i] + line[i + 1]; i += 2; }
          else { body += line[i]; i++; }
        }
        i++;
        row.push(decodeMysqlString(body));
      } else if (c === "X" && line[i + 1] === "'") {
        const hex = hexAt(line, i + 2);
        if (hex !== null) { row.push(Buffer.from(hex, "hex")); i += 2 + hex.length + 1; continue; }
        i++;
      } else if (c === "(") { depth++; i++; }
      else if (c === ")") { depth--; i++; }
      else if (c === ",") { i++; }
      else {
        let tok = "";
        while (i < n && line[i] !== "," && line[i] !== ")" && line[i] !== "(") { tok += line[i]; i++; }
        const t = tok.trim();
        if (!t) continue;
        if (/^NULL$/i.test(t)) row.push(null);
        else if (/^-?\d+(\.\d+)?$/.test(t)) row.push(Number(t));
        else row.push(t.replace(/`/g, ""));
      }
    }
    out.push(row);
    while (i < n && line[i] !== "(") i++;
  }
  return out;
}

for (const f of ["a.sql", "b.sql"]) {
  const text = fs.readFileSync(`data/test-imports/${f}`, "latin1");
  for (const line of text.split("\n")) {
    const head = /INSERT\s+INTO\s+`?(co_[a-z_]+)`?\s*(?:\(([^)]*)\))?\s*VALUES/i.exec(line);
    if (!head) continue;
    const tuples = parseInsertTuples(line);
    console.log(`${f} ${head[1]} : ${tuples.length} tuples, longueurs=${tuples.map((t) => t.length).join(",")}, colonne_explicite=${head[2] ? head[2].split(",").length : "absente"}`);
  }
}
