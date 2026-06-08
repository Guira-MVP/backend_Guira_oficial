-- 20260608_search_payment_order_ids_function.sql
--
-- RPC para resolver coincidencias de payment_orders por fragmento de su id.
-- `id` es uuid y Postgres no tiene operador ilike (~~*) para ese tipo —
-- requiere castear a text primero. PostgREST no soporta `column::cast`
-- dentro de `.or()`, y el cast-en-nombre-de-filtro vía el cliente JS
-- (`.filter('id::text', 'ilike', ...)`) tampoco resuelve el cast como se
-- espera, por lo que la consulta fallaba en silencio (error descartado en
-- listAllOrders) y la búsqueda por ID nunca devolvía resultados.
--
-- Resolver el cast dentro de una función SQL nativa evita depender de esa
-- sintaxis y deja el filtrado en manos del motor de base de datos.

CREATE OR REPLACE FUNCTION search_payment_order_ids(term text)
RETURNS TABLE(id uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT po.id
  FROM payment_orders po
  WHERE po.id::text ILIKE '%' || term || '%'
  LIMIT 50
$$;
