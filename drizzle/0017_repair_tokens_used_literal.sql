-- Migration 0001 copied "tokens_used" from a table that had no such column;
-- SQLite reads an unknown double-quoted identifier as a string literal, so
-- every analysis run of that time got the text 'tokens_used'. Reading it as
-- an integer threw and took down those submissions' pages. The real count
-- was never recorded, so it is unknown.
UPDATE `analysis_runs` SET `tokens_used` = NULL WHERE `tokens_used` IS NOT NULL AND typeof(`tokens_used`) <> 'integer';
