// Package storage records checkouts.
package storage

import (
	"fmt"

	"example.com/library/inventory"
)

// MaxTitleLength is the longest title that can be stored.
const MaxTitleLength = 120

// StoreError reports a book that could not be stored.
type StoreError struct {
	Title string
}

func (e *StoreError) Error() string {
	return fmt.Sprintf("book not available: %s", e.Title)
}

// Persist records a checked-out book.
func Persist(book inventory.Book) error {
	if book.Title == "" || len(book.Title) > MaxTitleLength {
		return &StoreError{Title: book.Title}
	}
	return nil
}
