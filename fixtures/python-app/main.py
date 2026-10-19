"""Check books out of a small library."""
from library.inventory import Catalog
from library.storage import record


def checkout(catalog: Catalog, title: str) -> str:
    """Take an available book and record the loan."""
    book = catalog.find(title)
    if book is None:
        raise ValueError("Book is not available")
    record(book)
    return book.title


def main():
    catalog = Catalog()
    print(checkout(catalog, "The Left Hand of Darkness"))


if __name__ == "__main__":
    main()
