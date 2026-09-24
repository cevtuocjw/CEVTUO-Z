CREATE TABLE IF NOT EXISTS book (
  id integer PRIMARY KEY autoincrement,
  title text, authors text, notes integer, last_open integer,
  highlights integer, pages integer, series text, language text,
  md5 text, total_read_time integer, total_read_pages integer);
CREATE UNIQUE INDEX IF NOT EXISTS book_title_authors_md5 ON book(title, authors, md5);
CREATE TABLE IF NOT EXISTS page_stat_data (
  id_book integer, page integer NOT NULL DEFAULT 0,
  start_time integer NOT NULL DEFAULT 0, duration integer NOT NULL DEFAULT 0,
  total_pages integer NOT NULL DEFAULT 0,
  UNIQUE (id_book, page, start_time),
  FOREIGN KEY(id_book) REFERENCES book(id));
CREATE INDEX IF NOT EXISTS page_stat_data_start_time ON page_stat_data(start_time);

INSERT INTO book (title,authors,notes,last_open,highlights,pages,series,language,md5,total_read_time,total_read_pages) VALUES
 ('深度工作','Cal Newport',2,strftime('%s','2026-09-20 21:00:00'),5,300,NULL,'zh','m1',36000,250),
 ('It''s a test','Some One',0,strftime('%s','2026-09-19 10:00:00'),0,200,'Series A','en','m2',20000,200),
 ('line1'||char(10)||'line2','Two Lines',0,strftime('%s','2026-09-18 10:00:00'),0,NULL,NULL,'en','m3',1200,10),
 ('未读的书','Nobody',0,strftime('%s','2026-09-17 10:00:00'),0,150,NULL,'zh','m4',0,0),
 ('空书','Nobody',NULL,NULL,NULL,400,NULL,NULL,'m5',0,0);

INSERT INTO page_stat_data (id_book,page,start_time,duration,total_pages) VALUES
 (1,10,strftime('%s','2026-09-10 21:00:00'),600,300),
 (1,250,strftime('%s','2026-09-20 21:00:00'),900,300),
 (1,0,strftime('%s','2026-09-21 21:00:00'),5,300),
 (2,120,strftime('%s','2026-09-19 09:00:00'),700,200),
 (2,200,strftime('%s','2026-09-19 10:00:00'),1200,200),
 (3,10,strftime('%s','2026-09-18 10:00:00'),300,120);
