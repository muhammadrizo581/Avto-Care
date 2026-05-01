import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import dotenv from 'dotenv';

dotenv.config();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY && !GEMINI_API_KEY) {
    throw new Error('❌ GROQ_API_KEY yoki GEMINI_API_KEY kerak! .env faylni tekshiring.');
}

const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const geminiModel = genAI?.getGenerativeModel({ model: 'gemini-2.0-flash' });

export interface AIAnalysis {
    description: string;
    tags: string[];
    colors: string[];
    material: string;
    style: string;
    placement: string;
}

export interface SmartSearchResult {
    keywords: string[];
    colorAliases: string[];
    materialAliases: string[];
    styleAliases: string[];
    placementAliases: string[];
    correctedQuery: string;
    // Etap 2 uchun: foydalanuvchi so'rovining to'liq ma'nosi
    intentSummary: string;
}

// ============================================================
// RASM TAHLIL PROMPT
// ============================================================
const ANALYZE_PROMPT = `Sen avtomobil chexollari tahlilchisisan.
Rasmga qarab, FAQAT JSON formatida qisqa tahlil yoz:

{
  "description": "1 ta jumla, 10-15 so'z: MATERIAL + RANG + NAQSH/TIKUV + JOYLASHUV. Masalan: Qora ekokharm sport chexol, oq tikuvli va perforatsiyali, to'liq komplekt.",
  "placement": "orindiq_uchun / eshik_uchun / potalok_uchun / to'liq_to'plam / boshqa",
  "tags": ["rang1", "material1", "naqsh1", "stil1", "xususiyat1", "xususiyat2"],
  "colors": ["asosiy_rang", "ikkinchi_rang"],
  "material": "charm / ekokharm / mato / alkantara / velyur / teri / sun'iy_teri",
  "style": "sport / klassik / zamonaviy / lyuks / oddiy"
}

QOIDALAR:
- description 10-15 SO'Z, 1 JUMLA
- "Rasmdagi", "Ko'rinayotgan", "Ushbu" bilan BOSHLANMASIN
- tags 5-6 ta, o'zbekcha

MUHIM: Faqat JSON qaytaring, backtick yoki boshqa matn qo'shmang.`;

// ============================================================
// SMART SEARCH PROMPT — imlo tuzatish + semantik kengaytirish
// ============================================================
const buildSmartSearchPrompt = (query: string): string => `Sen avtomobil chexollari do'konining aqlli qidiruv yordamchisisisan.

Foydalanuvchi qidiruv matni: "${query}"

VAZIFALAR:
1. Imlo xatolarini tuzat (masalan: "qidil"→"qizil", "bardovi"→"lavanda", "ekokorm"→"ekokharm")
2. Foydalanuvchi nimani xohlayotganini qisqacha tushuntirib ber (intentSummary) — bu keyinchalik rasmni tekshirishda ishlatiladi
3. Rang so'zlarini kengaytir — o'xshash va sinonim ranglarni qo'sh:
   - qizil → qizil, to'q qizil, gilos, pushti, shaftoli, qirmizi
   - ko'k → ko'k, moviy, zangori, to'q ko'k, dengiz ko'ki, temir ko'k, goluboy
   - yashil → yashil, zaytun, o'tlar rangi, toza yashil
   - qora → qora, to'q, antrasit
   - oq → oq, krem, kumush, sut rangi
   - jigarrang → jigarrang, qo'ng'ir, kashtanrang, shokolad, mocha, kofe
   - sariq → sariq, limon, oltin, xantal, amber
   - kulrang → kulrang, kumush, temir, antrasit, gri
   - binafsha/lavanda → binafsha, lavanda, mor, bardovi, lilyak
   - pushti → pushti, atirgul, salmon, shaftoli, rozoviy
   - bej/krem → bej, krem, qum, tilla, kapuchino
4. Material sinonimlarini qo'sh
5. Stil va joylashuv sinonimlarini qo'sh

JSON formatida qaytар (FAQAT JSON, boshqa matn yo'q):
{
  "correctedQuery": "tuzatilgan so'rov o'zbek tilida",
  "intentSummary": "foydalanuvchi nimani xohlayotgani ingliz tilida, rasm tekshirish uchun. Masalan: black car seat covers with no other colors mixed in",
  "keywords": ["3-8 ta asosiy kalit so'z"],
  "colorAliases": ["5-15 ta sinonim ranglar"],
  "materialAliases": ["2-6 ta sinonim materiallar"],
  "styleAliases": ["2-6 ta sinonim stillar"],
  "placementAliases": ["1-5 ta sinonim joylashuvlar"]
}`;

