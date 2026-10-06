package main

import (
	"fmt"

	"example.com/library/inventory"
	"example.com/library/storage"
)

func main() {
	catalog := inventory.NewCatalog()
	catalog.Add(inventory.Book{Title: "The Left Hand of Darkness", Available: true})

	book, err := checkout(catalog, "The Left Hand of Darkness")
	if err != nil {
		fmt.Println("Checkout failed:", err)
		return
	}
	fmt.Println(describe(book))
}

// checkout takes an available book out of the catalog and records it.
func checkout(catalog *inventory.Catalog, title string) (inventory.Book, error) {
	book, ok := catalog.FindAvailable(title)
	if !ok {
		return inventory.Book{}, &storage.StoreError{Title: title}
	}
	if err := storage.Persist(book); err != nil {
		return inventory.Book{}, err
	}
	catalog.MarkUnavailable(book.Title)
	return book, nil
}
