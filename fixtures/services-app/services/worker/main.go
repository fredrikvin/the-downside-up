package main

import "fmt"

// process works through one queued order.
func process(id string) {
	fmt.Println("processed", id)
}

func main() {
	process("demo")
}
