import { Telegraf, Markup, Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { InputMediaPhoto, InputMediaVideo } from 'telegraf/types';
import dotenv from 'dotenv';
import axios from 'axios';

import * as queries from './db/queries';
import * as keyboards from './keyboards/inline';
import { isAdmin, adminOnly } from './middlewares/auth';
import { AdminState } from './types';
import { analyzeImage, parseUserQuery } from './ai/analyzer';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    throw new Error('❌ BOT_TOKEN .env faylda topilmadi!');
}

const bot = new Telegraf(BOT_TOKEN);

const adminState = new Map<number, AdminState>();
const userMessages = new Map<number, number[]>();
const aiSearchState = new Map<number, number>(); // userId -> carId

let isAnalyzing = false;

const ITEMS_PER_PAGE = 6;

// === /start ===
bot.start(async (ctx) => {
    const adminText = isAdmin(ctx.from.id)
        ? '\n\n👑 Siz adminsiz. /admin - admin panel'
        : '';

    await ctx.reply(
        `Salom, ${ctx.from.first_name}! 👋\n\n` +
        `Men moshina chexollari botiman. 🚗\n` +
        `Moshinangizni tanlang va mos chexollar rasmlarini ko'ring.${adminText}`,
        Markup.keyboard([['🚗 Moshinalar']]).resize()
    );
});

// === Moshinalar ro'yxati ===
async function showCars(ctx: Context): Promise<void> {
    try {
        await deleteOldMessages(ctx);
        if (ctx.from) aiSearchState.delete(ctx.from.id);

        const cars = await queries.getAllCars();

        if (cars.length === 0) {
            await ctx.reply('Hozircha moshinalar qo\'shilmagan.');
            return;
        }

        await ctx.reply('🚗 Moshinangizni tanlang:', keyboards.carsKeyboard(cars));
    } catch (err) {
        console.error('showCars error:', err);
    }
}

bot.hears('🚗 Moshinalar', showCars);
bot.command('cars', showCars);

bot.action(/^car:(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {}); // ← moshinalar ro'yxatini o'chiradi
    await showMediaPage(ctx, carId, 0);
});

bot.action(/^page:(\d+):(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    await showMediaPage(ctx, carId, page);
});

// === Media sahifasi ===
async function showMediaPage(ctx: Context, carId: number, page: number): Promise<void> {
    try {
        const car = await queries.getCarById(carId);
        if (!car) { await ctx.reply('❌ Moshina topilmadi.'); return; }

        const totalCount = await queries.getMediaCount(carId);
        if (totalCount === 0) { await ctx.reply(`📷 ${car.name} uchun rasmlar yo'q.`); return; }

        const totalPages = Math.ceil(totalCount / ITEMS_PER_PAGE);
        const offset = page * ITEMS_PER_PAGE;
        const mediaList = await queries.getMediaByCarId(carId, ITEMS_PER_PAGE, offset);

        await deleteOldMessages(ctx);

        const headerMsg = await ctx.reply(
            `🚗 ${car.name}\n📊 Jami: ${totalCount} ta\n📄 Sahifa: ${page + 1}/${totalPages}`
        );

        const mediaGroup: (InputMediaPhoto | InputMediaVideo)[] = mediaList.map((item: any, index: number) => ({
            type: item.file_type,
            media: item.file_id,
            caption: index === 0 && item.caption ? item.caption : undefined,
        }));

        const mediaMessages = await ctx.replyWithMediaGroup(mediaGroup);

        const navMsg = await ctx.reply('👇 Boshqaruv:', keyboards.paginationKeyboard(carId, page, totalPages));

        const userId = ctx.from!.id;
        userMessages.set(userId, [
            headerMsg.message_id,
            ...mediaMessages.map(m => m.message_id),
            navMsg.message_id
        ]);
    } catch (err) {
        console.error('showMediaPage error:', err);
    }
}

// === Xabarlarni o'chirish ===
async function deleteOldMessages(ctx: Context): Promise<void> {
    if (!ctx.from || !ctx.chat) return;
    const oldIds = userMessages.get(ctx.from.id);
    if (!oldIds?.length) return;

    await Promise.all(oldIds.map(id => ctx.telegram.deleteMessage(ctx.chat!.id, id).catch(() => {})));
    userMessages.delete(ctx.from.id);
}

bot.action('back_to_cars', async (ctx) => { await ctx.answerCbQuery(); await showCars(ctx); });
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });

// === AI QIDIRUV ===

