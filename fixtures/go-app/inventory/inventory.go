// Package inventory keeps the library's catalog of books.
package inventory

// Book is a title and whether it can be checked out.
type Book struct {
	Title     string
	Available bool
}

// Catalog holds the books the library owns.
type Catalog struct {
	books []Book
}

// NewCatalog returns an empty catalog.
func NewCatalog() *Catalog {
	return &Catalog{}
}

// Add appends a book to the catalog.
func (c *Catalog) Add(book Book) {
	c.books = append(c.books, book)
}
