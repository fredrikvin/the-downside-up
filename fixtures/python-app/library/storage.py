"""Record loans."""
from .inventory import Book

LOANS = []


def record(book: Book):
    """Keep the title of a checked-out book."""
    LOANS.append(book.title)