bot.action(/^ai_search:(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    aiSearchState.set(ctx.from!.id, carId);

    await ctx.answerCbQuery();
    await ctx.reply(
        '🔍 Tasvirlab qidirish (AI)\n\n' +
        'Qanday chexol qidiryapsiz? Erkin yozing:\n\n' +
        '💡 Misollar:\n' +
        '• qizil charm sport\n' +
        '• qora oddiy\n' +
        '• ko\'k ekokharm\n' +
        '• jigarrang lyuks\n\n' +
        'Bekor qilish: /cancel'
    );
});

bot.action(/^ai_page:(\d+):(\d+)$/, async (ctx) => {
    const carId = parseInt(ctx.match[1]);
    const page = parseInt(ctx.match[2]);
    await ctx.answerCbQuery();
    // AI qidiruv natijalarini pagination qilish uchun
    // session dan cached natijalarni olamiz
    const session = aiResultCache.get(ctx.from!.id);
    if (!session || session.carId !== carId) {
        await ctx.reply('❌ Sessiya tugagan. Qaytadan qidiring.');
        return;
    }
    await showAiPage(ctx, session.results, carId, page);
});

bot.command('cancel', async (ctx) => {
    aiSearchState.delete(ctx.from.id);
    await ctx.reply('❌ Qidiruv bekor qilindi.');
});

// AI qidiruv natijalari cache (pagination uchun)
const aiResultCache = new Map<number, { carId: number; results: number[] }>();

// AI natijalarni sahifalab ko'rsatish
async function showAiPage(ctx: Context, resultIds: number[], carId: number, page: number): Promise<void> {
    const totalPages = Math.ceil(resultIds.length / ITEMS_PER_PAGE);
    const pageIds = resultIds.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

    await deleteOldMessages(ctx);

    const car = await queries.getCarById(carId);
    const newMessageIds: number[] = [];

    const headerMsg = await ctx.reply(
        `🎯 AI Qidiruv natijalari\n` +
        `🚗 ${car?.name}\n` +
        `📊 Topildi: ${resultIds.length} ta | Sahifa: ${page + 1}/${totalPages}`
    );
    newMessageIds.push(headerMsg.message_id);

    const mediaList = await queries.getMediaByIds(pageIds);

    if (mediaList.length > 0) {
        const mediaGroup: (InputMediaPhoto | InputMediaVideo)[] = mediaList.map((item: any, index: number) => ({
            type: item.file_type,
            media: item.file_id,
            caption: index === 0 && item.ai_description ? `💬 ${item.ai_description}` : undefined,
        }));

        const mediaMessages = await ctx.replyWithMediaGroup(mediaGroup);
        mediaMessages.forEach(m => newMessageIds.push(m.message_id));
    }

    const navMsg = await ctx.reply(
        '👇 Boshqaruv:',
        keyboards.aiPaginationKeyboard(carId, page, totalPages)
    );
    newMessageIds.push(navMsg.message_id);

    userMessages.set(ctx.from!.id, newMessageIds);
}

// ============================================================
// === ADMIN ===
// ============================================================

bot.command('admin', adminOnly, async (ctx) => {
    await ctx.reply(
        '👑 Admin panel\n\n' +
        '📋 Asosiy:\n' +
        '/addcar - Yangi moshina qo\'shish\n' +
        '/addmedia - Rasm/video qo\'shish\n' +
        '/listcars - Moshinalar ro\'yxati\n' +
        '/deletecar - Moshina o\'chirish\n\n' +
        '🤖 AI:\n' +
        '/analyze - AI tahlil paneli\n' +
        '/aistats - AI statistikasi\n' +
        '/stop_analyze - Tahlilni to\'xtatish'
    );
});

bot.command('addcar', adminOnly, async (ctx) => {
    const carName = ctx.message.text.replace('/addcar', '').trim();
    if (!carName) { await ctx.reply('Misol: /addcar Cobalt'); return; }

    try {
        const car = await queries.createCar(carName);
        await ctx.reply(`✅ Moshina qo'shildi: ${car.name}`);
    } catch (err: any) {
        if (err.code === '23505') await ctx.reply('❌ Bu moshina allaqachon mavjud.');
        else { console.error('addcar error:', err); await ctx.reply('❌ Xatolik.'); }
    }
});

bot.command('addmedia', adminOnly, async (ctx) => {
    const cars = await queries.getAllCars();
    if (cars.length === 0) { await ctx.reply('Avval moshina qo\'shing: /addcar'); return; }
    await ctx.reply('📸 Qaysi moshinaga rasm/video qo\'shasiz?', keyboards.adminCarsKeyboard(cars));
});

