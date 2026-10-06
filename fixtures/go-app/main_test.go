package main

import (
	"testing"

	"example.com/library/inventory"
)

func TestCheckoutMarksBookUnavailable(t *testing.T) {
	catalog := inventory.NewCatalog()
	catalog.Add(inventory.Book{Title: "A book", Available: true})
	if _, err := checkout(catalog, "A book"); err != nil {
		t.Fatalf("checkout failed: %v", err)
	}
	if _, ok := catalog.FindAvailable("A book"); ok {
		t.Fatal("book is still available")
	}
}
