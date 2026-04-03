import { describe, expect, it } from "vitest";
import {
  concat,
  empty,
  group,
  join,
  line,
  nest,
  render,
  text,
} from "../../src/printer/document.ts";

describe("Document algebra", () => {
  it("renders empty", () => {
    expect(render(empty())).toBe("");
  });

  it("renders text", () => {
    expect(render(text("hello"))).toBe("hello");
  });

  it("renders line as newline in break mode", () => {
    const doc = concat(text("a"), line(), text("b"));
    expect(render(doc)).toBe("a\nb");
  });

  it("renders group flat when it fits", () => {
    const doc = group(concat(text("a"), line(), text("b")));
    expect(render(doc, 80)).toBe("a b");
  });

  it("renders group broken when too wide", () => {
    const doc = group(concat(text("a".repeat(50)), line(), text("b".repeat(50))));
    expect(render(doc, 80)).toBe("a".repeat(50) + "\n" + "b".repeat(50));
  });

  it("renders nest with indentation", () => {
    const doc = concat(text("SELECT"), nest(2, concat(line(), text('"id"'))));
    expect(render(doc, 10)).toBe('SELECT\n  "id"');
  });

  it("renders nested group flat when fits", () => {
    const doc = group(concat(text("SELECT"), nest(2, concat(line(), text('"id"')))));
    expect(render(doc, 80)).toBe('SELECT "id"');
  });

  it("renders join with separator", () => {
    const items = [text('"id"'), text('"name"'), text('"email"')];
    const doc = join(concat(text(","), line()), items);
    expect(render(group(doc), 80)).toBe('"id", "name", "email"');
  });

  it("breaks join when too wide", () => {
    const items = [
      text('"a_very_long_column_name"'),
      text('"another_long_column"'),
      text('"yet_another"'),
    ];
    const doc = group(join(concat(text(","), line()), items));
    expect(render(doc, 30)).toContain("\n");
  });

  it("renders SQL-like SELECT", () => {
    const cols = join(concat(text(","), line()), [text('"id"'), text('"name"')]);
    const doc = group(
      concat(text("SELECT"), nest(2, concat(line(), cols)), line(), text('FROM "users"')),
    );
    const result = render(doc, 80);
    expect(result).toContain("SELECT");
    expect(result).toContain("FROM");
  });

  it("handles deeply nested documents", () => {
    const inner = group(concat(text("a"), line(), text("b")));
    const mid = group(concat(text("("), nest(2, concat(line(), inner)), line(), text(")")));
    const outer = group(concat(text("SELECT"), nest(2, concat(line(), mid))));

    const wide = render(outer, 80);
    expect(wide).toContain("SELECT");

    const narrow = render(outer, 10);
    expect(narrow).toContain("\n");
  });
});
