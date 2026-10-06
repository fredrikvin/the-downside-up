package main

import (
	"fmt"

	"example.com/library/inventory"
)

// describe formats a checked-out book for the console.
func describe(book inventory.Book) string {
	return fmt.Sprintf("Checked out %s", book.Title)
}