bot.action(/^admin_add:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true }); return; }

    const carId = parseInt(ctx.match[1]);
    const car = await queries.getCarById(carId);
    if (!car) { await ctx.answerCbQuery('❌ Moshina topilmadi'); return; }

    adminState.set(ctx.from.id, { mode: 'add_media', carId });
    await ctx.answerCbQuery();
    await ctx.reply(`📸 ${car.name} uchun rasm yoki video yuboring.\nTugatganda /done yozing.`);
});

bot.action('admin_cancel', async (ctx) => {
    if (ctx.from) adminState.delete(ctx.from.id);
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage();
});

bot.command('done', adminOnly, async (ctx) => {
    if (adminState.get(ctx.from.id)) { adminState.delete(ctx.from.id); await ctx.reply('✅ Yakunlandi.'); }
    else await ctx.reply('Hech qanday faol jarayon yo\'q.');
});

bot.on(message('photo'), async (ctx) => {
    const state = adminState.get(ctx.from.id);
    if (!state || state.mode !== 'add_media') return;
    try {
        const largest = ctx.message.photo[ctx.message.photo.length - 1];
        await queries.addMedia(state.carId, largest.file_id, 'photo', ctx.message.caption || null);
        await ctx.reply('✅ Rasm qo\'shildi. Yana yuboring yoki /done');
    } catch (err) { console.error('photo error:', err); await ctx.reply('❌ Saqlashda xatolik.'); }
});

bot.on(message('video'), async (ctx) => {
    const state = adminState.get(ctx.from.id);
    if (!state || state.mode !== 'add_media') return;
    try {
        await queries.addMedia(state.carId, ctx.message.video.file_id, 'video', ctx.message.caption || null);
        await ctx.reply('✅ Video qo\'shildi. Yana yuboring yoki /done');
    } catch (err) { console.error('video error:', err); await ctx.reply('❌ Saqlashda xatolik.'); }
});

bot.command('listcars', adminOnly, async (ctx) => {
    const cars = await queries.getAllCars();
    if (cars.length === 0) { await ctx.reply('Moshinalar yo\'q.'); return; }

    let text = '📋 Moshinalar ro\'yxati:\n\n';
    for (const car of cars) {
        const count = await queries.getMediaCount(car.id);
        text += `🚗 ${car.name} (ID: ${car.id}) — ${count} ta media\n`;
    }
    await ctx.reply(text);
});

// ============================================================
// === AI ADMIN PANEL ===
// ============================================================

bot.command('analyze', adminOnly, async (ctx) => {
    const stats = await queries.getAIStats();
    await ctx.reply(
        `🤖 AI Tahlil Paneli\n\n` +
        `📊 Jami media: ${stats.total} ta\n` +
        `✅ Tahlil qilingan: ${stats.analyzed} ta\n` +
        `⏳ Tahlil qilinmagan: ${stats.pending} ta\n\n` +
        `Quyidagi amallardan birini tanlang:`,
        keyboards.aiAdminKeyboard(stats.pending, stats.analyzed)
    );
});

bot.command('aistats', adminOnly, async (ctx) => {
    const stats = await queries.getAIStats();
    await ctx.reply(
        `🤖 AI Statistika\n\n📊 Jami: ${stats.total}\n✅ Tahlil qilingan: ${stats.analyzed}\n⏳ Tahlilga kerak: ${stats.pending}\n\n` +
        (stats.pending > 0 ? `Tahlil: /analyze` : `Hammasi tayyor! 🎉`),
        keyboards.aiAdminKeyboard(stats.pending, stats.analyzed)
    );
});

bot.command('stop_analyze', adminOnly, async (ctx) => {
    if (!isAnalyzing) { await ctx.reply('Hozir tahlil ishlamayapti.'); return; }
    isAnalyzing = false;
    await ctx.reply('⏹ To\'xtatildi.');
});

bot.action('ai_analyze', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true }); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    await runAnalyze(ctx, false);
});

bot.action('ai_force_confirm', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true }); return; }
    const stats = await queries.getAIStats();
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `⚠️ Diqqat!\n\n${stats.total} ta media qaytadan tahlil qilinadi.\nEski tahlillar o'chiriladi.\n\nDavom etamizmi?`,
        keyboards.forceConfirmKeyboard()
    );
});

