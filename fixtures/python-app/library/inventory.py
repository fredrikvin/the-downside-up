"""Keep the library's books available."""


class Book:
    """A book and its availability."""

    def __init__(self, title: str):
        self.title = title
        self.available = True


class Catalog:
    """Find and reserve books."""

    def __init__(self):
        self.books = [Book("The Left Hand of Darkness")]

    def find(self, title: str):
        """Return the first available matching book."""
        for book in self.books:
            if book.title == title and book.available:
                self.reserve(book)
                return book
        return None

    def reserve(self, book: Book):
        book.available = False
