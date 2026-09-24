CREATE TABLE book (
  id integer PRIMARY KEY autoincrement, title text, authors text, last_open integer,
  pages integer, series text, total_read_time integer);
CREATE TABLE page_stat_data (
  id_book integer, page integer NOT NULL DEFAULT 0, start_time integer NOT NULL DEFAULT 0,
  duration integer NOT NULL DEFAULT 0, total_pages integer NOT NULL DEFAULT 0);
INSERT INTO book VALUES (1,'旧库的书','Ancient',strftime('%s','2026-09-15 12:00:00'),100,'Old Series',5000);
INSERT INTO page_stat_data VALUES (1,40,strftime('%s','2026-09-15 12:00:00'),600,100);
