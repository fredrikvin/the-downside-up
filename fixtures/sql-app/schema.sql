-- A small book catalog used by the checkout routines.

CREATE TABLE public.books (
    id integer PRIMARY KEY,
    title text NOT NULL,
    available boolean NOT NULL DEFAULT true
);

CREATE TABLE public.reservations (
    book_id integer REFERENCES public.books(id)
);

ALTER TABLE ONLY public.books ADD CONSTRAINT books_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.books ADD CONSTRAINT books_title_key UNIQUE (title);
CREATE INDEX available_titles ON public.books(title) WHERE available;

CREATE TYPE public.checkout_status AS ENUM ('reserved', 'returned');

CREATE SEQUENCE public.reservation_id_seq START WITH 1 INCREMENT BY 1;

CREATE VIEW public.available_books AS
SELECT id, title FROM public.books WHERE available;
