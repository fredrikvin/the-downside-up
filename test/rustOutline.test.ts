import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Description } from "../src/context/outlineText";
import { initializeRustParserAt } from "../src/languages/rust/syntax";
import { describeRustSource } from "../src/languages/rust/outline";

const flat = (description: Description): string =>
  description.map((segment) => (segment.code ? `\`${segment.text}\`` : segment.text)).join("");

async function outline(source: string) {
  const result = await describeRustSource(source);
  return {
    purpose: result.purpose,
    entries: [...result.drafts].sort((left, right) => left.startLine - right.startLine || left.depth - right.depth)
  };
}

const fixture = (name: string) => readFileSync(resolve("fixtures/rust-app/src", name), "utf8");

beforeAll(async () => {
  await initializeRustParserAt(resolve("."));
});

describe("Rust local descriptions", () => {
  it("describes the fixture's main.rs in source order", async () => {
    const { entries } = await outline(fixture("main.rs"));
    expect(entries.map((entry) => [entry.startLine, entry.depth, entry.kindLabel, flat(entry.description)])).toEqual([
      [0, 0, "Module", "Module `inventory`, loaded from `inventory.rs` or `inventory/mod.rs`."],
      [1, 0, "Module", "Module `storage`, loaded from `storage.rs` or `storage/mod.rs`."],
      [3, 0, "Import", "Imports `Book` and `Catalog` from `inventory`."],
      [4, 0, "Import", "Imports `persist` and `StoreError` from `storage`."],
      [6, 0, "Function", "Function `main` takes no arguments and returns nothing."],
      [7, 1, "Local", "Declares mutable local `catalog`, set to `Catalog::default()`."],
      [19, 0, "Function", "Function `checkout` takes `catalog` (`&mut Catalog`) and `title` (`&str`) and returns `Result<Book, StoreError>`."],
      [20, 1, "Local", "Declares local `book`, set to `catalog.find_available(title).ok_or_else(|| StoreError::Unavailable(title.to_ow…`."],
      [29, 0, "Module", "Inline module `tests`."],
      [31, 1, "Import", "Imports everything public from `super` (the parent module)."],
      [33, 1, "Function", "Function `checkout_marks_matching_book_unavailable` takes no arguments and returns nothing."],
      [35, 2, "Local", "Declares mutable local `catalog`, set to `Catalog::default()`."]
    ]);
    const notes = (index: number) => entries[index]!.notes.map(flat);
    expect(notes(4)).toEqual(["Program entry point: runs when the binary starts."]);
    expect(notes(8)).toEqual(["Compiled only when running tests (`#[cfg(test)]`)."]);
    expect(notes(10)).toEqual(["Runs as a unit test (`#[test]`)."]);
    expect(entries.filter((entry) => entry.explainable).map((entry) => entry.name)).toEqual([
      "main", "checkout", "checkout_marks_matching_book_unavailable"
    ]);
    expect(entries[6]).toMatchObject({ nameLine: 19, nameStart: 3, nameEnd: 11, endLine: 27 });
  });

  it("describes methods inside implementations with their receivers", async () => {
    const { entries } = await outline(fixture("inventory.rs"));
    expect(entries.map((entry) => flat(entry.description))).toEqual([
      "Public struct `Book` with fields `title` (`String`, public) and `available` (`bool`, public).",
      "Public struct `Catalog` with field `books` (`Vec<Book>`).",
      "Methods and associated functions of `Catalog`.",
      "Public method `add` of `Catalog` borrows the value mutably (`&mut self`), takes `book` (`Book`), and returns nothing.",
      "Public method `find_available` of `Catalog` borrows the value (`&self`), takes `title` (`&str`), and returns `Option<Book>`.",
      "Public method `mark_unavailable` of `Catalog` borrows the value mutably (`&mut self`), takes `title` (`&str`), and returns nothing."
    ]);
    expect(entries[0]!.notes.map(flat)).toEqual(["Derives `Clone`, `Debug`, `PartialEq`, and `Eq`."]);
    expect(entries[0]!.startLine).toBe(0);
    expect(entries[3]!.qualifiedName).toBe("Catalog::add");
  });

  it("attaches documentation, keeps standalone comments, and reads crate docs as the file purpose", async () => {
    const { purpose, entries } = await outline([
      "//! Inventory helpers.",
      "use std::{fmt, io::{self, Read as R}};",
      "",
      "/// Maximum number of books.",
      "pub const MAX: usize = 10;",
      "",
      "// Storage section.",
      "",
      "// Applies to the next item.",
      "pub(crate) static mut COUNT: u32 = 0;",
      "pub type Id = u64;",
      "enum Event { Added(String), Removed { id: u64 }, Cleared }",
      "pub trait Shelf: fmt::Debug { fn len(&self) -> usize; }",
      "impl std::error::Error for Event {}",
      "macro_rules! log { () => {} }"
    ].join("\n"));
    expect(purpose).toBe("Inventory helpers.");
    expect(entries.map((entry) => [entry.startLine, entry.kindLabel, flat(entry.description), entry.documentation ?? ""])).toEqual([
      [1, "Import", "Imports `fmt` and `io` from `std` (the standard library) and `Read` as `R` from `std::io` (the standard library).", ""],
      [3, "Constant", "Public constant `MAX` of type `usize`, set to `10`.", "Maximum number of books."],
      [6, "Comment", "Storage section.", ""],
      [8, "Static", "Crate-visible mutable static `COUNT` of type `u32`, set to `0`.", "Applies to the next item."],
      [10, "Type alias", "Public type alias `Id` for `u64`.", ""],
      [11, "Enum", "Enum `Event` with variants `Added` (holding `String`), `Removed` (with `id`), and `Cleared`.", ""],
      [12, "Trait", "Public trait `Shelf` requiring `fmt::Debug`.", ""],
      [12, "Required method", "Required method `len` of trait `Shelf` borrows the value (`&self`) and returns `usize`.", ""],
      [13, "Trait implementation", "Implements `std::error::Error` for `Event`, using only the trait's default methods.", ""],
      [14, "Macro", "Defines the macro `log!` with `macro_rules!`.", ""]
    ]);
    expect(entries.find((entry) => entry.kindLabel === "Required method")?.explainable).toBe(false);
  });
});