bot.action('ai_force_yes', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true }); return; }
    await ctx.answerCbQuery();
    await ctx.deleteMessage().catch(() => {});
    const resetCount = await queries.resetAllAIAnalysis();
    await ctx.reply(`🔄 ${resetCount} ta media qaytadan tahlilga qo'yildi.`);
    await runAnalyze(ctx, true);
});

bot.action('ai_force_no', async (ctx) => { await ctx.answerCbQuery('Bekor qilindi'); await ctx.deleteMessage().catch(() => {}); });

bot.action('ai_stats', async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) { await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true }); return; }
    const stats = await queries.getAIStats();
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `🤖 AI Statistika\n\n📊 Jami: ${stats.total} ta\n✅ Tahlil qilingan: ${stats.analyzed} ta\n⏳ Qolgan: ${stats.pending} ta\n\nFoiz: ${stats.total > 0 ? Math.round(stats.analyzed / stats.total * 100) : 0}%`,
        keyboards.aiAdminKeyboard(stats.pending, stats.analyzed)
    );
});

// ============================================================
// === AI TAHLIL JARAYONI (rasm yuklab AI ga yuborish) ===
// ============================================================

async function runAnalyze(ctx: Context, isForce: boolean): Promise<void> {
    if (isAnalyzing) { await ctx.reply('⚠️ Tahlil hozir ishlamoqda. /stop_analyze yoki kuting.'); return; }

    const stats = await queries.getAIStats();
    if (stats.pending === 0) { await ctx.reply(`✅ Hamma media tahlil qilingan!\n\n📊 Jami: ${stats.total} ta`); return; }

    const estimatedMinutes = Math.ceil(stats.pending * 6 / 60);
    await ctx.reply(
        `🤖 ${isForce ? 'Hammasi qaytadan' : 'Tahlil'} boshlanyapti\n\n` +
        `⏳ Tahlilga: ${stats.pending} ta\n⏱ Taxminan: ~${estimatedMinutes} daqiqa\n\nTo'xtatish: /stop_analyze`
    );

    isAnalyzing = true;
    let processed = 0, failed = 0, skipped = 0;
    const startTime = Date.now();
    const allPending = await queries.getUnanalyzedMedia(10000);
    console.log(`📋 Tahlil: ${allPending.length} ta`);

    for (const media of allPending) {
        if (!isAnalyzing) { console.log('⏹ To\'xtatildi'); break; }

        try {
            // Video uchun rasm yuklab olmasdan saqlaymiz
            if (media.file_type !== 'photo') {
                await queries.updateMediaAI(media.id, {
                    description: 'Video material',
                    tags: ['video'],
                    colors: [],
                    material: '',
                    style: '',
                    placement: 'orindiq_uchun'
                });
                skipped++;
                continue;
            }

            // Rasmni Telegram'dan yuklab olamiz
            const fileLink = await ctx.telegram.getFileLink(media.file_id);
            const response = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 30000 });
            const imageBuffer = Buffer.from(response.data);

            // AI ga yuboramiz (tahlil qiladi)
            const analysis = await analyzeImage(imageBuffer);
            await queries.updateMediaAI(media.id, analysis);

            processed++;
            console.log(`✅ Media ${media.id} (${processed}/${allPending.length}): ${analysis.description.substring(0, 60)}...`);

            if (processed % 5 === 0) {
                await ctx.reply(`⏳ Jarayon: ${processed}/${allPending.length}` + (failed > 0 ? `, ${failed} ta xato` : '')).catch(() => {});
            }

            await new Promise(r => setTimeout(r, 2000)); // 2s kutish (Groq tez)
        } catch (err: any) {
            console.error(`❌ Media ${media.id}:`, err.message || err);
            failed++;
        }
    }

    isAnalyzing = false;
    const duration = Math.round((Date.now() - startTime) / 1000);
    const finalStats = await queries.getAIStats();

    await ctx.reply(
        `✅ Tahlil yakunlandi!\n\n` +
        `🤖 Yangi tahlil: ${processed} ta\n` +
        (skipped > 0 ? `⏭ Video o'tkazildi: ${skipped} ta\n` : '') +
        (failed > 0 ? `❌ Xatoliklar: ${failed} ta\n` : '') +
        `⏱ Vaqt: ${duration}s\n\n` +
        `📊 Tahlil qilingan: ${finalStats.analyzed}/${finalStats.total} ta\n` +
        (failed > 0 ? `\n💡 Xato bo'lganlar uchun /analyze ni qayta ishlating` : `\n🎉 Hammasi tayyor!`)
    );
}

