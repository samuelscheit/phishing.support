-- A website case walks its link more than once (a rotating link shows each visit another offer), so its chain and
-- everything judged from it move into the first of its routes: `navigationHops` becomes the route's `hops`, and
-- `analyzedHopIndex`, `siteAssessments`, `funnel` and `visit` move along as they are. Route 0 keeps the artifact names
-- the single chain had, so no artifact row changes. A case without a chain has no route; its stray keys go.
-- JSON is only read from rows a MATERIALIZED step found valid: SQLite does not promise to test `json_valid` before
-- another term of the same WHERE, and one malformed row would make json_each or json_extract fail the whole migration.
-- A case that already has routes was written by the new code and is left alone, so running this again changes nothing.
-- The route is gathered with json_each rather than json_patch: a merge patch would also drop the null members nested
-- inside the funnel or visit it copies, where json_each takes each value whole. Each value is read back through its
-- path and json(), because json_each's own value loses its JSON mark on the way through GROUP BY and would be
-- stored as a string holding the JSON.
WITH `websites` AS MATERIALIZED (
	SELECT `id`, `data` FROM `submissions` WHERE `kind` = 'website' AND json_valid(`data`)
), `single_chain` AS MATERIALIZED (
	SELECT `id`, `data` FROM `websites`
	WHERE json_type(`data`, '$.website') = 'object' AND json_type(`data`, '$.website.routes') IS NULL AND (
		json_type(`data`, '$.website.navigationHops') IS NOT NULL OR json_type(`data`, '$.website.analyzedHopIndex') IS NOT NULL
		OR json_type(`data`, '$.website.siteAssessments') IS NOT NULL OR json_type(`data`, '$.website.funnel') IS NOT NULL
		OR json_type(`data`, '$.website.visit') IS NOT NULL)
), `first_route`(`id`, `route`) AS MATERIALIZED (
	SELECT `single_chain`.`id`, json_group_object(
		CASE `field`.`key` WHEN 'navigationHops' THEN 'hops' ELSE `field`.`key` END, json(`single_chain`.`data` -> `field`.`fullkey`)
		ORDER BY CASE `field`.`key` WHEN 'navigationHops' THEN 0 WHEN 'analyzedHopIndex' THEN 1 WHEN 'siteAssessments' THEN 2 WHEN 'funnel' THEN 3 ELSE 4 END)
	FROM `single_chain`, json_each(`single_chain`.`data`, '$.website') `field`
	WHERE json_type(`single_chain`.`data`, '$.website.navigationHops') = 'array'
		AND `field`.`key` IN ('navigationHops', 'analyzedHopIndex', 'siteAssessments', 'funnel', 'visit') AND `field`.`type` <> 'null'
	GROUP BY `single_chain`.`id`
)
UPDATE `submissions` SET `data` = json_remove(
	COALESCE((SELECT json_set(`data`, '$.website.routes', json_array(json(`route`))) FROM `first_route` WHERE `first_route`.`id` = `submissions`.`id`), `data`),
	'$.website.navigationHops', '$.website.analyzedHopIndex', '$.website.siteAssessments', '$.website.funnel', '$.website.visit')
WHERE `id` IN (SELECT `id` FROM `single_chain`);
