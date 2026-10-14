package main

import "fmt"

// handleOrder accepts an order from the web app and queues it for the worker.
func handleOrder(id string) string {
	return fmt.Sprintf("queued %s", id)
}

func main() {
	fmt.Println(handleOrder("demo"))
}