// ============================================================
// ETAP 2: RASM MOS KELISH TEKSHIRUVI PROMPT
// ============================================================
const buildVerifyPrompt = (intentSummary: string): string =>
    `You are a car seat cover verification assistant.

User is looking for: "${intentSummary}"

Look at this car seat cover image carefully and answer:
Does this image EXACTLY match what the user is looking for?

Be STRICT. If user wants "only black, no other colors" — reject anything with white stitching, colored patterns, or mixed colors.
If user wants "red sport" — reject black ones, reject non-sport ones.

Reply ONLY with valid JSON, no extra text:
{
  "match": true or false,
  "reason": "one short sentence explaining why it matches or not"
}`;

// ============================================================
// PARSE YORDAMCHILARI
// ============================================================

function parseAIResponse(text: string): AIAnalysis {
    let cleaned = text.trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    let analysis: AIAnalysis;
    try {
        analysis = JSON.parse(cleaned);
    } catch (parseErr) {
        console.error('❌ AI javobi JSON emas:', cleaned.slice(0, 200));
        throw new Error(`JSON parse xatosi: ${(parseErr as Error).message}`);
    }

    if (!analysis.description) analysis.description = 'Avtomobil chexoli';
    if (!Array.isArray(analysis.tags)) analysis.tags = [];
    if (!Array.isArray(analysis.colors)) analysis.colors = [];
    if (!analysis.material) analysis.material = '';
    if (!analysis.style) analysis.style = '';
    if (!analysis.placement) analysis.placement = 'orindiq_uchun';

    if (/^(Rasmdagi|Ko'rinayotgan|Ushbu)/i.test(analysis.description)) {
        analysis.description = analysis.description.replace(/^(Rasmdagi|Ko'rinayotgan|Ushbu)\s+/i, '');
        analysis.description = analysis.description.charAt(0).toUpperCase() + analysis.description.slice(1);
    }

    analysis.tags = analysis.tags.map((t: string) => t.toLowerCase().trim()).filter(Boolean);
    analysis.colors = analysis.colors.map((c: string) => c.toLowerCase().trim()).filter(Boolean);
    analysis.material = analysis.material.toLowerCase().trim();
    analysis.style = analysis.style.toLowerCase().trim();
    analysis.placement = analysis.placement.toLowerCase().trim();

    return analysis;
}

function parseSmartSearchResponse(text: string, originalQuery: string): SmartSearchResult {
    let cleaned = text.trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) cleaned = jsonMatch[0];

    try {
        const result = JSON.parse(cleaned);
        const normalize = (arr: any) =>
            Array.isArray(arr) ? arr.map((k: string) => k.toLowerCase().trim()).filter(Boolean) : [];

        return {
            keywords: normalize(result.keywords),
            colorAliases: normalize(result.colorAliases),
            materialAliases: normalize(result.materialAliases),
            styleAliases: normalize(result.styleAliases),
            placementAliases: normalize(result.placementAliases),
            correctedQuery: result.correctedQuery || originalQuery,
            intentSummary: result.intentSummary || originalQuery,
        };
    } catch (err) {
        console.error('❌ Smart search parse xatosi:', cleaned.slice(0, 200));
        const words = originalQuery.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        return {
            keywords: words,
            colorAliases: [],
            materialAliases: [],
            styleAliases: [],
            placementAliases: [],
            correctedQuery: originalQuery,
            intentSummary: originalQuery,
        };
    }
}

function detectMimeType(imageBuffer: Buffer): string {
    const h = imageBuffer;
    if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) return 'image/png';
    if (h[0] === 0xFF && h[1] === 0xD8) return 'image/jpeg';
    if (h[0] === 0x47 && h[1] === 0x49 && h[2] === 0x46) return 'image/gif';
    if (h[8] === 0x57 && h[9] === 0x45 && h[10] === 0x42 && h[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
}

// ============================================================
// RASM TAHLIL (mavjud, o'zgarishsiz)
// ============================================================

async function analyzeWithGroq(imageBuffer: Buffer): Promise<AIAnalysis> {
    if (!groq) throw new Error('GROQ_NOT_CONFIGURED');

    const base64Image = imageBuffer.toString('base64');
    const mimeType = detectMimeType(imageBuffer);

    const completion = await groq.chat.completions.create({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: ANALYZE_PROMPT },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
            ]
        }],
        temperature: 0.2,
        max_tokens: 1000,
    });

    const text = completion.choices[0]?.message?.content || '';
    if (!text) throw new Error("Groq bo'sh javob qaytardi");
    return parseAIResponse(text);
}

