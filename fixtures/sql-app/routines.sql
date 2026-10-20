-- Database logic for reserving a book.

SET search_path TO public;

CREATE FUNCTION public.reserve(book_id integer) RETURNS boolean
LANGUAGE plpgsql AS $body$
BEGIN
    UPDATE public.books SET available = false WHERE id = book_id AND available;
    INSERT INTO public.reservations (book_id) VALUES (book_id);
    RETURN FOUND;
END;
$body$;

CREATE FUNCTION public.checkout(book_id integer) RETURNS boolean
LANGUAGE sql AS $$
    SELECT public.reserve(book_id);
$$;

CREATE PROCEDURE public.checkout_first()
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM public.checkout(1);
END;
$$;
