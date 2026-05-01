import pool from '../config/database';
import { Car, Media, FileType } from '../types';
import { AIAnalysis, SmartSearchResult } from '../ai/analyzer';

// === CARS ===

export async function getAllCars(): Promise<Car[]> {
    const result = await pool.query<Car>(
        'SELECT * FROM cars ORDER BY name ASC'
    );
    return result.rows;
}

export async function getCarById(id: number): Promise<Car | undefined> {
    const result = await pool.query<Car>(
        'SELECT * FROM cars WHERE id = $1',
        [id]
    );
    return result.rows[0];
}

export async function createCar(
    name: string,
    description: string | null = null
): Promise<Car> {
    const result = await pool.query<Car>(
        'INSERT INTO cars (name, description) VALUES ($1, $2) RETURNING *',
        [name, description]
    );
    return result.rows[0];
}

export async function deleteCar(id: number): Promise<void> {
    await pool.query('DELETE FROM cars WHERE id = $1', [id]);
}

// === MEDIA ===

export async function getMediaByCarId(
    carId: number,
    limit: number = 10,
    offset: number = 0
): Promise<Media[]> {
    const result = await pool.query<Media>(
        `SELECT * FROM media 
         WHERE car_id = $1 
         ORDER BY 
            CASE WHEN file_type = 'video' THEN 0 ELSE 1 END,
            created_at DESC 
         LIMIT $2 OFFSET $3`,
        [carId, limit, offset]
    );
    return result.rows;
}

export async function getMediaCount(carId: number): Promise<number> {
    const result = await pool.query<{ count: string }>(
        'SELECT COUNT(*) FROM media WHERE car_id = $1',
        [carId]
    );
    return parseInt(result.rows[0].count);
}

