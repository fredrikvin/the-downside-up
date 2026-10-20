-- name: GetAvailableBooks :many
SELECT id, title
FROM public.books
WHERE available = true
ORDER BY title;

-- name: ReserveBook :execrows
UPDATE public.books
SET available = false
WHERE id = sqlc.arg('book_id');

SELECT COUNT(*) FROM public.reservations;