async function analyzeWithGemini(imageBuffer: Buffer): Promise<AIAnalysis> {
    if (!geminiModel) throw new Error('GEMINI_NOT_CONFIGURED');
    const mimeType = detectMimeType(imageBuffer);

    const result = await geminiModel.generateContent([
        ANALYZE_PROMPT,
        { inlineData: { data: imageBuffer.toString('base64'), mimeType: mimeType as any } }
    ]);

    const text = result.response.text();
    if (!text) throw new Error("Gemini bo'sh javob qaytardi");
    return parseAIResponse(text);
}

export async function analyzeImage(imageBuffer: Buffer): Promise<AIAnalysis> {
    if (groq) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const result = await analyzeWithGroq(imageBuffer);
                console.log(`  ✓ Groq (rasm tahlil)`);
                return result;
            } catch (err: any) {
                if (err.status === 429 || err.message?.includes('rate limit')) {
                    console.log("  ⚠️ Groq kvota → Gemini");
                    break;
                }
                if ((err.status === 503 || err.status === 500) && attempt < 2) {
                    await new Promise(r => setTimeout(r, 3000));
                    continue;
                }
                console.log(`  ⚠️ Groq xato → Gemini`);
                break;
            }
        }
    }

    if (geminiModel) {
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const result = await analyzeWithGemini(imageBuffer);
                console.log(`  ✓ Gemini (rasm tahlil, zaxira)`);
                return result;
            } catch (err: any) {
                if (err.status === 429) break;
                if ((err.status === 503 || err.status === 500 || err.message?.includes('timed out')) && attempt < 3) {
                    await new Promise(r => setTimeout(r, 5000));
                    continue;
                }
                break;
            }
        }
    }

    throw new Error('Rasmni tahlil qilishda xatolik: Groq va Gemini ham ishlamadi');
}

// ============================================================
// SMART SEARCH — imlo tuzatish + semantik kengaytirish
// ============================================================

async function smartSearchWithGroq(query: string): Promise<SmartSearchResult> {
    if (!groq) throw new Error('GROQ_NOT_CONFIGURED');

    const completion = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: buildSmartSearchPrompt(query) }],
        temperature: 0.3,
        max_tokens: 600,
    });

    const text = completion.choices[0]?.message?.content?.trim() || '';
    if (!text) throw new Error("Groq bo'sh javob");
    return parseSmartSearchResponse(text, query);
}

async function smartSearchWithGemini(query: string): Promise<SmartSearchResult> {
    if (!geminiModel) throw new Error('GEMINI_NOT_CONFIGURED');

    const result = await geminiModel.generateContent(buildSmartSearchPrompt(query));
    const text = result.response.text().trim();
    if (!text) throw new Error("Gemini bo'sh javob");
    return parseSmartSearchResponse(text, query);
}

