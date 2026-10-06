mod inventory;
mod storage;

use inventory::{Book, Catalog};
use storage::{persist, StoreError};

fn main() {
    let mut catalog = Catalog::default();
    catalog.add(Book {
        title: "The Left Hand of Darkness".to_owned(),
        available: true,
    });

    match checkout(&mut catalog, "The Left Hand of Darkness") {
        Ok(book) => println!("Checked out {}", book.title),
        Err(error) => eprintln!("Checkout failed: {error}"),
    }
}

fn checkout(catalog: &mut Catalog, title: &str) -> Result<Book, StoreError> {
    let book = catalog
        .find_available(title)
        .ok_or_else(|| StoreError::Unavailable(title.to_owned()))?;

    persist(&book)?;
    catalog.mark_unavailable(&book.title);
    Ok(book)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_marks_matching_book_unavailable() {
        let mut catalog = Catalog::default();
        catalog.add(Book {
            title: "A book".into(),
            available: true,
        });

        assert!(checkout(&mut catalog, "A book").is_ok());
        assert!(catalog.find_available("A book").is_none());
    }
}
