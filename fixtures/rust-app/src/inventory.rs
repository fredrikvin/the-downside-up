#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Book {
    pub title: String,
    pub available: bool,
}

#[derive(Default)]
pub struct Catalog {
    books: Vec<Book>,
}

impl Catalog {
    pub fn add(&mut self, book: Book) {
        self.books.push(book);
    }

    pub fn find_available(&self, title: &str) -> Option<Book> {
        self.books
            .iter()
            .find(|book| book.available && book.title == title)
            .cloned()
    }

    pub fn mark_unavailable(&mut self, title: &str) {
        if let Some(book) = self.books.iter_mut().find(|book| book.title == title) {
            book.available = false;
        }
    }
}