export async function parseUserQuerySmart(query: string): Promise<SmartSearchResult> {
    if (groq) {
        try {
            const result = await smartSearchWithGroq(query);
            console.log(`🔍 Smart search (Groq): "${query}" → "${result.correctedQuery}"`);
            console.log(`   Intent: ${result.intentSummary}`);
            console.log(`   Ranglar (${result.colorAliases.length}): ${result.colorAliases.slice(0, 6).join(', ')}`);
            console.log(`   Material: ${result.materialAliases.join(', ')}`);
            return result;
        } catch (err: any) {
            console.error('Smart search Groq xato:', err.message);
        }
    }

    if (geminiModel) {
        try {
            const result = await smartSearchWithGemini(query);
            console.log(`🔍 Smart search (Gemini): "${query}" → "${result.correctedQuery}"`);
            return result;
        } catch (err: any) {
            console.error('Smart search Gemini xato:', err.message);
        }
    }

    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1);
    return {
        keywords: words,
        colorAliases: [],
        materialAliases: [],
        styleAliases: [],
        placementAliases: [],
        correctedQuery: query,
        intentSummary: query,
    };
}

// ============================================================
// ETAP 2: BITTA RASMNI SO'ROVGA MOS KELISHINI TEKSHIRISH
// Gemini orqali — rasm ko'ra oladi, bepul tier bor, tez
// ============================================================

export interface VerifyResult {
    match: boolean;
    reason: string;
}

/**
 * Bitta rasmni (base64 buffer) foydalanuvchi so'roviga mos kelishini tekshiradi.
 * Faqat Gemini ishlatiladi — vision uchun eng ishonchli.
 */
async function verifyImageWithGemini(
    imageBuffer: Buffer,
    intentSummary: string
): Promise<VerifyResult> {
    if (!geminiModel) throw new Error('GEMINI_NOT_CONFIGURED');

    const mimeType = detectMimeType(imageBuffer);
    const prompt = buildVerifyPrompt(intentSummary);

    const result = await geminiModel.generateContent([
        prompt,
        { inlineData: { data: imageBuffer.toString('base64'), mimeType: mimeType as any } }
    ]);

    const text = result.response.text().trim()
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Verify: JSON topilmadi');

    const parsed = JSON.parse(jsonMatch[0]);
    return {
        match: Boolean(parsed.match),
        reason: parsed.reason || '',
    };
}

/**
 * Bir nechta rasmlarni parallel tekshiradi.
 * Har bir media: { id, file_id, file_type, fileBuffer }
 * Qaytaradi: mos kelgan media id lar ro'yxati
 *
 * MUHIM: Gemini bepul tierida minutiga 15 req bor.
 * Shuning uchun parallel emas, ketma-ket (300ms oraliq) tekshiramiz.
 */
export async function verifyMediaBatch(
    mediaList: Array<{ id: number; file_type: string; fileBuffer: Buffer }>,
    intentSummary: string
): Promise<number[]> {
    if (!geminiModel) {
        // Gemini yo'q bo'lsa — hammasini o'tkazib yuboramiz (filter qilmaymiz)
        console.warn('⚠️ Gemini yo\'q — 2-etap o\'tkazib yuborildi, hammasi qaytariladi');
        return mediaList.map(m => m.id);
    }

    const matchedIds: number[] = [];

    for (const media of mediaList) {
        // Video bo'lsa tekshirmaymiz — o'tkazib yuboramiz
        if (media.file_type !== 'photo') {
            matchedIds.push(media.id);
            continue;
        }

        try {
            const result = await verifyImageWithGemini(media.fileBuffer, intentSummary);
            console.log(`  🔍 Verify id=${media.id}: ${result.match ? '✅' : '❌'} — ${result.reason}`);
            if (result.match) {
                matchedIds.push(media.id);
            }
            // Rate limit uchun kichik kutish
            await new Promise(r => setTimeout(r, 300));
        } catch (err: any) {
            console.error(`  ❌ Verify xato id=${media.id}:`, err.message);
            // Xato bo'lsa — rasmni o'tkazib yuboramiz (shubhali rasmni ko'rsatmaymiz)
            // Agar siz xohlasangiz matchedIds.push(media.id) — xato bo'lganda ham ko'rsatish
        }
    }

    return matchedIds;
}

// Backward compatibility
export async function parseUserQuery(query: string): Promise<string[]> {
    const result = await parseUserQuerySmart(query);
    return [...new Set([
        ...result.keywords,
        ...result.colorAliases,
        ...result.materialAliases,
        ...result.styleAliases,
    ])];
}