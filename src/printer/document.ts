/**
 * Wadler-style pretty printer document algebra.
 *
 * Based on "A prettier printer" (Wadler 1998) and "Strictly Pretty" (Lindig 2000).
 * Used to format SQL output with width-sensitive line breaking.
 */

export type Doc =
  | { tag: "empty" }
  | { tag: "text"; text: string }
  | { tag: "line" }
  | { tag: "nest"; indent: number; doc: Doc }
  | { tag: "group"; doc: Doc }
  | { tag: "concat"; docs: Doc[] };

export function empty(): Doc {
  return { tag: "empty" };
}

export function text(s: string): Doc {
  return { tag: "text", text: s };
}

/** A line break. In flat mode, renders as a single space. */
export function line(): Doc {
  return { tag: "line" };
}

/** Increase indentation for the nested document. */
export function nest(indent: number, doc: Doc): Doc {
  return { tag: "nest", indent, doc };
}

/** Try to render flat; if too wide, break lines. */
export function group(doc: Doc): Doc {
  return { tag: "group", doc };
}

/** Concatenate documents. */
export function concat(...docs: Doc[]): Doc {
  const filtered = docs.filter((d) => d.tag !== "empty");
  if (filtered.length === 0) return empty();
  if (filtered.length === 1) return filtered[0]!;
  return { tag: "concat", docs: filtered };
}

/** Join documents with a separator. */
export function join(sep: Doc, docs: Doc[]): Doc {
  if (docs.length === 0) return empty();
  const result: Doc[] = [];
  for (let i = 0; i < docs.length; i++) {
    if (i > 0) result.push(sep);
    result.push(docs[i]!);
  }
  return concat(...result);
}

/** Convenience: text + line */
export function textLine(s: string): Doc {
  return concat(text(s), line());
}

/**
 * Render a document to a string.
 *
 * Uses Wadler/Lindig's algorithm: maintain a stack of (indent, mode, doc) triples.
 * mode = "flat" (try single line) or "break" (use line breaks).
 */
export function render(doc: Doc, width = 80): string {
  type Mode = "flat" | "break";
  type StackItem = [number, Mode, Doc]; // [indent, mode, doc]

  let output = "";
  let col = 0;
  const stack: StackItem[] = [[0, "break", doc]];

  while (stack.length > 0) {
    const [indent, mode, d] = stack.pop()!;

    switch (d.tag) {
      case "empty":
        break;

      case "text":
        output += d.text;
        col += d.text.length;
        break;

      case "line":
        if (mode === "flat") {
          output += " ";
          col += 1;
        } else {
          output += "\n" + " ".repeat(indent);
          col = indent;
        }
        break;

      case "nest":
        stack.push([indent + d.indent, mode, d.doc]);
        break;

      case "group":
        if (mode === "flat") {
          stack.push([indent, "flat", d.doc]);
        } else {
          // Try flat: measure if it fits
          const flat = measureFlat(d.doc);
          if (flat !== null && col + flat <= width) {
            stack.push([indent, "flat", d.doc]);
          } else {
            stack.push([indent, "break", d.doc]);
          }
        }
        break;

      case "concat":
        // Push in reverse order so first doc is processed first
        for (let i = d.docs.length - 1; i >= 0; i--) {
          stack.push([indent, mode, d.docs[i]!]);
        }
        break;
    }
  }

  return output;
}

/**
 * Measure the flat width of a document.
 * Returns null if the document contains a hard line break that can't be flattened.
 */
function measureFlat(doc: Doc): number | null {
  let width = 0;
  const stack: Doc[] = [doc];

  while (stack.length > 0) {
    const d = stack.pop()!;

    switch (d.tag) {
      case "empty":
        break;
      case "text":
        width += d.text.length;
        break;
      case "line":
        width += 1; // space in flat mode
        break;
      case "nest":
        stack.push(d.doc);
        break;
      case "group":
        stack.push(d.doc);
        break;
      case "concat":
        for (let i = d.docs.length - 1; i >= 0; i--) {
          stack.push(d.docs[i]!);
        }
        break;
    }
  }

  return width;
}