export async function addMedia(
    carId: number,
    fileId: string,
    fileType: FileType,
    caption: string | null = null
): Promise<Media> {
    const result = await pool.query<Media>(
        `INSERT INTO media (car_id, file_id, file_type, caption) 
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [carId, fileId, fileType, caption]
    );
    return result.rows[0];
}

export async function deleteMedia(id: number): Promise<void> {
    await pool.query('DELETE FROM media WHERE id = $1', [id]);
}

// === AI ===

export async function updateMediaAI(
    mediaId: number,
    analysis: AIAnalysis
): Promise<void> {
    await pool.query(
        `UPDATE media SET 
            ai_description = $1,
            ai_tags = $2,
            ai_colors = $3,
            ai_material = $4,
            ai_style = $5,
            ai_placement = $6,
            ai_analyzed = TRUE
         WHERE id = $7`,
        [
            analysis.description,
            analysis.tags,
            analysis.colors,
            analysis.material,
            analysis.style,
            analysis.placement,
            mediaId
        ]
    );
}

export async function getUnanalyzedMedia(limit: number = 10): Promise<Media[]> {
    const result = await pool.query<Media>(
        `SELECT * FROM media 
         WHERE ai_analyzed = FALSE OR ai_analyzed IS NULL
         ORDER BY created_at ASC
         LIMIT $1`,
        [limit]
    );
    return result.rows;
}

export async function getAIStats(): Promise<{ total: number; analyzed: number; pending: number }> {
    const result = await pool.query<{ total: string; analyzed: string }>(
        `SELECT 
            COUNT(*) as total,
            COUNT(*) FILTER (WHERE ai_analyzed = TRUE) as analyzed
         FROM media`
    );
    const total = parseInt(result.rows[0].total);
    const analyzed = parseInt(result.rows[0].analyzed);
    return { total, analyzed, pending: total - analyzed };
}

export async function resetAllAIAnalysis(): Promise<number> {
    const result = await pool.query(
        `UPDATE media SET 
            ai_analyzed = FALSE,
            ai_description = NULL,
            ai_tags = NULL,
            ai_colors = NULL,
            ai_material = NULL,
            ai_style = NULL,
            ai_placement = NULL`
    );
    return result.rowCount || 0;
}

// ============================================================
// ODDIY SEARCH (eski)
// ============================================================
export async function searchMediaByKeywords(
    carId: number,
    keywords: string[],
    limit: number = 10
): Promise<Media[]> {
    if (keywords.length === 0) return [];

    const result = await pool.query<Media>(
        `SELECT *,
            (
                COALESCE(array_length(ARRAY(SELECT UNNEST(ai_tags) INTERSECT SELECT UNNEST($2::text[])), 1), 0) +
                COALESCE(array_length(ARRAY(SELECT UNNEST(ai_colors) INTERSECT SELECT UNNEST($2::text[])), 1), 0) +
                CASE WHEN ai_material = ANY($2::text[]) THEN 1 ELSE 0 END +
                CASE WHEN ai_style = ANY($2::text[]) THEN 1 ELSE 0 END
            ) AS relevance
         FROM media
         WHERE car_id = $1 
           AND ai_analyzed = TRUE
           AND (
               ai_tags && $2::text[] 
               OR ai_colors && $2::text[]
               OR ai_material = ANY($2::text[])
               OR ai_style = ANY($2::text[])
           )
         ORDER BY 
            CASE WHEN file_type = 'video' THEN 0 ELSE 1 END,
            relevance DESC,
            created_at DESC
         LIMIT $3`,
        [carId, keywords, limit]
    );
    return result.rows;
}

// ============================================================
// SMART SEARCH helper — WHERE shartini qayta ishlatish uchun
// ============================================================
function buildSmartSearchParts(searchData: SmartSearchResult) {
    const { keywords, colorAliases, materialAliases, styleAliases, placementAliases } = searchData;

    const allTerms = [...new Set([
        ...keywords,
        ...colorAliases,
        ...materialAliases,
        ...styleAliases,
        ...placementAliases,
    ])].filter(Boolean);

    const colorTerms = colorAliases.length > 0 ? colorAliases : keywords;
    const materialTerms = materialAliases.length > 0 ? materialAliases : [];

    const likeConditions = allTerms.length > 0
        ? allTerms.map((_, i) => `ai_description ILIKE $${i + 4}`).join(' OR ')
        : 'FALSE';

    const likeParams = allTerms.map(t => `%${t}%`);

    const whereClause = `
        car_id = $${allTerms.length + 4}
        AND ai_analyzed = TRUE
        AND (
            ai_tags && $1::text[]
            OR ai_colors && $2::text[]
            OR ($3::text[] IS NOT NULL AND array_length($3::text[], 1) > 0 AND ai_material = ANY($3::text[]))
            OR ai_style = ANY($1::text[])
            OR (${likeConditions})
        )
    `;

    const baseParams = [allTerms, colorTerms, materialTerms, ...likeParams];

    return { allTerms, colorTerms, materialTerms, likeConditions, likeParams, whereClause, baseParams };
}

// ============================================================
// SMART SEARCH — jami natijalar soni (pagination uchun)
// ============================================================
export async function smartSearchMediaCount(
    carId: number,
    searchData: SmartSearchResult,
): Promise<number> {
    const { allTerms, whereClause, baseParams } = buildSmartSearchParts(searchData);

    if (allTerms.length === 0) return 0;

    const query = `SELECT COUNT(*) FROM media WHERE ${whereClause}`;
    const params = [...baseParams, carId];

    try {
        const result = await pool.query<{ count: string }>(query, params);
        return parseInt(result.rows[0].count);
    } catch (err) {
        console.error('smartSearchMediaCount SQL xatosi:', err);
        return 0;
    }
}

// ============================================================
// SMART SEARCH — sahifalash bilan natijalar
// ============================================================
export async function smartSearchMedia(
    carId: number,
    searchData: SmartSearchResult,
    limit: number = 6,
    offset: number = 0
): Promise<Media[]> {
    const { allTerms, colorTerms, materialTerms, likeConditions, likeParams, whereClause, baseParams } = buildSmartSearchParts(searchData);

    if (allTerms.length === 0) return [];

    const query = `
        SELECT *,
        (
            COALESCE(array_length(
                ARRAY(SELECT UNNEST(ai_colors) INTERSECT SELECT UNNEST($2::text[])), 1
            ), 0) * 3 +
            COALESCE(array_length(
                ARRAY(SELECT UNNEST(ai_tags) INTERSECT SELECT UNNEST($1::text[])), 1
            ), 0) * 2 +
            CASE WHEN $3::text[] IS NOT NULL AND array_length($3::text[], 1) > 0
                 AND ai_material = ANY($3::text[]) THEN 3 ELSE 0 END +
            CASE WHEN ai_style = ANY($1::text[]) THEN 2 ELSE 0 END +
            CASE WHEN ${likeConditions} THEN 1 ELSE 0 END
        ) AS relevance
        FROM media
        WHERE ${whereClause}
        ORDER BY
            CASE WHEN file_type = 'video' THEN 0 ELSE 1 END,
            relevance DESC,
            created_at DESC
        LIMIT $${allTerms.length + 5}
        OFFSET $${allTerms.length + 6}
    `;

    const params = [...baseParams, carId, limit, offset];

    try {
        const result = await pool.query<Media>(query, params);
        return result.rows;
    } catch (err) {
        console.error('smartSearchMedia SQL xatosi:', err);
        return searchMediaByKeywords(carId, allTerms, limit);
    }
}

// ============================================================
// SMART SEARCH ALL — 2-etapli qidiruv uchun LIMIT siz
// Etap 1 da barcha kandidatlarni olish (Gemini tekshirish uchun)
// ============================================================
export async function smartSearchMediaAll(
    carId: number,
    searchData: SmartSearchResult,
): Promise<Media[]> {
    const { allTerms, colorTerms, materialTerms, likeConditions, likeParams, whereClause, baseParams } = buildSmartSearchParts(searchData);

    if (allTerms.length === 0) return [];

    const query = `
        SELECT *,
        (
            COALESCE(array_length(
                ARRAY(SELECT UNNEST(ai_colors) INTERSECT SELECT UNNEST($2::text[])), 1
            ), 0) * 3 +
            COALESCE(array_length(
                ARRAY(SELECT UNNEST(ai_tags) INTERSECT SELECT UNNEST($1::text[])), 1
            ), 0) * 2 +
            CASE WHEN $3::text[] IS NOT NULL AND array_length($3::text[], 1) > 0
                 AND ai_material = ANY($3::text[]) THEN 3 ELSE 0 END +
            CASE WHEN ai_style = ANY($1::text[]) THEN 2 ELSE 0 END +
            CASE WHEN ${likeConditions} THEN 1 ELSE 0 END
        ) AS relevance
        FROM media
        WHERE ${whereClause}
        ORDER BY
            CASE WHEN file_type = 'video' THEN 0 ELSE 1 END,
            relevance DESC,
            created_at DESC
    `;

    const params = [...baseParams, carId];

    try {
        const result = await pool.query<Media>(query, params);
        return result.rows;
    } catch (err) {
        console.error('smartSearchMediaAll SQL xatosi:', err);
        return searchMediaByKeywords(carId, allTerms, 100);
    }
}

// ============================================================
// GET MEDIA BY IDS — tasdiqlangan media id lar bo'yicha olish
// Etap 2 dan keyin verifiedIds bo'yicha sahifalash uchun
// ============================================================
export async function getMediaByIds(ids: number[]): Promise<Media[]> {
    if (ids.length === 0) return [];

    // id lar tartibini saqlab qolish uchun unnest + ordinality ishlatamiz
    const result = await pool.query<Media>(
        `SELECT m.*
         FROM media m
         JOIN (
             SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord
         ) AS ordered ON m.id = ordered.id
         ORDER BY ordered.ord`,
        [ids]
    );
    return result.rows;
}