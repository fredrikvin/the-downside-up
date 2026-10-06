import { persist } from "./storage.js";

export function checkout(catalog, title) {
  const book = catalog.find((item) => item.available && item.title === title);
  if (!book) {
    throw new Error(`Book not available: ${title}`);
  }

  persist(book);
  book.available = false;
  return book;
}

export function describeCatalog(catalog) {
  return catalog.map((book) => book.title);
}
