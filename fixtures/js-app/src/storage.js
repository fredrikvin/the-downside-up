export function persist(book) {
  if (!book.title) {
    throw new TypeError("A book needs a title");
  }
}
