use crate::inventory::Book;

#[derive(Debug)]
pub enum StoreError {
    Unavailable(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(title) => write!(formatter, "book not available: {title}"),
        }
    }
}

impl std::error::Error for StoreError {}

pub fn persist(book: &Book) -> Result<(), StoreError> {
    if book.title.is_empty() {
        return Err(StoreError::Unavailable(book.title.clone()));
    }
    Ok(())
}
