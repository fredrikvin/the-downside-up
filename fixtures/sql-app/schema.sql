-- A small book catalog used by the checkout routines.

CREATE TABLE public.books (
    id integer PRIMARY KEY,
    title text NOT NULL,
    available boolean NOT NULL DEFAULT true
);

CREATE TABLE public.reservations (
    book_id integer REFERENCES public.books(id)
);

CREATE VIEW public.available_books AS
SELECT id, title FROM public.books WHERE available;
