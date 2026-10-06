package inventory

// FindAvailable returns the first available book with the title.
func (c *Catalog) FindAvailable(title string) (Book, bool) {
	for _, book := range c.books {
		if book.Available && book.Title == title {
			return book, true
		}
	}
	return Book{}, false
}

// MarkUnavailable marks every book with the title as checked out.
func (c *Catalog) MarkUnavailable(title string) {
	for i := range c.books {
		if c.books[i].Title == title {
			c.books[i].Available = false
		}
	}
}
