import { GoogleGenAI } from '@google/genai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

// Recolor uchun alohida API kalit (yangi paket — rasm generate qila oladi)
const GEMINI_RECOLOR_API_KEY =
    process.env.GEMINI_RECOLOR_API_KEY ||
    process.env['GEMINI-RECOLOR-API-KEY'] ||  // eski yozilish ham qo'llab-quvvatlanadi
    process.env.GEMINI_API_KEY;

// Tahlil uchun asosiy kalit (eski paket)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_RECOLOR_API_KEY) {
    throw new Error('❌ GEMINI_RECOLOR_API_KEY yoki GEMINI_API_KEY .env faylda topilmadi!');
}

// Yangi paket — rasm generate qila oladi (gemini-2.5-flash-image)
const recolorAI = new GoogleGenAI({ apiKey: GEMINI_RECOLOR_API_KEY });

// Eski paket — faqat matn (rang aniqlash uchun)
const analyzeGenAI = GEMINI_API_KEY
    ? new GoogleGenerativeAI(GEMINI_API_KEY)
    : new GoogleGenerativeAI(GEMINI_RECOLOR_API_KEY);

export interface RecolorResult {
    imageBuffer: Buffer;
    detectedColor: string;
}

// ============================================================
// === RANG ANIQLASH (matn yoki RGB dan) ===
// Foydalanuvchi: "qizil", "RGB(255,0,0)", "#FF0000", "to'q sariq" va h.k.
// ============================================================
export async function detectColorFromText(colorInput: string): Promise<string> {
    const model = analyzeGenAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const result = await model.generateContent(
        `Foydalanuvchi quyidagi rangni kiritdi: "${colorInput}"

Bu rangni ingliz tilida professional bir-ikki so'z bilan aniqlashtirib ber.
Agar RGB yoki HEX kod bo'lsa, unga mos rang nomini ber.

Faqat rang nomini qaytargin, boshqa narsa yo'q.
Misol: "deep red", "golden yellow", "navy blue", "forest green"

Rang: `
    );

    return result.response.text().trim().toLowerCase().replace(/[\n\r"']/g, '');
}

// ============================================================
// === RASM GENERATE QILISH (Gemini 2.5 Flash Image / Nano Banana) ===
// ============================================================
export async function recolorSeatCover(
    imageBuffer: Buffer,
    colorInput: string
): Promise<RecolorResult> {
    console.log(`  🎨 Rang aniqlanmoqda: "${colorInput}"...`);

    // 1. Rangni aniqlashtirish
    const detectedColor = await detectColorFromText(colorInput);
    console.log(`  ✅ Aniqlangan rang: ${detectedColor}`);

    // 2. Gemini 2.5 Flash Image bilan rasm generate qilish
    console.log(`  🎨 Gemini rasm generate qilmoqda...`);

    const base64Image = imageBuffer.toString('base64');

    const response = await recolorAI.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: [
            {
                role: 'user',
                parts: [
                    {
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: base64Image,
                        },
                    },
                    {
                        text: `Edit this car seat cover image: change the color to ${detectedColor}.
Keep ALL other details exactly the same: fabric texture, stitching pattern, design style, lighting, shadows, and background.
Only change the color of the seat cover to ${detectedColor}, nothing else.
The result must look photorealistic and professional, as if photographed in the same conditions.`,
                    },
                ],
            },
        ],
        config: {
            responseModalities: ['IMAGE' as any, 'TEXT' as any],
        },
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];

    for (const part of parts) {
        const p = part as any;
        if (p?.inlineData?.mimeType?.startsWith('image/') && p?.inlineData?.data) {
            console.log(`  ✅ Rasm muvaffaqiyatli generate qilindi!`);
            return {
                imageBuffer: Buffer.from(p.inlineData.data, 'base64'),
                detectedColor,
            };
        }
    }

    throw new Error('Gemini rasm qaytarmadi. Qaytadan urinib ko\'ring.');
}