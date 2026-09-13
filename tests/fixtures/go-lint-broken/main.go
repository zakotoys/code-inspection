package main

import "fmt"

func main() {
	var unused int
	fmt.Printf("value: %d\n", "not an integer")
	_ = unused
}
