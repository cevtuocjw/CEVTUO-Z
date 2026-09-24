-- Book table is fine; page_stat_data is missing entirely.
-- The progress and daily queries must fail without taking the export down.
CREATE TABLE book (
  id integer PRIMARY KEY autoincrement, title text, authors text, notes integer,
  last_open integer, highlights integer, pages integer, series text, language text,
  md5 text, total_read_time integer, total_read_pages integer);
INSERT INTO book (title,authors,notes,last_open,highlights,pages,total_read_time,total_read_pages)
VALUES ('没有翻页表的书','Solo',0,strftime('%s','2026-09-20 21:00:00'),0,300,9000,150);