// ============================================================
// === MATN HANDLER — SODDA AI QIDIRUV ===
// Rasmlarni yuklamaydi! Faqat bazadagi description/tags taqqoslanadi
// ============================================================

// === MOSHINA O'CHIRISH ===

bot.command('deletecar', adminOnly, async (ctx) => {
    try {
        const cars = await queries.getAllCars();
        if (cars.length === 0) {
            await ctx.reply('Moshinalar yo\'q.');
            return;
        }

        await ctx.reply(
            '🗑️ Qaysi moshinani o\'chirmoqchisiz?\n\n⚠️ Moshina va uning barcha rasmlari o\'chadi!',
            keyboards.deleteCarsKeyboard(cars)
        );
    } catch (err) {
        console.error('deletecar error:', err);
        await ctx.reply('❌ Xatolik yuz berdi.');
    }
});

// Moshina tanlandi - tasdiqlash so'rash
bot.action(/^delete_car_confirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }

    const carId = parseInt(ctx.match[1]);
    const car = await queries.getCarById(carId);

    if (!car) {
        await ctx.answerCbQuery('❌ Moshina topilmadi');
        return;
    }

    const mediaCount = await queries.getMediaCount(carId);

    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `⚠️ Tasdiqlang!\n\n` +
        `🚗 Moshina: ${car.name}\n` +
        `📷 Rasmlar: ${mediaCount} ta\n\n` +
        `Barchasi o'chiriladi. Davom etamizmi?`,
        keyboards.deleteCarConfirmKeyboard(carId)
    );
});

// Ha - o'chirish
bot.action(/^delete_car_yes:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ Ruxsat yo\'q', { show_alert: true });
        return;
    }

    const carId = parseInt(ctx.match[1]);

    try {
        const car = await queries.getCarById(carId);
        const mediaCount = await queries.getMediaCount(carId);

        await queries.deleteCar(carId);

        await ctx.answerCbQuery('✅ O\'chirildi!');
        await ctx.editMessageText(
            `✅ O'chirildi!\n\n` +
            `🚗 ${car?.name}\n` +
            `📷 ${mediaCount} ta rasm ham o'chirildi.`
        );
    } catch (err) {
        console.error('delete_car_yes error:', err);
        await ctx.answerCbQuery('❌ Xato', { show_alert: true });
    }
});

// Yo'q - bekor qilish
bot.action('delete_car_no', async (ctx) => {
    await ctx.answerCbQuery('Bekor qilindi');
    await ctx.deleteMessage().catch(() => {});
});


bot.on(message('text'), async (ctx) => {
    const userId = ctx.from.id;
    const carId = aiSearchState.get(userId);

    if (!carId) return;
    if (ctx.message.text.startsWith('/')) return;
    if (ctx.message.text === '🚗 Moshinalar') return;

    const query = ctx.message.text.trim();
    aiSearchState.delete(userId);

    try {
        const loadingMsg = await ctx.reply('🤖 AI so\'rovni tahlil qilmoqda...');

        // 1. AI so'rovni kalit so'zlarga aylantiradi (bitta kichik API chaqiruv)
        const keywords = await parseUserQuery(query);
        console.log('🔍 Kalit so\'zlar:', keywords);

        // 2. Bazadan description va tags bo'yicha qidiramiz (AI limit sarflanmaydi!)
        const results = await queries.searchMediaByKeywords(carId, keywords, 100);

        await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});

        if (results.length === 0) {
            await ctx.reply(
                `😔 Mos chexol topilmadi.\n\n` +
                `🔍 Qidirildi: ${keywords.join(', ')}\n\n` +
                `💡 Maslahat:\n` +
                `• Boshqa rang yoki material yozing\n` +
                `• Qisqaroq so'rov yuboring`,
                keyboards.aiSearchResultKeyboard(carId)
            );
            return;
        }

        // 3. Natijalarni cache ga saqlaymiz (pagination uchun)
        const resultIds = results.map(r => r.id);
        aiResultCache.set(userId, { carId, results: resultIds });

        // 4. Birinchi sahifani ko'rsatamiz
        await showAiPage(ctx, resultIds, carId, 0);

    } catch (err) {
        console.error('AI search error:', err);
        await ctx.reply('❌ Qidirishda xatolik yuz berdi.');
    }
});

// === Error handler ===
bot.catch((err, ctx) => { console.error('Bot xatosi:', err); });

// === Launch ===
bot.launch().then(() => { console.log('🤖 Bot ishga tushdi!'); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
